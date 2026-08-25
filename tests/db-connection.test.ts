import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Connection-string resolution.
 *
 * Every variant here is one a real hosting provider actually produces. The
 * failure this guards against is the worst kind for setup: a correctly attached
 * database that the app reports as "not attached", sending someone off to
 * re-check a connection string that was right all along.
 */
describe('resolveConnection', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (/^(DATABASE|POSTGRES|PG|NEON)/.test(key)) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  async function load() {
    // Fresh module each time: the resolver reads process.env at call time, but
    // the pool is memoised, so a clean import keeps cases independent.
    vi.resetModules();
    return import('@/lib/db/client');
  }

  it('finds DATABASE_URL', async () => {
    process.env.DATABASE_URL = 'postgres://a/b';
    const { resolveConnection } = await load();
    expect(resolveConnection()).toEqual({ url: 'postgres://a/b', source: 'DATABASE_URL' });
  });

  it('finds the Vercel Postgres name', async () => {
    process.env.POSTGRES_URL = 'postgres://a/b';
    const { resolveConnection } = await load();
    expect(resolveConnection()?.source).toBe('POSTGRES_URL');
  });

  it('finds the unpooled Neon name', async () => {
    process.env.DATABASE_URL_UNPOOLED = 'postgres://a/b';
    const { resolveConnection } = await load();
    expect(resolveConnection()?.source).toBe('DATABASE_URL_UNPOOLED');
  });

  it('prefers the pooled endpoint when both are present', async () => {
    process.env.DATABASE_URL = 'postgres://pooled/b';
    process.env.DATABASE_URL_UNPOOLED = 'postgres://direct/b';
    const { resolveConnection } = await load();
    expect(resolveConnection()?.url).toBe('postgres://pooled/b');
  });

  it('ignores a variable that is present but empty', async () => {
    process.env.DATABASE_URL = '   ';
    process.env.POSTGRES_URL = 'postgres://real/b';
    const { resolveConnection } = await load();
    expect(resolveConnection()?.source).toBe('POSTGRES_URL');
  });

  it('returns null when nothing is set', async () => {
    const { resolveConnection } = await load();
    expect(resolveConnection()).toBeNull();
  });

  describe('assembling from discrete parts', () => {
    it('builds a URL when only PG* parts exist', async () => {
      process.env.PGHOST = 'ep-x.neon.tech';
      process.env.PGUSER = 'owner';
      process.env.PGPASSWORD = 'secret';
      process.env.PGDATABASE = 'neondb';
      const { resolveConnection } = await load();
      const connection = resolveConnection();
      expect(connection?.source).toBe('PGHOST/PGUSER/PGDATABASE');
      expect(connection?.url).toBe(
        'postgres://owner:secret@ep-x.neon.tech:5432/neondb?sslmode=require',
      );
    });

    it('defaults to requiring TLS, since the providers that set these mandate it', async () => {
      process.env.PGHOST = 'h';
      process.env.PGUSER = 'u';
      process.env.PGDATABASE = 'd';
      const { resolveConnection } = await load();
      expect(resolveConnection()?.url).toContain('sslmode=require');
    });

    it('honours PGSSLMODE so a local server without TLS still works', async () => {
      process.env.PGHOST = 'localhost';
      process.env.PGUSER = 'postgres';
      process.env.PGDATABASE = 'dev';
      process.env.PGSSLMODE = 'disable';
      const { resolveConnection } = await load();
      expect(resolveConnection()?.url).toContain('sslmode=disable');
    });

    it('escapes credentials that would otherwise corrupt the URL', async () => {
      process.env.PGHOST = 'h';
      process.env.PGUSER = 'user@corp';
      process.env.PGPASSWORD = 'p@ss:word/x';
      process.env.PGDATABASE = 'd';
      const { resolveConnection } = await load();
      const url = resolveConnection()?.url as string;
      expect(url).toContain('user%40corp');
      expect(url).toContain('p%40ss%3Aword%2Fx');
      // The host must still be parseable as the host.
      expect(new URL(url).hostname).toBe('h');
    });

    it('accepts the POSTGRES_* spellings of the same parts', async () => {
      process.env.POSTGRES_HOST = 'h';
      process.env.POSTGRES_USER = 'u';
      process.env.POSTGRES_DATABASE = 'd';
      const { resolveConnection } = await load();
      // The source names the variables actually read, so a reader can go and
      // look at them, rather than a canonical label that may not exist.
      expect(resolveConnection()?.source).toBe('POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE');
    });

    it('does not guess from an incomplete set of parts', async () => {
      process.env.PGHOST = 'h';
      const { resolveConnection } = await load();
      expect(resolveConnection()).toBeNull();
    });

    it('prefers a real URL over the parts', async () => {
      process.env.DATABASE_URL = 'postgres://explicit/b';
      process.env.PGHOST = 'h';
      process.env.PGUSER = 'u';
      process.env.PGDATABASE = 'd';
      const { resolveConnection } = await load();
      expect(resolveConnection()?.source).toBe('DATABASE_URL');
    });
  });


  /**
   * Vercel's storage integrations offer an "environment variables prefix" when
   * you attach a database, and Neon's flow sets one by default. These are the
   * exact names that flow produces.
   */
  describe('prefixed variables, as the Vercel Neon integration writes them', () => {
    it('finds a prefixed DATABASE_URL', async () => {
      process.env.database_DATABASE_URL = 'postgres://neon/db?sslmode=require';
      const { resolveConnection } = await load();
      expect(resolveConnection()).toEqual({
        url: 'postgres://neon/db?sslmode=require',
        source: 'database_DATABASE_URL',
      });
    });

    it('keeps the priority order across prefixed names', async () => {
      process.env.database_POSTGRES_URL_NO_SSL = 'postgres://nossl/db';
      process.env.database_DATABASE_URL = 'postgres://pooled/db';
      const { resolveConnection } = await load();
      expect(resolveConnection()?.url).toBe('postgres://pooled/db');
    });

    it('does not confuse the pooled and unpooled endpoints', async () => {
      process.env.database_DATABASE_URL_UNPOOLED = 'postgres://direct/db';
      process.env.database_DATABASE_URL = 'postgres://pooled/db';
      const { resolveConnection } = await load();
      expect(resolveConnection()?.source).toBe('database_DATABASE_URL');
    });

    it('reports the real variable name, not the canonical one', async () => {
      process.env.MYAPP_POSTGRES_URL = 'postgres://x/y';
      const { resolveConnection } = await load();
      // Naming the actual variable is what makes the diagnostic actionable.
      expect(resolveConnection()?.source).toBe('MYAPP_POSTGRES_URL');
    });

    it('prefers an unprefixed variable over a prefixed one', async () => {
      process.env.DATABASE_URL = 'postgres://plain/db';
      process.env.database_DATABASE_URL = 'postgres://prefixed/db';
      const { resolveConnection } = await load();
      expect(resolveConnection()?.source).toBe('DATABASE_URL');
    });

    it('assembles from prefixed discrete parts', async () => {
      process.env.database_PGHOST = 'ep-x.neon.tech';
      process.env.database_PGUSER = 'owner';
      process.env.database_PGDATABASE = 'neondb';
      const { resolveConnection } = await load();
      const connection = resolveConnection();
      expect(connection?.url).toContain('ep-x.neon.tech');
      expect(connection?.source).toContain('database_PGHOST');
    });

    it('is not fooled by a Neon Auth URL, which is not a Postgres connection', async () => {
      process.env.database_NEON_AUTH_BASE_URL = 'https://api.stack-auth.com';
      const { resolveConnection } = await load();
      expect(resolveConnection()).toBeNull();
    });

    /**
     * The regression that sent this whole investigation the wrong way: the
     * diagnostic reported an empty list for a deployment whose variables were
     * all prefixed, which pointed confidently away from the real problem.
     */
    it('reports prefixed names in the diagnostic', async () => {
      process.env.database_DATABASE_URL = 'postgres://x/y';
      process.env.database_PGDATABASE = 'neondb';
      process.env.database_NEON_AUTH_BASE_URL = 'https://x';
      const { databaseEnvVarNames } = await load();
      expect(databaseEnvVarNames()).toEqual([
        'database_DATABASE_URL',
        'database_NEON_AUTH_BASE_URL',
        'database_PGDATABASE',
      ]);
    });
  });

  describe('databaseEnvVarNames', () => {
    it('reports names of database-shaped variables', async () => {
      process.env.PGHOST = 'h';
      process.env.NEON_PROJECT_ID = 'abc';
      const { databaseEnvVarNames } = await load();
      expect(databaseEnvVarNames()).toEqual(['NEON_PROJECT_ID', 'PGHOST']);
    });

    /** The whole point is that this is safe to render in a UI and a log. */
    it('never reports a value', async () => {
      process.env.DATABASE_URL = 'postgres://user:hunter2@host/db';
      const { databaseEnvVarNames } = await load();
      const names = databaseEnvVarNames();
      expect(names).toEqual(['DATABASE_URL']);
      expect(names.join(' ')).not.toContain('hunter2');
    });

    it('omits variables that are set but empty', async () => {
      process.env.PGHOST = '';
      const { databaseEnvVarNames } = await load();
      expect(databaseEnvVarNames()).toEqual([]);
    });

    it('returns an empty list when the runtime has nothing', async () => {
      const { databaseEnvVarNames } = await load();
      expect(databaseEnvVarNames()).toEqual([]);
    });
  });
});
