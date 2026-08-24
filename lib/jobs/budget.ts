/**
 * A wall-clock budget for fan-out jobs.
 *
 * Vercel's Hobby plan caps a function at 60 seconds, and a job that walks every
 * connected league can exceed that. A killed invocation loses its work silently
 * and reports nothing; a job that stops one league short returns what it did and
 * says where it stopped, so the next run — or a manual `?leagueId=` call — can
 * pick up the remainder.
 *
 * The headroom exists because the check happens *before* a unit of work, not
 * during it: we need enough left to finish the league we are about to start.
 */
export class TimeBudget {
  private readonly startedAt: number;

  constructor(
    private readonly totalMs: number,
    private readonly headroomMs = 8_000,
  ) {
    this.startedAt = Date.now();
  }

  /** Milliseconds left before the invocation is at risk of being killed. */
  remaining(): number {
    return this.totalMs - this.headroomMs - (Date.now() - this.startedAt);
  }

  /** True when there is not enough time left to safely start another unit. */
  exhausted(): boolean {
    return this.remaining() <= 0;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

/**
 * The function's own ceiling, mirrored from the `maxDuration` export on each
 * route. Kept at the Hobby limit; raise both together if you move to a plan
 * that allows longer functions.
 */
export const FUNCTION_BUDGET_MS = 60_000;
