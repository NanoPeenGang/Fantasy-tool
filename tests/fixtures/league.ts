import type {
  MatchupWeek,
  OddsSnapshot,
  PlayerRef,
  TeamWeek,
} from '@/lib/compute/types';
import type { SeasonHistory } from '@/lib/compute/standings';

/**
 * A four-team league with a full week 3, built so every downstream metric has an
 * unambiguous expected value. Sleeper's live API is not reachable from CI, so
 * this fixture is the contract the compute layer is tested against.
 *
 * The week is designed to produce one of each interesting outcome:
 *   - dave  loses a game his own bench would have won  (coaching loss, Bagholder)
 *   - kim   wins from a 6% low-water mark              (Heist, Cardiac Kid)
 *   - raj   posts the low score of the week            (Sh*t the Bed)
 *   - sam   starts a player already ruled out          (Coward)
 */

export const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN'];

export const PLAYERS: Record<string, PlayerRef> = {
  // Dave
  d_qb: { id: 'd_qb', name: 'Josh Allen', position: 'QB', team: 'BUF', injuryStatus: null },
  d_rb1: { id: 'd_rb1', name: 'James Cook', position: 'RB', team: 'BUF', injuryStatus: null },
  d_rb2: { id: 'd_rb2', name: 'Rico Dowdle', position: 'RB', team: 'DAL', injuryStatus: null },
  d_wr1: { id: 'd_wr1', name: 'Amon-Ra St. Brown', position: 'WR', team: 'DET', injuryStatus: null },
  d_wr2: { id: 'd_wr2', name: 'Jauan Jennings', position: 'WR', team: 'SF', injuryStatus: null },
  d_te: { id: 'd_te', name: 'Cade Otton', position: 'TE', team: 'TB', injuryStatus: null },
  d_flex: { id: 'd_flex', name: 'Tyler Boyd', position: 'WR', team: 'TEN', injuryStatus: null },
  d_bench1: { id: 'd_bench1', name: 'Dalton Kincaid', position: 'TE', team: 'BUF', injuryStatus: null },
  d_bench2: { id: 'd_bench2', name: 'Blake Ferguson', position: 'TE', team: 'MIA', injuryStatus: null },

  // Kim
  k_qb: { id: 'k_qb', name: 'Jalen Hurts', position: 'QB', team: 'PHI', injuryStatus: null },
  k_rb1: { id: 'k_rb1', name: 'Saquon Barkley', position: 'RB', team: 'PHI', injuryStatus: null },
  k_rb2: { id: 'k_rb2', name: 'Tony Pollard', position: 'RB', team: 'TEN', injuryStatus: null },
  k_wr1: { id: 'k_wr1', name: 'A.J. Brown', position: 'WR', team: 'PHI', injuryStatus: null },
  k_wr2: { id: 'k_wr2', name: 'Jordan Addison', position: 'WR', team: 'MIN', injuryStatus: null },
  k_te: { id: 'k_te', name: 'Dallas Goedert', position: 'TE', team: 'PHI', injuryStatus: null },
  k_flex: { id: 'k_flex', name: 'Khalil Shakir', position: 'WR', team: 'BUF', injuryStatus: null },
  k_bench1: { id: 'k_bench1', name: 'Roschon Johnson', position: 'RB', team: 'CHI', injuryStatus: null },

  // Raj
  r_qb: { id: 'r_qb', name: 'Bryce Young', position: 'QB', team: 'CAR', injuryStatus: null },
  r_rb1: { id: 'r_rb1', name: 'Zach Charbonnet', position: 'RB', team: 'SEA', injuryStatus: null },
  r_rb2: { id: 'r_rb2', name: 'Ty Chandler', position: 'RB', team: 'MIN', injuryStatus: null },
  r_wr1: { id: 'r_wr1', name: 'Adam Thielen', position: 'WR', team: 'CAR', injuryStatus: null },
  r_wr2: { id: 'r_wr2', name: 'Elijah Moore', position: 'WR', team: 'CLE', injuryStatus: null },
  r_te: { id: 'r_te', name: 'Noah Fant', position: 'TE', team: 'SEA', injuryStatus: null },
  r_flex: { id: 'r_flex', name: 'Demarcus Robinson', position: 'WR', team: 'LAR', injuryStatus: null },
  r_bench1: { id: 'r_bench1', name: 'Jerome Ford', position: 'RB', team: 'CLE', injuryStatus: null },

  // Sam
  s_qb: { id: 's_qb', name: 'Patrick Mahomes', position: 'QB', team: 'KC', injuryStatus: null },
  s_rb1: { id: 's_rb1', name: 'Isiah Pacheco', position: 'RB', team: 'KC', injuryStatus: 'Out' },
  s_rb2: { id: 's_rb2', name: 'Kareem Hunt', position: 'RB', team: 'KC', injuryStatus: null },
  s_wr1: { id: 's_wr1', name: 'Rashee Rice', position: 'WR', team: 'KC', injuryStatus: null },
  s_wr2: { id: 's_wr2', name: 'Xavier Worthy', position: 'WR', team: 'KC', injuryStatus: null },
  s_te: { id: 's_te', name: 'Travis Kelce', position: 'TE', team: 'KC', injuryStatus: null },
  s_flex: { id: 's_flex', name: 'Justice Hill', position: 'RB', team: 'BAL', injuryStatus: null },
  s_bench1: { id: 's_bench1', name: 'Tank Bigsby', position: 'RB', team: 'JAX', injuryStatus: null },
};

/**
 * Dave benched Kincaid (24.1) and started Ferguson-tier production at TE (3.2),
 * losing by 6.4 to Kim. His optimal lineup clears Kim's score, which is what
 * makes this a coaching loss.
 */
const DAVE: TeamWeek = {
  rosterId: 1,
  managerId: 'mgr_dave',
  manager: 'Dave',
  teamName: 'Dave Matthews Band',
  starters: ['d_qb', 'd_rb1', 'd_rb2', 'd_wr1', 'd_wr2', 'd_te', 'd_flex'],
  players: [
    'd_qb', 'd_rb1', 'd_rb2', 'd_wr1', 'd_wr2', 'd_te', 'd_flex', 'd_bench1', 'd_bench2',
  ],
  points: {
    d_qb: 24.6, d_rb1: 18.2, d_rb2: 11.4, d_wr1: 21.3, d_wr2: 8.7,
    d_te: 3.2, d_flex: 6.1, d_bench1: 24.1, d_bench2: 1.4,
  },
  score: 93.5,
};

const KIM: TeamWeek = {
  rosterId: 2,
  managerId: 'mgr_kim',
  manager: 'Kim',
  teamName: 'Hurts Donut',
  starters: ['k_qb', 'k_rb1', 'k_rb2', 'k_wr1', 'k_wr2', 'k_te', 'k_flex'],
  players: ['k_qb', 'k_rb1', 'k_rb2', 'k_wr1', 'k_wr2', 'k_te', 'k_flex', 'k_bench1'],
  points: {
    k_qb: 27.8, k_rb1: 22.4, k_rb2: 9.1, k_wr1: 19.6, k_wr2: 7.3,
    k_te: 8.9, k_flex: 4.8, k_bench1: 2.1,
  },
  score: 99.9,
};

const RAJ: TeamWeek = {
  rosterId: 3,
  managerId: 'mgr_raj',
  manager: 'Raj',
  teamName: 'Panther Optimism',
  starters: ['r_qb', 'r_rb1', 'r_rb2', 'r_wr1', 'r_wr2', 'r_te', 'r_flex'],
  players: ['r_qb', 'r_rb1', 'r_rb2', 'r_wr1', 'r_wr2', 'r_te', 'r_flex', 'r_bench1'],
  points: {
    r_qb: 9.4, r_rb1: 7.2, r_rb2: 4.1, r_wr1: 11.8, r_wr2: 5.6,
    r_te: 6.3, r_flex: 3.9, r_bench1: 8.8,
  },
  score: 48.3,
};

/** Sam started Pacheco, who was ruled Out before kickoff, and got a zero. */
const SAM: TeamWeek = {
  rosterId: 4,
  managerId: 'mgr_sam',
  manager: 'Sam',
  teamName: 'Chiefs Kingdom Come',
  starters: ['s_qb', 's_rb1', 's_rb2', 's_wr1', 's_wr2', 's_te', 's_flex'],
  players: ['s_qb', 's_rb1', 's_rb2', 's_wr1', 's_wr2', 's_te', 's_flex', 's_bench1'],
  points: {
    s_qb: 21.1, s_rb1: 0, s_rb2: 12.6, s_wr1: 16.4, s_wr2: 9.2,
    s_te: 14.8, s_flex: 5.3, s_bench1: 10.5,
  },
  score: 79.4,
};

export const TEAMS = { DAVE, KIM, RAJ, SAM };

export const MATCHUPS: MatchupWeek[] = [
  { matchupId: 1, a: DAVE, b: KIM },
  { matchupId: 2, a: RAJ, b: SAM },
];

/**
 * Three weeks of scores. Week 3 matches the matchups above; weeks 1 and 2 exist
 * so the season-level metrics (all-play, luck, power) have something to chew on.
 */
export const HISTORY: SeasonHistory = {
  weeks: [
    // Week 1: Dave beats Kim, Sam beats Raj.
    { week: 1, rosterId: 1, score: 112.4, opponentRosterId: 2, opponentScore: 98.2 },
    { week: 1, rosterId: 2, score: 98.2, opponentRosterId: 1, opponentScore: 112.4 },
    { week: 1, rosterId: 3, score: 76.5, opponentRosterId: 4, opponentScore: 104.1 },
    { week: 1, rosterId: 4, score: 104.1, opponentRosterId: 3, opponentScore: 76.5 },
    // Week 2: Kim beats Dave, Sam beats Raj again.
    { week: 2, rosterId: 1, score: 88.9, opponentRosterId: 2, opponentScore: 121.7 },
    { week: 2, rosterId: 2, score: 121.7, opponentRosterId: 1, opponentScore: 88.9 },
    { week: 2, rosterId: 3, score: 81.3, opponentRosterId: 4, opponentScore: 95.6 },
    { week: 2, rosterId: 4, score: 95.6, opponentRosterId: 3, opponentScore: 81.3 },
    // Week 3: the week under test.
    { week: 3, rosterId: 1, score: DAVE.score, opponentRosterId: 2, opponentScore: KIM.score },
    { week: 3, rosterId: 2, score: KIM.score, opponentRosterId: 1, opponentScore: DAVE.score },
    { week: 3, rosterId: 3, score: RAJ.score, opponentRosterId: 4, opponentScore: SAM.score },
    { week: 3, rosterId: 4, score: SAM.score, opponentRosterId: 3, opponentScore: RAJ.score },
  ],
};

function snapshot(
  minute: number,
  winProbA: number,
  scoreA: number,
  scoreB: number,
  playerPoints: Record<string, number>,
): OddsSnapshot {
  return {
    capturedAt: new Date(Date.UTC(2026, 9, 18, 17, minute)).toISOString(),
    phase: minute === 0 ? 'open' : 'live',
    winProbA,
    spread: scoreA - scoreB,
    total: scoreA + scoreB,
    moneylineA: -110,
    moneylineB: -110,
    meanA: 100,
    meanB: 100,
    sdA: 18,
    sdB: 18,
    detail: { scoreA, scoreB, playerPoints },
  };
}

/**
 * Dave's curve: opened a slight favourite, peaked at 94%, then Kim's Barkley
 * game flipped it. Kim's low-water mark of 6% is the Heist.
 */
export const ODDS_BY_MATCHUP: Record<number, OddsSnapshot[]> = {
  1: [
    snapshot(0, 0.58, 0, 0, { d_qb: 0, k_rb1: 0 }),
    snapshot(60, 0.72, 40.1, 28.4, { d_qb: 12.2, k_rb1: 3.1 }),
    snapshot(120, 0.94, 71.6, 44.2, { d_qb: 24.6, k_rb1: 6.0 }),
    snapshot(180, 0.41, 88.2, 84.5, { d_qb: 24.6, k_rb1: 18.9 }),
    snapshot(240, 0.06, 93.5, 95.1, { d_qb: 24.6, k_rb1: 22.4 }),
    snapshot(300, 0.0, 93.5, 99.9, { d_qb: 24.6, k_rb1: 22.4 }),
  ],
  // Raj was never alive: dead on arrival.
  2: [
    snapshot(0, 0.22, 0, 0, { r_qb: 0, s_qb: 0 }),
    snapshot(120, 0.14, 28.1, 44.6, { r_qb: 6.1, s_qb: 14.2 }),
    snapshot(300, 0.0, 48.3, 79.4, { r_qb: 9.4, s_qb: 21.1 }),
  ],
};

export const PREVIOUS_POWER_RANKS: Record<string, number> = {
  mgr_dave: 2,
  mgr_kim: 3,
  mgr_raj: 4,
  mgr_sam: 1,
};
