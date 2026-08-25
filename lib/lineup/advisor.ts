import { coachingReport, scoringSlots, solveOptimalLineup } from '@/lib/compute/lineup';
import { simulateMatchup, winProbabilityAdded } from '@/lib/compute/odds';
import { hashSeed } from '@/lib/compute/random';
import type { PlayerRef, StarterState } from '@/lib/compute/types';

/**
 * Week-to-week lineup help.
 *
 * The prospective half of the optimal lineup solver: the same maximum-weight
 * matching that grades a finished week, run forward on projections instead of
 * results.
 *
 * Every recommendation is priced in **win probability added**, not points.
 * "+2.1 projected points" is not a decision; +6.2% to win is. Points only matter
 * relative to what the opponent is likely to score, and a two-point upgrade is
 * worth far more in a coin-flip matchup than in one already decided.
 */

export type LineupPlayer = PlayerRef & {
  projection: number;
  /** True when this player is in the current starting lineup. */
  started: boolean;
  /** NFL bye week, when known. */
  byeWeek?: number | null;
};

export type StartSitCall = {
  slot: string;
  startPlayer: LineupPlayer;
  sitPlayer: LineupPlayer | null;
  pointsAdded: number;
  /** The number that matters. Null when no opponent is known. */
  winProbabilityAdded: number | null;
  reason: string;
};

export type LineupFlag = {
  kind: 'bye' | 'injury' | 'empty_slot';
  player: string | null;
  slot: string | null;
  detail: string;
};

export type LineupAdvice = {
  week: number;
  currentProjected: number;
  optimalProjected: number;
  pointsLeftOnBench: number;
  /** Win probability with the lineup as it stands. Null without an opponent. */
  currentWinProbability: number | null;
  optimalWinProbability: number | null;
  calls: StartSitCall[];
  flags: LineupFlag[];
  optimalLineup: { slot: string; player: LineupPlayer | null; projection: number }[];
};

const RULED_OUT = new Set(['OUT', 'IR', 'PUP', 'SUS', 'NA', 'DOUBTFUL']);

export function adviseLineup(params: {
  week: number;
  roster: LineupPlayer[];
  rosterPositions: string[];
  /** The opponent's projected starters. Without them, calls are points-only. */
  opponent?: LineupPlayer[];
  iterations?: number;
}): LineupAdvice {
  const { week, roster, rosterPositions } = params;

  const projections: Record<string, number> = {};
  for (const player of roster) projections[player.id] = player.projection;

  const started = roster.filter((player) => player.started);
  const currentProjected = round2(started.reduce((sum, player) => sum + player.projection, 0));

  const optimal = solveOptimalLineup({ players: roster, weights: projections, rosterPositions });

  const report = coachingReport({
    roster,
    started: started.map((player) => player.id),
    points: projections,
    rosterPositions,
  });

  const opponentStarters = params.opponent?.filter((player) => player.started) ?? [];
  const hasOpponent = opponentStarters.length > 0;

  const currentStates = toStarterStates(started);
  const opponentStates = toStarterStates(opponentStarters);

  // A shared seed across every simulation below: the difference between two
  // lineups has to be the lineup, not Monte Carlo noise. Without this a genuine
  // one-point edge disappears into sampling error.
  const seed = hashSeed('lineup', week, roster.length);
  const iterations = params.iterations ?? 6_000;

  const currentWinProbability = hasOpponent
    ? simulateMatchup(currentStates, opponentStates, { seed, iterations }).winProbA
    : null;

  const optimalStarters = optimal.slots
    .map((slot) => slot.player)
    .filter((player): player is PlayerRef => player !== null)
    .map((player) => roster.find((r) => r.id === player.id))
    .filter((player): player is LineupPlayer => player !== undefined);

  const optimalWinProbability = hasOpponent
    ? simulateMatchup(toStarterStates(optimalStarters), opponentStates, { seed, iterations }).winProbA
    : null;

  const calls: StartSitCall[] = [];
  for (const regret of report.regrets) {
    const startPlayer = roster.find((player) => player.id === regret.benchPlayer.id);
    if (!startPlayer) continue;
    const sitPlayer = regret.replacing
      ? roster.find((player) => player.id === regret.replacing?.id) ?? null
      : null;

    let wpa: number | null = null;
    if (hasOpponent && sitPlayer) {
      wpa = winProbabilityAdded({
        starters: currentStates,
        opponent: opponentStates,
        swapOut: sitPlayer.id,
        swapIn: toStarterState(startPlayer),
        options: { seed, iterations },
      });
    }

    calls.push({
      slot: regret.slot,
      startPlayer,
      sitPlayer,
      pointsAdded: regret.delta,
      winProbabilityAdded: wpa,
      reason: describeCall(startPlayer, sitPlayer, regret.delta, wpa),
    });
  }

  calls.sort((a, b) => {
    // Rank by win probability where we have it, because that is the real
    // ordering; points are only the fallback when no opponent is known.
    if (a.winProbabilityAdded !== null && b.winProbabilityAdded !== null) {
      return b.winProbabilityAdded - a.winProbabilityAdded;
    }
    return b.pointsAdded - a.pointsAdded;
  });

  return {
    week,
    currentProjected,
    optimalProjected: optimal.total,
    pointsLeftOnBench: round2(Math.max(0, optimal.total - currentProjected)),
    currentWinProbability,
    optimalWinProbability,
    calls,
    flags: lineupFlags({ week, started, rosterPositions }),
    optimalLineup: optimal.slots.map((slot) => ({
      slot: slot.slot,
      player: slot.player ? roster.find((r) => r.id === slot.player?.id) ?? null : null,
      projection: round2(slot.points),
    })),
  };
}

/**
 * The things that cost a manager a week without any analysis being needed: an
 * empty slot, a player on bye, a player already ruled out. These are checked
 * separately from the solver because they are certainties, not recommendations.
 */
function lineupFlags(params: {
  week: number;
  started: LineupPlayer[];
  rosterPositions: string[];
}): LineupFlag[] {
  const flags: LineupFlag[] = [];

  const slotCount = scoringSlots(params.rosterPositions).length;
  const empty = slotCount - params.started.length;
  if (empty > 0) {
    flags.push({
      kind: 'empty_slot',
      player: null,
      slot: null,
      detail: `${empty} starting slot${empty === 1 ? '' : 's'} are empty and will score zero.`,
    });
  }

  for (const player of params.started) {
    if (player.byeWeek === params.week) {
      flags.push({
        kind: 'bye',
        player: player.name,
        slot: player.position,
        detail: `${player.name} is on bye this week and will score zero.`,
      });
    }
    const status = player.injuryStatus?.trim().toUpperCase();
    if (status && RULED_OUT.has(status)) {
      flags.push({
        kind: 'injury',
        player: player.name,
        slot: player.position,
        detail: `${player.name} is listed ${player.injuryStatus} and is unlikely to play.`,
      });
    }
  }

  return flags;
}

function describeCall(
  startPlayer: LineupPlayer,
  sitPlayer: LineupPlayer | null,
  pointsAdded: number,
  wpa: number | null,
): string {
  const target = sitPlayer ? sitPlayer.name : 'an empty slot';
  if (wpa === null) {
    return `Starting ${startPlayer.name} over ${target} is worth ${pointsAdded} projected points.`;
  }
  const pct = Math.round(wpa * 1000) / 10;
  return `Starting ${startPlayer.name} over ${target} is ${pct > 0 ? '+' : ''}${pct}% to win.`;
}

function toStarterStates(players: LineupPlayer[]): StarterState[] {
  return players.map(toStarterState);
}

function toStarterState(player: LineupPlayer): StarterState {
  return {
    id: player.id,
    name: player.name,
    position: player.position,
    team: player.team,
    injuryStatus: player.injuryStatus,
    projection: player.projection,
    actual: 0,
    gameStatus: 'pre',
    gamePctElapsed: 0,
    opponentTeam: null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
