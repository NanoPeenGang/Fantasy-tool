import { describe, expect, it } from 'vitest';
import { decideMigrateAccess } from '@/lib/auth';

/**
 * The bootstrap window is a deliberate exception to "admin writes need a
 * secret", so its boundaries are worth pinning down precisely.
 */
describe('decideMigrateAccess', () => {
  it('lets an unmigrated database be bootstrapped without a secret', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: null, migrated: false }),
    ).toBe('bootstrap');
  });

  it('closes the bootstrap window the moment the schema exists', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: null, migrated: true }),
    ).toBe('denied');
  });

  it('accepts the correct bearer token once migrated', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: 'Bearer shh', migrated: true }),
    ).toBe('authorized');
  });

  it('rejects a wrong token', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: 'Bearer nope', migrated: true }),
    ).toBe('denied');
  });

  it('rejects a token in the wrong format', () => {
    expect(
      decideMigrateAccess({ secret: 'shh', authorization: 'shh', migrated: true }),
    ).toBe('denied');
  });

  it('stays open when no secret is configured at all, as the cron routes do', () => {
    expect(
      decideMigrateAccess({ secret: undefined, authorization: null, migrated: true }),
    ).toBe('authorized');
  });

  it('does not treat an empty secret as a configured one', () => {
    expect(
      decideMigrateAccess({ secret: '', authorization: null, migrated: true }),
    ).toBe('authorized');
  });
});
