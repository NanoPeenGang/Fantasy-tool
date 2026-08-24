/**
 * Gamma distribution utilities, parameterised by mean and coefficient of
 * variation rather than shape/scale — CV is the quantity we actually have
 * priors for, per position.
 *
 * Weekly fantasy scoring is right-skewed: a normal underprices ceiling games and
 * misprices exactly the tails that decide close matchups. For mean mu and CV c:
 *
 *   variance = (c * mu)^2      shape k = 1 / c^2      scale theta = mu * c^2
 */

export type GammaParams = { shape: number; scale: number };

export function gammaFromMeanCv(mean: number, cv: number): GammaParams {
  const safeMean = Math.max(mean, 1e-6);
  const safeCv = Math.min(Math.max(cv, 1e-3), 5);
  const shape = 1 / (safeCv * safeCv);
  return { shape, scale: safeMean / shape };
}

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula keeps precision for small arguments.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i += 1) {
    a += (LANCZOS[i] as number) / (z + i + 1);
  }
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularised lower incomplete gamma P(k, x). Series expansion below the
 * shape+1 crossover, continued fraction above it — the standard split, because
 * each converges slowly in the other's region.
 */
export function lowerRegularizedGamma(k: number, x: number): number {
  if (x <= 0) return 0;
  if (k <= 0) return 1;

  if (x < k + 1) {
    let sum = 1 / k;
    let term = sum;
    for (let i = 1; i < 500; i += 1) {
      term *= x / (k + i);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + k * Math.log(x) - logGamma(k));
  }

  // Lentz's algorithm for the continued fraction of Q(k, x).
  const tiny = 1e-300;
  let b = x + 1 - k;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - k);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  const q = Math.exp(-x + k * Math.log(x) - logGamma(k)) * h;
  return 1 - q;
}

/**
 * Inverse CDF. Wilson-Hilferty gives the starting point; Newton on P(k, x)
 * refines it, with bisection fallback when Newton steps outside the bracket
 * (which it will for small shape, where the density is unbounded at zero).
 */
export function gammaQuantile(p: number, shape: number, scale: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  const k = shape;
  let x = wilsonHilferty(p, k);
  if (!Number.isFinite(x) || x <= 0) x = k;

  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;

  for (let i = 0; i < 60; i += 1) {
    const cdf = lowerRegularizedGamma(k, x);
    if (cdf < p) lo = Math.max(lo, x);
    else hi = Math.min(hi, x);

    const err = cdf - p;
    if (Math.abs(err) < 1e-12) break;

    const logPdf = (k - 1) * Math.log(x) - x - logGamma(k);
    const pdf = Math.exp(logPdf);
    let next = pdf > 1e-300 ? x - err / pdf : Number.NaN;

    if (!Number.isFinite(next) || next <= lo || next >= hi) {
      next = Number.isFinite(hi) ? (lo + hi) / 2 : Math.max(x * 2, lo + 1);
    }
    if (Math.abs(next - x) < 1e-14 * Math.max(1, x)) {
      x = next;
      break;
    }
    x = next;
  }

  return x * scale;
}

function wilsonHilferty(p: number, k: number): number {
  const z = normalQuantile(p);
  const term = 1 - 1 / (9 * k) + (z * Math.sqrt(1 / (9 * k)));
  return k * term * term * term;
}

/** Acklam's inverse normal CDF. Accurate to ~1e-9, which is well past need. */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Standard normal CDF, via erf. The copula's normal-to-uniform step. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, sufficient for a uniform we then quantise.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Precomputed quantile table for one gamma.
 *
 * Inverting the gamma CDF per sample is the hot path — 10,000 iterations times
 * ~20 starters times a Newton solve is enough to blow a 60-second tick budget.
 * Building a table once per player per tick and interpolating turns each sample
 * into two lookups. Resolution is chosen so interpolation error is far below the
 * sampling noise of 10k iterations.
 */
export class GammaQuantileTable {
  private readonly values: Float64Array;

  constructor(
    readonly shape: number,
    readonly scale: number,
    private readonly resolution = 1024,
  ) {
    this.values = new Float64Array(resolution + 1);
    for (let i = 0; i <= resolution; i += 1) {
      // Clamp the endpoints: the true quantile at u=1 is infinite.
      const u = Math.min(Math.max(i / resolution, 1e-6), 1 - 1e-6);
      this.values[i] = gammaQuantile(u, shape, scale);
    }
  }

  /** Linear interpolation between table points. */
  at(u: number): number {
    const clamped = Math.min(Math.max(u, 0), 1);
    const pos = clamped * this.resolution;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, this.resolution);
    const frac = pos - lo;
    const a = this.values[lo] as number;
    const b = this.values[hi] as number;
    return a + (b - a) * frac;
  }

  mean(): number {
    return this.shape * this.scale;
  }

  sd(): number {
    return Math.sqrt(this.shape) * this.scale;
  }
}
