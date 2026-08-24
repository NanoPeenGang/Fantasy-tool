/**
 * Applies lib/db/schema.sql in one transaction. Every statement in that file is
 * idempotent, so this is safe to re-run against an existing database.
 *
 *   npm run db:migrate
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, '..', 'lib', 'db', 'schema.sql'), 'utf8');

  const client = new Client({
    connectionString,
    ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Schema applied.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
