import { describe, expect, it } from 'vitest';
import { decideMigrateAccess } from '@/lib/auth';

/**
 * The bootstrap window is a deliberate exception to "admin writes need a
 * secret", so its boundaries are worth pinning down precisely.
 */
describe('decideMigrateAccess', () => {
  it('lets an empty database be bootstrapped without a secret', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: null, emptyDatabase: true }),
    ).toBe('bootstrap');
  });

  it('closes the bootstrap window the moment any table exists', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: null, emptyDatabase: false }),
    ).toBe('denied');
  });

  it('accepts the correct bearer token once the database has data', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: 'Bearer shh', emptyDatabase: false }),
    ).toBe('authorized');
  });

  it('rejects a wrong token', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: 'Bearer nope', emptyDatabase: false }),
    ).toBe('denied');
  });

  it('rejects a token in the wrong format', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: 'shh', emptyDatabase: false }),
    ).toBe('denied');
  });

  it('stays open when no secret is configured at all, as the cron routes do', () => {
    expect(
      decideMigrateAccess({ secret: undefined, authorization: null, emptyDatabase: false }),
    ).toBe('authorized');
  });

  /**
   * A database that is merely behind a schema change holds real data, so
   * bringing it up to date is an ordinary admin write rather than a bootstrap.
   */
  it('does not reopen the bootstrap window for a partially migrated database', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: null, emptyDatabase: false }),
    ).toBe('denied');
  });

  it('still allows the update when no secret is configured', () => {
    expect(
      decideMigrateAccess({ secret: undefined, authorization: null, emptyDatabase: false }),
    ).toBe('authorized');
  });

  it('does not treat an empty secret as a configured one', () => {
    expect(
      decideMigrateAccess({ secret: '', authorization: null, emptyDatabase: false }),
    ).toBe('authorized');
  });
});
