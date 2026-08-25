import 'server-only';

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { SCHEMA_SQL } from './schema';

/**
 * Connection string resolution.
 *
 * Vercel's Postgres and Neon integrations do not agree on a variable name, and
 * which ones you get depends on how the database was attached. Reading only
 * DATABASE_URL means a correctly-connected Neon database reports as "not
 * configured", which is a confusing way to fail. We accept every name those
 * integrations actually set, pooled endpoints first.
 */
const CONNECTION_ENV_VARS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NO_SSL',
  'NEON_DATABASE_URL',
  'NEON_POSTGRES_URL',
] as const;

/**
 * Look up a canonical variable name, allowing for a prefix.
 *
 * Vercel's storage integrations offer an "environment variables prefix" when you
 * attach a database, and Neon's flow sets one by default — the result is
 * `database_DATABASE_URL` rather than `DATABASE_URL`. An exact-name lookup finds
 * nothing, and the database looks unattached while sitting right there in the
 * dashboard. So: exact match first, then any variable whose name ends with
 * `_<canonical>`, compared case-insensitively because the prefix is lowercase
 * while the rest is not.
 *
 * Matching on a suffix rather than a substring keeps the distinctions that
 * matter: `database_DATABASE_URL_UNPOOLED` does not end with `DATABASE_URL`, so
 * the pooled and direct endpoints stay separate.
 */
function lookupEnv(canonical: string): { value: string; source: string } | null {
  const exact = process.env[canonical];
  if (exact && exact.trim() !== '') return { value: exact.trim(), source: canonical };

  const suffix = `_${canonical}`.toLowerCase();
  const match = Object.keys(process.env)
    .filter((key) => key.toLowerCase().endsWith(suffix))
    .filter((key) => (process.env[key] ?? '').trim() !== '')
    // Deterministic when an integration sets more than one prefix.
    .sort()[0];

  if (!match) return null;
  return { value: (process.env[match] as string).trim(), source: match };
}

/**
 * Neon and Vercel Postgres also export the connection as discrete parts, and
 * some setups end up with those and no URL at all. Assembling one from the parts
 * is the difference between "no database attached" and a working app, so it is
 * worth the twenty lines.
 */
function connectionFromParts(): { url: string; source: string } | null {
  const host = lookupEnv('PGHOST') ?? lookupEnv('POSTGRES_HOST');
  const user = lookupEnv('PGUSER') ?? lookupEnv('POSTGRES_USER');
  const password = lookupEnv('PGPASSWORD') ?? lookupEnv('POSTGRES_PASSWORD');
  const database = lookupEnv('PGDATABASE') ?? lookupEnv('POSTGRES_DATABASE');
  if (!host || !user || !database) return null;

  const port = lookupEnv('PGPORT')?.value ?? '5432';
  const auth = password
    ? `${encodeURIComponent(user.value)}:${encodeURIComponent(password.value)}`
    : encodeURIComponent(user.value);
  // These parts carry no sslmode of their own. Default to require, because the
  // hosted providers that set them all mandate TLS, but honour PGSSLMODE so a
  // local server without TLS is still reachable.
  const sslmode = lookupEnv('PGSSLMODE')?.value ?? 'require';
  return {
    url: `postgres://${auth}@${host.value}:${port}/${encodeURIComponent(database.value)}?sslmode=${encodeURIComponent(sslmode)}`,
    source: `${host.source}/${user.source}/${database.source}`,
  };
}

export function resolveConnection(): { url: string; source: string } | null {
  for (const name of CONNECTION_ENV_VARS) {
    const found = lookupEnv(name);
    if (found) return { url: found.value, source: found.source };
  }
  return connectionFromParts();
}

/**
 * Names — never values — of environment variables that look database-related.
 *
 * When nothing resolves, the only useful question is "what does the runtime
 * actually have?". Printing the names answers it immediately: an unrecognised
 * name means the resolver needs widening, and an empty list means the variable
 * never reached this deployment at all, which is a completely different fix.
 *
 * This deliberately matches anywhere in the name and ignores case. An earlier
 * version anchored to the start and was case-sensitive, so it reported an empty
 * list for a deployment whose variables were all prefixed — the diagnostic
 * confidently pointed away from the actual problem, which is worse than having
 * no diagnostic at all.
 */
export function databaseEnvVarNames(): string[] {
  return Object.keys(process.env)
    .filter((name) => /(database|postgres|neon|pghost|pguser|pgpassword|pgport|pgsslmode)/i.test(name))
    .filter((name) => (process.env[name] ?? '').trim() !== '')
    .sort();
}

/**
 * A single lazily-created pool per process. Serverless instances are short-lived
 * and each gets its own pool, so max is deliberately small — the connection
 * ceiling is a property of the Postgres instance, not of any one lambda.
 */
let pool: Pool | null = null;

export function db(): Pool {
  if (pool) return pool;
  const connection = resolveConnection();
  if (!connection) {
    throw new Error(
      `No Postgres connection string found. Set one of: ${CONNECTION_ENV_VARS.join(', ')}.`,
    );
  }
  pool = new Pool({
    connectionString: connection.url,
    max: Number(process.env.PGPOOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: connection.url.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
  });
  return pool;
}

export function isDatabaseConfigured(): boolean {
  return resolveConnection() !== null;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db().query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Tables the app cannot run without. Used to tell "empty" from "migrated". */
const REQUIRED_TABLES = [
  'leagues', 'managers', 'rosters', 'matchups',
  'odds_snapshots', 'stat_packets', 'storylines', 'awards', 'reports',
];

export type DatabaseStatus = {
  configured: boolean;
  /** Which environment variable supplied the connection string. */
  source: string | null;
  reachable: boolean;
  migrated: boolean;
  missingTables: string[];
  error: string | null;
  /** Names of database-shaped variables present in the runtime. Never values. */
  seenEnvVars: string[];
};

/**
 * The diagnostic behind the setup banner and /api/health.
 *
 * "Configured but not migrated" is the state a freshly-attached Neon database is
 * in, and it is worth naming precisely: connecting the database and creating the
 * schema are two steps, and nothing about the first hints that the second is
 * still outstanding.
 */
export async function databaseStatus(): Promise<DatabaseStatus> {
  const connection = resolveConnection();
  if (!connection) {
    return {
      configured: false, source: null, reachable: false,
      migrated: false, missingTables: REQUIRED_TABLES, error: null,
      seenEnvVars: databaseEnvVarNames(),
    };
  }

  try {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [REQUIRED_TABLES],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));

    return {
      configured: true,
      source: connection.source,
      reachable: true,
      migrated: missing.length === 0,
      missingTables: missing,
      error: null,
      seenEnvVars: databaseEnvVarNames(),
    };
  } catch (error) {
    return {
      configured: true,
      source: connection.source,
      reachable: false,
      migrated: false,
      missingTables: REQUIRED_TABLES,
      error: error instanceof Error ? error.message : 'Could not reach the database.',
      seenEnvVars: databaseEnvVarNames(),
    };
  }
}

/**
 * Apply the schema. Idempotent, and safe to run against a populated database.
 * Exposed as a route as well as a script because a deployed app has no shell to
 * run the script from.
 */
export async function applySchema(): Promise<{ applied: true }> {
  await transaction(async (client) => {
    await client.query(SCHEMA_SQL);
  });
  return { applied: true };
}
