/**
 * Domain types shared by every compute module. Nothing in lib/compute imports
 * the database or the network — these are pure functions over these shapes, so
 * the whole engine is testable without a Postgres or a Sleeper key.
 */

export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF' | (string & {});

export type GameStatus = 'pre' | 'live' | 'final';

export type PlayerRef = {
  id: string;
  name: string;
  position: Position;
  /** NFL team abbreviation. Drives the correlation matrix. */
  team: string | null;
  injuryStatus: string | null;
};

/** A player as the odds engine sees them for one week. */
export type StarterState = PlayerRef & {
  /** Projected full-game fantasy points. */
  projection: number;
  /** Points already banked this week. */
  actual: number;
  gameStatus: GameStatus;
  /** 0 at kickoff, 1 at the final whistle. */
  gamePctElapsed: number;
  /**
   * Per-player coefficient of variation where the sample supported a fit;
   * null falls back to the positional default.
   */
  cv?: number | null;
  /** Opponent NFL team, for the shootout correlation tier. */
  opponentTeam?: string | null;
};

export type LineupSlot = {
  /** Slot label from the league's roster_positions, e.g. 'RB', 'FLEX'. */
  slot: string;
  index: number;
};

export type TeamWeek = {
  rosterId: number;
  managerId: string;
  manager: string;
  teamName: string;
  /** Player ids actually started. */
  starters: string[];
  /** Every player on the roster, bench included. */
  players: string[];
  /** player id -> fantasy points scored this week. */
  points: Record<string, number>;
  /** Sum of started players' points, as Sleeper reports it. */
  score: number;
};

export type MatchupWeek = {
  matchupId: number;
  a: TeamWeek;
  /** Null when a roster has no opponent this week. */
  b: TeamWeek | null;
};

export type OddsLine = {
  winProbA: number;
  /** Median (score_a - score_b). Negative means A is favoured. */
  spread: number;
  total: number;
  moneylineA: number;
  moneylineB: number;
  meanA: number;
  meanB: number;
  sdA: number;
  sdB: number;
};

export type OddsSnapshot = OddsLine & {
  capturedAt: string;
  phase: 'open' | 'live' | 'close';
  /** Score state when the snapshot was taken, for turning-point attribution. */
  detail?: {
    scoreA: number;
    scoreB: number;
    /** player id -> points banked at capture time. */
    playerPoints?: Record<string, number>;
  };
};

export type AllPlayRecord = { w: number; l: number; t: number };

/** One legal swap the manager could have made, with what it was worth. */
export type BenchRegret = {
  player: string;
  playerId: string;
  points: number;
  /** The started player this swap displaces, or null for an empty slot. */
  replacing: string | null;
  replacingPoints: number;
  delta: number;
  slot: string;
};

export type SeasonTeamLine = {
  managerId: string;
  manager: string;
  teamName: string;
  rosterId: number;
  score: number;
  optimal: number;
  coachingEfficiency: number;
  benchPointsLeft: number;
  /**
   * Worst swaps first. The recap and the AAR both quote these directly ("started
   * a tight end who produced 3.2 while 24.1 rotted on the bench"), so the
   * player-level numbers behind a coaching claim have to live in the packet —
   * otherwise the fact-check pass has nothing to verify them against and cuts
   * the best line in the report.
   */
  benchRegret: BenchRegret[];
  allPlay: AllPlayRecord;
  record: { w: number; l: number; t: number };
  pf: number;
  pa: number;
  luckIndex: number;
  powerScore: number;
  powerRank: number;
  rankDelta: number;
  seasonMean: number;
  seasonSd: number;
};

export type TurningPoint = {
  player: string;
  playerId: string | null;
  swing: number;
  at: string;
  description: string;
};

export type MatchupPacket = {
  matchupId: number;
  a: string;
  b: string;
  scoreA: number;
  scoreB: number;
  opening: { winProbA: number; spread: number; total: number } | null;
  closingUpset: boolean;
  /**
   * The *loser's* high-water mark — "led 94% at 4:12 and lost". The winner's
   * peak is 1.0 in every completed matchup, so it is not the one worth keeping.
   */
  peakWinProb: { manager: string; value: number; at: string } | null;
  comebackIndex: number | null;
  clinchAt: string | null;
  turningPoint: TurningPoint | null;
  coachingLoss: boolean;
  marginVsBench: string;
  deadOnArrival: boolean;
};

export type AwardEvidence = Record<string, unknown>;

export type Award = {
  key: string;
  label: string;
  manager: string;
  managerId: string;
  value: number;
  evidence: AwardEvidence;
};

export type Storyline = {
  threadKey: string;
  summary: string;
  sinceWeek: number;
  lastReferencedWeek: number;
  status: 'live' | 'resolved' | 'retired';
  managerIds: string[];
};

export type StatPacket = {
  leagueId: string;
  leagueName: string;
  season: string;
  week: number;
  computedAt: string;
  teams: SeasonTeamLine[];
  matchups: MatchupPacket[];
  awards: Award[];
  transactions: {
    adds: TransactionLine[];
    drops: TransactionLine[];
    trades: TradeLine[];
    waiverRoi: WaiverRoiLine[];
  };
  hotPlayers: HotPlayer[];
  teamOfTheWeek: TeamOfTheWeek | null;
  upcoming: UpcomingMatchup[];
  storylinesLive: Storyline[];
};

export type TransactionLine = {
  manager: string;
  player: string;
  playerId: string;
  bid?: number | null;
};

export type TradeLine = {
  managers: string[];
  /** manager display name -> players received. */
  received: Record<string, string[]>;
};

export type WaiverRoiLine = {
  manager: string;
  player: string;
  playerId: string;
  pointsSinceAdd: number;
  droppedPlayer: string | null;
  droppedPointsSinceDrop: number;
  roi: number;
  addedWeek: number;
};

export type HotPlayer = {
  player: string;
  playerId: string;
  position: string;
  points: number;
  rosteredBy: string | null;
  started: boolean;
  vsProjection: number | null;
};

export type TeamOfTheWeek = {
  slots: { slot: string; player: string; playerId: string; points: number; manager: string; started: boolean }[];
  total: number;
  startedTotal: number;
};

export type UpcomingMatchup = {
  a: string;
  b: string;
  openingLine: { winProbA: number; spread: number; total: number } | null;
  storylineHook: string | null;
};
