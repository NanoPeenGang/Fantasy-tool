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
] as const;

export function resolveConnection(): { url: string; source: string } | null {
  for (const name of CONNECTION_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim() !== '') return { url: value.trim(), source: name };
  }
  return null;
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
    };
  } catch (error) {
    return {
      configured: true,
      source: connection.source,
      reachable: false,
      migrated: false,
      missingTables: REQUIRED_TABLES,
      error: error instanceof Error ? error.message : 'Could not reach the database.',
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
