import { resolveAwards, type AwardContext } from './awards';
import { coachingReport, scoringSlots, solveOptimalLineup } from './lineup';
import {
  allPlayRecord,
  allPlayWinRate,
  headToHeadRecord,
  luckIndex,
  powerScores,
  recentMean,
  seasonMoments,
  type SeasonHistory,
} from './standings';
import { swingMetrics } from './swing';
import { summarizeTransactions, type TransactionContext } from './transactions';
import type {
  HotPlayer,
  MatchupPacket,
  MatchupWeek,
  OddsSnapshot,
  PlayerRef,
  SeasonTeamLine,
  StatPacket,
  Storyline,
  TeamOfTheWeek,
  TeamWeek,
  UpcomingMatchup,
} from './types';

/**
 * The weekly stat packet: computed once when the last game goes final, read by
 * everything downstream and recomputed by nothing.
 *
 * The dashboard, the odds board, the AAR, the power rankings and the
 * Commissioner's Report all read this document. If a number appears in a
 * generated report and is not in here, the fact-check pass cuts it — so this
 * schema is also the contract for what the writer is allowed to say.
 */

/** Sleeper writes an unfilled starting slot as the string "0". */
export const EMPTY_STARTER = '0';

export type PacketInput = {
  leagueId: string;
  leagueName: string;
  season: string;
  week: number;
  rosterPositions: string[];
  matchups: MatchupWeek[];
  /** Every player referenced by any roster this week. */
  players: Record<string, PlayerRef>;
  history: SeasonHistory;
  /** Persisted odds ticks keyed by matchup id. Empty before the odds engine runs. */
  oddsByMatchup?: Record<number, OddsSnapshot[]>;
  /** Player id -> this week's projection, when a projection source is configured. */
  projections?: Record<string, number>;
  /** Roster id -> sum of rest-of-season projections. */
  rosterStrength?: Record<number, number>;
  /** Manager id -> last week's power rank, for the movement arrows. */
  previousPowerRanks?: Record<string, number>;
  transactions?: TransactionContext;
  storylines?: Storyline[];
  /** Player ids whose NFL team was on bye this week. */
  byePlayers?: Set<string>;
  upcoming?: UpcomingMatchup[];
  computedAt?: string;
};

export function buildStatPacket(input: PacketInput): StatPacket {
  const teamWeeks = input.matchups.flatMap((m) => (m.b ? [m.a, m.b] : [m.a]));
  const playersOf = (ids: string[]): PlayerRef[] =>
    ids.filter((id) => id !== EMPTY_STARTER).map((id) => input.players[id]).filter(isPlayer);

  // --- per-team lines -------------------------------------------------------
  const coaching = new Map<number, ReturnType<typeof coachingReport>>();
  for (const team of teamWeeks) {
    coaching.set(
      team.rosterId,
      coachingReport({
        roster: playersOf(team.players),
        started: team.starters.filter((id) => id !== EMPTY_STARTER),
        points: team.points,
        rosterPositions: input.rosterPositions,
      }),
    );
  }

  const powerInputs = teamWeeks.map((team) => ({
    rosterId: team.rosterId,
    allPlayWinRate: allPlayWinRate(allPlayRecord(input.history, team.rosterId, input.week)),
    recentMean: recentMean(input.history, team.rosterId, input.week),
    rosterStrength: input.rosterStrength?.[team.rosterId] ?? 0,
    pointsFor: headToHeadRecord(input.history, team.rosterId, input.week).pf,
  }));
  const power = new Map(powerScores(powerInputs).map((p) => [p.rosterId, p]));

  const teams: SeasonTeamLine[] = teamWeeks.map((team) => {
    const report = coaching.get(team.rosterId)!;
    const h2h = headToHeadRecord(input.history, team.rosterId, input.week);
    const moments = seasonMoments(input.history, team.rosterId, input.week);
    const powerEntry = power.get(team.rosterId);
    const previousRank = input.previousPowerRanks?.[team.managerId];

    return {
      managerId: team.managerId,
      manager: team.manager,
      teamName: team.teamName,
      rosterId: team.rosterId,
      score: round2(team.score),
      optimal: report.optimal,
      coachingEfficiency: report.efficiency,
      benchPointsLeft: report.benchPointsLeft,
      allPlay: allPlayRecord(input.history, team.rosterId, input.week),
      record: { w: h2h.w, l: h2h.l, t: h2h.t },
      pf: h2h.pf,
      pa: h2h.pa,
      luckIndex: luckIndex(input.history, team.rosterId, input.week),
      powerScore: powerEntry?.powerScore ?? 0,
      powerRank: powerEntry?.powerRank ?? 0,
      // Positive means moved up the board; ranks count down, hence the flip.
      rankDelta: previousRank && powerEntry ? previousRank - powerEntry.powerRank : 0,
      seasonMean: moments.mean,
      seasonSd: moments.sd,
    };
  });

  const teamByRoster = new Map(teams.map((t) => [t.rosterId, t]));

  // --- per-matchup lines ----------------------------------------------------
  const matchups: MatchupPacket[] = input.matchups.map((matchup) =>
    buildMatchupPacket(matchup, input, coaching, input.oddsByMatchup?.[matchup.matchupId] ?? []),
  );

  // --- awards ---------------------------------------------------------------
  const awardContext: AwardContext = {
    teams,
    matchups,
    bagholder: bagholderContext(teamWeeks, coaching, teamByRoster, input),
    cowardice: cowardiceContext(teamWeeks, input),
  };

  return {
    leagueId: input.leagueId,
    leagueName: input.leagueName,
    season: input.season,
    week: input.week,
    computedAt: input.computedAt ?? new Date().toISOString(),
    teams: [...teams].sort((a, b) => a.powerRank - b.powerRank),
    matchups,
    awards: resolveAwards(awardContext),
    transactions: input.transactions
      ? summarizeTransactions(input.transactions)
      : { adds: [], drops: [], trades: [], waiverRoi: [] },
    hotPlayers: hotPlayers(teamWeeks, input),
    teamOfTheWeek: teamOfTheWeek(teamWeeks, input),
    upcoming: input.upcoming ?? [],
    storylinesLive: (input.storylines ?? []).filter((s) => s.status === 'live'),
  };
}

function buildMatchupPacket(
  matchup: MatchupWeek,
  input: PacketInput,
  coaching: Map<number, ReturnType<typeof coachingReport>>,
  snapshots: OddsSnapshot[],
): MatchupPacket {
  const a = matchup.a;
  const b = matchup.b;

  if (!b) {
    return {
      matchupId: matchup.matchupId,
      a: a.manager,
      b: '',
      scoreA: round2(a.score),
      scoreB: 0,
      opening: null,
      closingUpset: false,
      peakWinProb: null,
      comebackIndex: null,
      clinchAt: null,
      turningPoint: null,
      coachingLoss: false,
      marginVsBench: 'no opponent this week',
      deadOnArrival: false,
    };
  }

  const winner = a.score > b.score ? 'a' : a.score < b.score ? 'b' : 'tie';
  const swing = swingMetrics(snapshots, winner);

  const reportA = coaching.get(a.rosterId);
  const reportB = coaching.get(b.rosterId);
  const margin = Math.abs(a.score - b.score);

  // A coaching loss is a loss the loser's own bench would have prevented: their
  // optimal lineup clears the winner's actual score.
  const loserReport = winner === 'a' ? reportB : reportA;
  const winnerScore = winner === 'a' ? a.score : b.score;
  const coachingLoss = winner !== 'tie' && !!loserReport && loserReport.optimal > winnerScore;

  const peak = pickPeak(swing, a.manager, b.manager, winner);

  return {
    matchupId: matchup.matchupId,
    a: a.manager,
    b: b.manager,
    scoreA: round2(a.score),
    scoreB: round2(b.score),
    opening: swing.opening
      ? {
          winProbA: swing.opening.winProbA,
          spread: swing.opening.spread,
          total: swing.opening.total,
        }
      : null,
    closingUpset: swing.closingUpset,
    peakWinProb: peak,
    comebackIndex: swing.comebackIndex,
    clinchAt: swing.clinchAt,
    turningPoint: swing.biggestSwing
      ? {
          playerId: swing.biggestSwing.playerId,
          player: swing.biggestSwing.playerId
            ? input.players[swing.biggestSwing.playerId]?.name ?? swing.biggestSwing.playerId
            : 'unattributed',
          swing: swing.biggestSwing.delta,
          at: swing.biggestSwing.at,
          description: describeSwing(swing.biggestSwing, a.manager, b.manager, input),
        }
      : null,
    coachingLoss,
    marginVsBench: describeBenchMargin(margin, winner, reportA, reportB, a, b),
  deadOnArrival: swing.deadOnArrival,
  };
}

/**
 * The peak worth reporting is the *loser's*: "led 94% at 4:12 and lost" is a
 * story, while the winner's peak is 1.0 in every completed matchup and says
 * nothing. On a tie, neither side lost, so the higher of the two is used.
 */
function pickPeak(
  swing: ReturnType<typeof swingMetrics>,
  nameA: string,
  nameB: string,
  winner: 'a' | 'b' | 'tie',
): { manager: string; value: number; at: string } | null {
  const a = swing.peakA ? { manager: nameA, ...swing.peakA } : null;
  const b = swing.peakB ? { manager: nameB, ...swing.peakB } : null;

  if (winner === 'a') return b;
  if (winner === 'b') return a;

  const candidates = [a, b].filter(
    (c): c is { manager: string; value: number; at: string } => c !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.sort((x, y) => y.value - x.value)[0] as {
    manager: string;
    value: number;
    at: string;
  };
}

function describeSwing(
  swing: NonNullable<ReturnType<typeof swingMetrics>['biggestSwing']>,
  nameA: string,
  nameB: string,
  input: PacketInput,
): string {
  const beneficiary = swing.towardA ? nameA : nameB;
  const pct = Math.round(swing.delta * 100);
  if (!swing.playerId) return `A ${pct}-point win probability swing toward ${beneficiary}.`;
  const player = input.players[swing.playerId]?.name ?? swing.playerId;
  return `${player} scored ${swing.playerPoints} and moved the line ${pct} points toward ${beneficiary}.`;
}

function describeBenchMargin(
  margin: number,
  winner: 'a' | 'b' | 'tie',
  reportA: ReturnType<typeof coachingReport> | undefined,
  reportB: ReturnType<typeof coachingReport> | undefined,
  a: TeamWeek,
  b: TeamWeek,
): string {
  if (winner === 'tie') return 'tied';
  const loserReport = winner === 'a' ? reportB : reportA;
  const loserName = winner === 'a' ? b.manager : a.manager;
  if (!loserReport) return `won by ${round2(margin)}`;
  if (loserReport.benchPointsLeft > margin) {
    return `${loserName} left ${loserReport.benchPointsLeft} on the bench and lost by ${round2(margin)}`;
  }
  return `${loserName} left ${loserReport.benchPointsLeft} on the bench, short of the ${round2(margin)} margin`;
}

/**
 * Bagholder context: the worst start/sit call of the week, priced in win
 * probability rather than points.
 *
 * When a projection source is configured the odds layer supplies this directly
 * from a paired simulation. The fallback here is retroactive: it prices the
 * single best available swap against the opponent's realised score, using the
 * team's own season standard deviation as the uncertainty that existed at lock
 * time. That is an approximation and it is deliberately conservative — it never
 * claims a swap mattered more than the game's actual closeness allows.
 */
function bagholderContext(
  teamWeeks: TeamWeek[],
  coaching: Map<number, ReturnType<typeof coachingReport>>,
  teamByRoster: Map<number, SeasonTeamLine>,
  input: PacketInput,
): AwardContext['bagholder'] {
  const out: AwardContext['bagholder'] = {};

  const opponentOf = new Map<number, TeamWeek>();
  for (const matchup of input.matchups) {
    if (!matchup.b) continue;
    opponentOf.set(matchup.a.rosterId, matchup.b);
    opponentOf.set(matchup.b.rosterId, matchup.a);
  }

  for (const team of teamWeeks) {
    const report = coaching.get(team.rosterId);
    const opponent = opponentOf.get(team.rosterId);
    const line = teamByRoster.get(team.rosterId);
    if (!report || !opponent || !line) continue;

    const worst = report.regrets[0];
    if (!worst || worst.delta <= 0) continue;

    const sd = Math.max(line.seasonSd, 12);
    const actualMargin = team.score - opponent.score;
    const swappedMargin = actualMargin + worst.delta;

    const lost = normalCdf(swappedMargin / sd) - normalCdf(actualMargin / sd);
    if (lost <= 0) continue;

    out[team.managerId] = {
      lostWinProb: lost,
      benched: worst.benchPlayer.name,
      started: worst.replacing?.name ?? 'an empty slot',
    };
  }

  return out;
}

/**
 * Cowardice context: unset lineups, bye-week starters, and starters already
 * ruled out before kickoff. All three are things a manager could have fixed by
 * opening the app once.
 */
function cowardiceContext(teamWeeks: TeamWeek[], input: PacketInput): AwardContext['cowardice'] {
  const out: AwardContext['cowardice'] = {};
  const slots = scoringSlots(input.rosterPositions).length;

  for (const team of teamWeeks) {
    const filled = team.starters.filter((id) => id !== EMPTY_STARTER);
    const emptySlots = Math.max(0, slots - filled.length) +
      team.starters.filter((id) => id === EMPTY_STARTER).length;

    const byePlayers: string[] = [];
    const outPlayers: string[] = [];

    for (const id of filled) {
      const player = input.players[id];
      if (!player) continue;
      if (input.byePlayers?.has(id)) byePlayers.push(player.name);
      else if (isRuledOut(player.injuryStatus)) outPlayers.push(player.name);
    }

    if (emptySlots > 0 || byePlayers.length > 0 || outPlayers.length > 0) {
      out[team.managerId] = { emptySlots, byePlayers, outPlayers };
    }
  }

  return out;
}

function isRuledOut(status: string | null): boolean {
  if (!status) return false;
  return ['OUT', 'IR', 'PUP', 'SUS', 'NA'].includes(status.trim().toUpperCase());
}

function hotPlayers(teamWeeks: TeamWeek[], input: PacketInput, limit = 10): HotPlayer[] {
  const rows: HotPlayer[] = [];

  for (const team of teamWeeks) {
    const started = new Set(team.starters);
    for (const playerId of team.players) {
      const player = input.players[playerId];
      if (!player) continue;
      const points = team.points[playerId];
      if (points === undefined) continue;
      const projection = input.projections?.[playerId];
      rows.push({
        player: player.name,
        playerId,
        position: player.position,
        points: round2(points),
        rosteredBy: team.manager,
        started: started.has(playerId),
        vsProjection: projection === undefined ? null : round2(points - projection),
      });
    }
  }

  return rows.sort((a, b) => b.points - a.points).slice(0, limit);
}

/**
 * Team of the week: the optimal lineup drawn from every roster in the league,
 * plus how many of those points were actually started — the gap is the week's
 * collective coaching failure in one number.
 */
function teamOfTheWeek(teamWeeks: TeamWeek[], input: PacketInput): TeamOfTheWeek | null {
  const pool: PlayerRef[] = [];
  const weights: Record<string, number> = {};
  const ownerOf: Record<string, string> = {};
  const startedBy = new Set<string>();

  for (const team of teamWeeks) {
    for (const playerId of team.players) {
      const player = input.players[playerId];
      if (!player || playerId === EMPTY_STARTER) continue;
      const points = team.points[playerId];
      if (points === undefined) continue;
      // A player can appear on only one roster in a league, so first write wins.
      if (!(playerId in weights)) {
        pool.push(player);
        weights[playerId] = points;
        ownerOf[playerId] = team.manager;
      }
      if (team.starters.includes(playerId)) startedBy.add(playerId);
    }
  }

  if (pool.length === 0) return null;

  const solved = solveOptimalLineup({
    players: pool,
    weights,
    rosterPositions: input.rosterPositions,
  });

  const slots = solved.slots
    .filter((slot) => slot.player !== null)
    .map((slot) => ({
      slot: slot.slot,
      player: (slot.player as PlayerRef).name,
      playerId: (slot.player as PlayerRef).id,
      points: round2(slot.points),
      manager: ownerOf[(slot.player as PlayerRef).id] ?? 'unknown',
      started: startedBy.has((slot.player as PlayerRef).id),
    }));

  return {
    slots,
    total: round2(solved.total),
    startedTotal: round2(
      slots.filter((slot) => slot.started).reduce((acc, slot) => acc + slot.points, 0),
    ),
  };
}

function isPlayer(value: PlayerRef | undefined): value is PlayerRef {
  return value !== undefined;
}

/** Local copy so this module stays free of the odds engine's imports. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
