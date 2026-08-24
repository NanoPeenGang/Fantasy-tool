import type { StarterState } from './types';

/**
 * Correlation between starters, which most fantasy tools ignore and which
 * changes upset probability materially.
 *
 * If a manager starts a QB and that QB's WR1, those two scores move together:
 * the joint distribution of the team total is wider than independence implies,
 * so favourites are less safe and underdogs live more often than an independent
 * model says. The tiers below are priors, not fits — they should be re-estimated
 * once there is a season of player_week_stats to fit against.
 */
export const CORRELATION_TIERS = {
  /** Same NFL team, QB <-> pass catcher. The big one. */
  qbPassCatcher: 0.45,
  /** Same NFL team, QB <-> RB. Weak: rushing scores displace passing ones. */
  qbRunningBack: 0.1,
  /** Same NFL team, two pass catchers. They compete for the same targets. */
  passCatcherSameTeam: -0.1,
  /** Opposite sides of the same NFL game: the shootout effect. */
  sameGameOpposing: 0.15,
  /** A defense against any offensive player in its own game. */
  defenseVsOpposingOffense: -0.2,
} as const;

const PASS_CATCHERS = new Set(['WR', 'TE']);

/** Correlation between two starters under the tier priors. */
export function pairCorrelation(a: StarterState, b: StarterState): number {
  if (a.id === b.id) return 1;
  if (!a.team || !b.team) return 0;

  const sameTeam = a.team === b.team;

  if (sameTeam) {
    if (a.position === 'QB' && PASS_CATCHERS.has(b.position)) return CORRELATION_TIERS.qbPassCatcher;
    if (b.position === 'QB' && PASS_CATCHERS.has(a.position)) return CORRELATION_TIERS.qbPassCatcher;
    if (a.position === 'QB' && b.position === 'RB') return CORRELATION_TIERS.qbRunningBack;
    if (b.position === 'QB' && a.position === 'RB') return CORRELATION_TIERS.qbRunningBack;
    if (PASS_CATCHERS.has(a.position) && PASS_CATCHERS.has(b.position)) {
      return CORRELATION_TIERS.passCatcherSameTeam;
    }
    if (a.position === 'DEF' || b.position === 'DEF') return 0;
    return 0;
  }

  // Facing each other in the same NFL game.
  const opposed = a.opponentTeam === b.team || b.opponentTeam === a.team;
  if (!opposed) return 0;

  if (a.position === 'DEF' || b.position === 'DEF') {
    return CORRELATION_TIERS.defenseVsOpposingOffense;
  }
  return CORRELATION_TIERS.sameGameOpposing;
}

/**
 * Build the correlation matrix across every starter in a matchup — both teams
 * together, because cross-team correlation is what makes a shootout lift both
 * scores at once and is exactly the case independence gets wrong.
 */
export function correlationMatrix(starters: StarterState[]): number[][] {
  const n = starters.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    (matrix[i] as number[])[i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const rho = pairCorrelation(starters[i] as StarterState, starters[j] as StarterState);
      (matrix[i] as number[])[j] = rho;
      (matrix[j] as number[])[i] = rho;
    }
  }
  return matrix;
}

/**
 * Cholesky factorisation with ridge repair.
 *
 * A matrix assembled from pairwise priors is not guaranteed positive definite —
 * three players can be given correlations that no joint distribution admits. We
 * do not fail on that; we add an increasing ridge to the diagonal and rescale
 * back to unit diagonal, which is the cheap stand-in for a nearest-correlation
 * projection and converges in one or two steps for matrices this small.
 */
export function cholesky(matrix: number[][]): number[][] {
  const n = matrix.length;
  if (n === 0) return [];

  let working = matrix.map((row) => [...row]);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const L = tryCholesky(working);
    if (L) return L;
    const ridge = 10 ** (-6 + attempt);
    working = ridgeAndRescale(matrix, ridge);
  }

  // Give up on correlation rather than on producing a line: the identity is
  // the independence assumption, which is wrong but not unstable.
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

function tryCholesky(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = (matrix[i] as number[])[j] as number;
      for (let k = 0; k < j; k += 1) {
        sum -= (L[i] as number[])[k]! * (L[j] as number[])[k]!;
      }
      if (i === j) {
        if (sum <= 1e-12) return null;
        (L[i] as number[])[j] = Math.sqrt(sum);
      } else {
        (L[i] as number[])[j] = sum / ((L[j] as number[])[j] as number);
      }
    }
  }
  return L;
}

function ridgeAndRescale(matrix: number[][], ridge: number): number[][] {
  const n = matrix.length;
  const out = matrix.map((row, i) =>
    row.map((value, j) => (i === j ? value + ridge : value)),
  );
  const scale = 1 + ridge;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      (out[i] as number[])[j] = ((out[i] as number[])[j] as number) / scale;
    }
    (out[i] as number[])[i] = 1;
  }
  return out;
}

/** z = L * standardNormals, giving correlated standard normals. */
export function applyCholesky(L: number[][], standardNormals: number[]): number[] {
  const n = L.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const row = L[i] as number[];
    for (let k = 0; k <= i; k += 1) {
      sum += (row[k] as number) * (standardNormals[k] as number);
    }
    out[i] = sum;
  }
  return out;
}
