/**
 * Seeded PRNG. The odds engine is a Monte Carlo, so reproducibility matters for
 * two reasons: tests need deterministic assertions, and a line that jitters by
 * half a point between two ticks with identical inputs looks broken to users.
 * Seeding per (matchup, tick) makes the same inputs produce the same line.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal. */
  normal(): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  let spare: number | null = null;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    // Marsaglia polar method; it produces two deviates per pass, so we keep one.
    normal(): number {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      let u: number;
      let v: number;
      let s: number;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const factor = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * factor;
      return u * factor;
    },
  };
}

/** Stable 32-bit hash, for deriving a seed from a matchup/tick identity. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  const input = parts.join('|');
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
