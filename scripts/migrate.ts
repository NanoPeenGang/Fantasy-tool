/**
 * Apply the schema from a shell. The same operation is available in a deployed
 * environment at POST /api/admin/migrate, which is what you want once the
 * database lives in Vercel or Neon rather than on your laptop.
 *
 *   npm run db:migrate
 */
import { Client } from 'pg';
import { SCHEMA_SQL } from '../lib/db/schema';

const CONNECTION_ENV_VARS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING',
];

async function main() {
  const name = CONNECTION_ENV_VARS.find((key) => process.env[key]);
  const connectionString = name ? process.env[name] : undefined;

  if (!connectionString) {
    console.error(`No connection string. Set one of: ${CONNECTION_ENV_VARS.join(', ')}`);
    process.exit(1);
  }
  console.log(`Using ${name}`);

  const client = new Client({
    connectionString,
    ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA_SQL);
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
