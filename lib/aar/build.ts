import { curveForChart } from '@/lib/compute/swing';
import type {
  BenchRegret,
  MatchupPacket,
  OddsSnapshot,
  SeasonTeamLine,
  StatPacket,
  UpcomingMatchup,
} from '@/lib/compute/types';

/**
 * After Action Report: per matchup, per week.
 *
 * Answers *why*, not *what*. Almost all of it is computed — the verdict is
 * classified by rule rather than by vibes, which matters because "you lost to
 * your own bench" and "you lost to a ceiling game nobody could have planned for"
 * are different messages and the manager can tell when the tool is guessing.
 *
 * Trivially cheap once the odds snapshots exist: everything here reads the stat
 * packet and the persisted curve.
 */

export type Verdict =
  | 'won_on_talent'
  | 'won_on_luck'
  | 'won_a_heist'
  | 'lost_to_own_bench'
  | 'lost_to_a_ceiling_game'
  | 'lost_on_talent'
  | 'tied';

export const VERDICT_COPY: Record<Verdict, { label: string; explanation: string }> = {
  won_on_talent: {
    label: 'Won on talent',
    explanation: 'You out-scored them and the line said you would. Nothing to explain.',
  },
  won_on_luck: {
    label: 'Won on luck',
    explanation: 'You were the underdog and it landed. Enjoy it; it does not repeat.',
  },
  won_a_heist: {
    label: 'Heist',
    explanation: 'You were dead and came back. This is the one you get to talk about.',
  },
  lost_to_own_bench: {
    label: 'Lost to your own bench',
    explanation: 'The winning lineup was on your roster. You did not start it.',
  },
  lost_to_a_ceiling_game: {
    label: 'Lost to a ceiling game',
    explanation: 'Someone on the other side went off. There was no lineup that beat this.',
  },
  lost_on_talent: {
    label: 'Lost on talent',
    explanation: 'They were better and the result matched. The roster is the problem.',
  },
  tied: { label: 'Tied', explanation: 'A tie. Somehow.' },
};

export type LuckSplit = {
  /** Your points above or below your season mean. */
  ownVariance: number;
  /** Their points above or below their season mean. */
  opponentVariance: number;
  /** Points given up to lineup decisions. */
  lineupCost: number;
  margin: number;
};

export type AfterActionReport = {
  week: number;
  matchupId: number;
  manager: string;
  opponent: string;
  score: number;
  opponentScore: number;
  won: boolean;
  verdict: Verdict;
  verdictDetail: string;
  swingChart: { at: string; winProbA: number; scoreA: number; scoreB: number }[];
  /** True when this manager is side A of the stored curve. */
  isSideA: boolean;
  turningPoint: MatchupPacket['turningPoint'];
  peakWinProb: MatchupPacket['peakWinProb'];
  clinchAt: string | null;
  comebackIndex: number | null;
  coaching: {
    actual: number;
    optimal: number;
    efficiency: number;
    pointsLeft: number;
    regrets: BenchRegret[];
    /** The single swap that would have flipped the result, if one exists. */
    counterfactual: string | null;
  };
  luckSplit: LuckSplit;
  waiverRoi: StatPacket['transactions']['waiverRoi'];
  nextWeek: UpcomingMatchup | null;
};

export function buildAfterActionReport(params: {
  packet: StatPacket;
  matchupId: number;
  managerName: string;
  snapshots?: OddsSnapshot[];
}): AfterActionReport | null {
  const { packet, matchupId, managerName } = params;

  const matchup = packet.matchups.find((m) => m.matchupId === matchupId);
  if (!matchup) return null;

  const isSideA = matchup.a === managerName;
  if (!isSideA && matchup.b !== managerName) return null;

  const team = packet.teams.find((t) => t.manager === managerName);
  const opponentName = isSideA ? matchup.b : matchup.a;
  const opponent = packet.teams.find((t) => t.manager === opponentName);
  if (!team) return null;

  const score = isSideA ? matchup.scoreA : matchup.scoreB;
  const opponentScore = isSideA ? matchup.scoreB : matchup.scoreA;
  const won = score > opponentScore;
  const margin = round2(score - opponentScore);

  const verdict = classify({
    won,
    tied: score === opponentScore,
    team,
    opponent,
    opponentScore,
    matchup,
    isSideA,
  });

  const counterfactual = findCounterfactual(team.benchRegret, margin, won);

  return {
    week: packet.week,
    matchupId,
    manager: managerName,
    opponent: opponentName,
    score,
    opponentScore,
    won,
    verdict,
    verdictDetail: VERDICT_COPY[verdict].explanation,
    swingChart: curveForChart(params.snapshots ?? []),
    isSideA,
    turningPoint: matchup.turningPoint,
    peakWinProb: matchup.peakWinProb,
    clinchAt: matchup.clinchAt,
    comebackIndex: matchup.comebackIndex,
    coaching: {
      actual: team.score,
      optimal: team.optimal,
      efficiency: team.coachingEfficiency,
      pointsLeft: team.benchPointsLeft,
      regrets: team.benchRegret,
      counterfactual,
    },
    luckSplit: {
      ownVariance: round2(score - team.seasonMean),
      opponentVariance: opponent ? round2(opponentScore - opponent.seasonMean) : 0,
      lineupCost: team.benchPointsLeft,
      margin,
    },
    waiverRoi: packet.transactions.waiverRoi.filter((line) => line.manager === managerName),
    nextWeek:
      packet.upcoming.find((game) => game.a === managerName || game.b === managerName) ?? null,
  };
}

/**
 * Classify the result by rule. The ordering matters: a loss your bench would
 * have prevented is that loss even if the opponent also went off, because the
 * bench is the part the manager controlled.
 */
function classify(params: {
  won: boolean;
  tied: boolean;
  team: SeasonTeamLine;
  opponent: SeasonTeamLine | undefined;
  opponentScore: number;
  matchup: MatchupPacket;
  isSideA: boolean;
}): Verdict {
  const { won, tied, team, opponent, opponentScore, matchup } = params;
  if (tied) return 'tied';

  if (won) {
    if (matchup.comebackIndex !== null && matchup.comebackIndex < 0.1) return 'won_a_heist';
    if (matchup.closingUpset) return 'won_on_luck';
    return 'won_on_talent';
  }

  // The bench is the part the manager controlled, so it is checked first.
  if (team.optimal > opponentScore) return 'lost_to_own_bench';

  // A ceiling game: the opponent cleared their own season mean by a wide enough
  // margin that no lineup on this roster was going to matter.
  const opponentOverPerformance = opponent ? opponentScore - opponent.seasonMean : 0;
  const threshold = opponent && opponent.seasonSd > 0 ? opponent.seasonSd : 15;
  if (opponentOverPerformance > threshold) return 'lost_to_a_ceiling_game';

  return 'lost_on_talent';
}

/**
 * The single swap that flips the result — "starting Kincaid over Otton wins by
 * 3.1". Only meaningful for a loss, and only when one swap covers the margin.
 */
function findCounterfactual(regrets: BenchRegret[], margin: number, won: boolean): string | null {
  if (won || regrets.length === 0) return null;
  const deficit = Math.abs(margin);

  const flipping = regrets.find((regret) => regret.delta > deficit);
  if (!flipping) return null;

  const replaced = flipping.replacing ?? 'an empty slot';
  return `Starting ${flipping.player} over ${replaced} wins by ${round2(flipping.delta - deficit)}.`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
