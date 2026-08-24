import type { Award, MatchupPacket, SeasonTeamLine } from './types';

/**
 * Award resolution.
 *
 * Awards are permanently named and recur every week, which is what makes the
 * season counts fun. Every award resolves to a computed number plus the evidence
 * that produced it — the evidence blob is what the fact-check pass verifies the
 * generated prose against, so an award without evidence is useless downstream.
 */

export type AwardContext = {
  teams: SeasonTeamLine[];
  matchups: MatchupPacket[];
  /** Per manager, the largest win probability given up by a start/sit call. */
  bagholder: Record<string, { lostWinProb: number; benched: string; started: string }>;
  /** Managers who left a slot empty or started a player on bye / already out. */
  cowardice: Record<string, { emptySlots: number; byePlayers: string[]; outPlayers: string[] }>;
};

export const AWARD_LABELS: Record<string, string> = {
  shit_the_bed: 'Sh*t the Bed',
  cardiac_kid: 'Cardiac Kid',
  bench_warmer: 'Bench Warmer',
  bagholder: 'The Bagholder',
  coward: 'Coward of the Week',
  heist: 'Heist of the Week',
};

export function resolveAwards(context: AwardContext): Award[] {
  const awards: Award[] = [];
  const { teams, matchups } = context;
  if (teams.length === 0) return awards;

  const byManagerId = new Map(teams.map((t) => [t.managerId, t]));

  // Sh*t the Bed — lowest score of the week.
  const worst = [...teams].sort((a, b) => a.score - b.score)[0];
  if (worst) {
    awards.push({
      key: 'shit_the_bed',
      label: AWARD_LABELS.shit_the_bed as string,
      manager: worst.manager,
      managerId: worst.managerId,
      value: worst.score,
      evidence: {
        score: worst.score,
        leagueMean: round2(teams.reduce((a, t) => a + t.score, 0) / teams.length),
        nextLowest: [...teams].sort((a, b) => a.score - b.score)[1]?.score ?? null,
      },
    });
  }

  // Cardiac Kid — narrowest win. Byes and ties are not wins.
  const decided = matchups.filter((m) => m.b !== '' && m.scoreA !== m.scoreB);
  const narrowest = [...decided].sort(
    (x, y) => Math.abs(x.scoreA - x.scoreB) - Math.abs(y.scoreA - y.scoreB),
  )[0];
  if (narrowest) {
    const winnerName = narrowest.scoreA > narrowest.scoreB ? narrowest.a : narrowest.b;
    const winner = teams.find((t) => t.manager === winnerName);
    if (winner) {
      awards.push({
        key: 'cardiac_kid',
        label: AWARD_LABELS.cardiac_kid as string,
        manager: winner.manager,
        managerId: winner.managerId,
        value: round2(Math.abs(narrowest.scoreA - narrowest.scoreB)),
        evidence: {
          opponent: winnerName === narrowest.a ? narrowest.b : narrowest.a,
          scoreA: narrowest.scoreA,
          scoreB: narrowest.scoreB,
          comebackIndex: narrowest.comebackIndex,
        },
      });
    }
  }

  // Bench Warmer — most points left sitting, measured against the optimal
  // lineup rather than the raw bench total.
  const benched = [...teams].sort((a, b) => b.benchPointsLeft - a.benchPointsLeft)[0];
  if (benched && benched.benchPointsLeft > 0) {
    awards.push({
      key: 'bench_warmer',
      label: AWARD_LABELS.bench_warmer as string,
      manager: benched.manager,
      managerId: benched.managerId,
      value: benched.benchPointsLeft,
      evidence: {
        score: benched.score,
        optimal: benched.optimal,
        coachingEfficiency: benched.coachingEfficiency,
      },
    });
  }

  // The Bagholder — worst start/sit call by win probability lost.
  const bagholderEntry = Object.entries(context.bagholder)
    .sort((x, y) => y[1].lostWinProb - x[1].lostWinProb)[0];
  if (bagholderEntry && bagholderEntry[1].lostWinProb > 0.01) {
    const [managerId, detail] = bagholderEntry;
    const team = byManagerId.get(managerId);
    if (team) {
      awards.push({
        key: 'bagholder',
        label: AWARD_LABELS.bagholder as string,
        manager: team.manager,
        managerId,
        value: round4(detail.lostWinProb),
        evidence: {
          benched: detail.benched,
          started: detail.started,
          winProbabilityLost: round4(detail.lostWinProb),
        },
      });
    }
  }

  // Coward of the Week — didn't set a lineup, or started a bye-week player.
  // Ranked by severity because leaving three slots empty is worse than one.
  const cowardEntries = Object.entries(context.cowardice)
    .map(([managerId, detail]) => ({
      managerId,
      detail,
      severity: detail.emptySlots * 2 + detail.byePlayers.length * 2 + detail.outPlayers.length,
    }))
    .filter((entry) => entry.severity > 0)
    .sort((x, y) => y.severity - x.severity);

  const coward = cowardEntries[0];
  if (coward) {
    const team = byManagerId.get(coward.managerId);
    if (team) {
      awards.push({
        key: 'coward',
        label: AWARD_LABELS.coward as string,
        manager: team.manager,
        managerId: coward.managerId,
        value: coward.severity,
        evidence: {
          emptySlots: coward.detail.emptySlots,
          byePlayers: coward.detail.byePlayers,
          outPlayers: coward.detail.outPlayers,
        },
      });
    }
  }

  // Heist of the Week — lowest comeback index among winners.
  const heists = matchups
    .filter((m) => m.comebackIndex !== null && m.b !== '')
    .sort((x, y) => (x.comebackIndex as number) - (y.comebackIndex as number));
  const heist = heists[0];
  if (heist && (heist.comebackIndex as number) < 0.35) {
    const winnerName = heist.scoreA > heist.scoreB ? heist.a : heist.b;
    const winner = teams.find((t) => t.manager === winnerName);
    if (winner) {
      awards.push({
        key: 'heist',
        label: AWARD_LABELS.heist as string,
        manager: winner.manager,
        managerId: winner.managerId,
        value: heist.comebackIndex as number,
        evidence: {
          opponent: winnerName === heist.a ? heist.b : heist.a,
          comebackIndex: heist.comebackIndex,
          peakOpponentWinProb: heist.peakWinProb,
          turningPoint: heist.turningPoint,
        },
      });
    }
  }

  return awards;
}

/** Running season counts per manager per award, for the recap's awards section. */
export function seasonAwardCounts(
  weekly: { week: number; awards: Award[] }[],
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const { awards } of weekly) {
    for (const award of awards) {
      const perAward = (counts[award.key] ??= {});
      perAward[award.manager] = (perAward[award.manager] ?? 0) + 1;
    }
  }
  return counts;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
