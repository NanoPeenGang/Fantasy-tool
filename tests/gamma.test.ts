import { describe, expect, it } from 'vitest';
import {
  GammaQuantileTable,
  gammaFromMeanCv,
  gammaQuantile,
  logGamma,
  lowerRegularizedGamma,
  normalCdf,
  normalQuantile,
} from '@/lib/compute/gamma';

describe('gammaFromMeanCv', () => {
  it('recovers the requested mean and coefficient of variation', () => {
    for (const [mean, cv] of [[12, 0.35], [18.5, 0.65], [7, 0.75], [1, 0.6]] as const) {
      const { shape, scale } = gammaFromMeanCv(mean, cv);
      const actualMean = shape * scale;
      const actualSd = Math.sqrt(shape) * scale;
      expect(actualMean).toBeCloseTo(mean, 6);
      expect(actualSd / actualMean).toBeCloseTo(cv, 6);
    }
  });

  it('clamps degenerate inputs rather than producing NaN', () => {
    expect(Number.isFinite(gammaFromMeanCv(0, 0).shape)).toBe(true);
    expect(Number.isFinite(gammaFromMeanCv(-5, 0.5).scale)).toBe(true);
  });
});

describe('logGamma', () => {
  it('matches known factorials', () => {
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 8);
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 6);
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 8);
  });
});

describe('lowerRegularizedGamma', () => {
  it('is a proper CDF: monotone from 0 to 1', () => {
    let previous = 0;
    for (let x = 0; x < 30; x += 0.5) {
      const value = lowerRegularizedGamma(2.5, x);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(value).toBeLessThanOrEqual(1 + 1e-12);
      previous = value;
    }
    expect(lowerRegularizedGamma(2.5, 200)).toBeCloseTo(1, 8);
  });

  it('agrees with the closed form for the exponential case (shape 1)', () => {
    for (const x of [0.5, 1, 2, 5]) {
      expect(lowerRegularizedGamma(1, x)).toBeCloseTo(1 - Math.exp(-x), 9);
    }
  });

  it('crosses the series/continued-fraction boundary smoothly', () => {
    const k = 3;
    const below = lowerRegularizedGamma(k, k + 0.999);
    const above = lowerRegularizedGamma(k, k + 1.001);
    expect(above - below).toBeGreaterThan(0);
    expect(above - below).toBeLessThan(0.01);
  });
});

describe('gammaQuantile', () => {
  it('inverts the CDF', () => {
    for (const shape of [0.5, 1, 2.5, 8.16]) {
      for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
        const x = gammaQuantile(p, shape, 1);
        expect(lowerRegularizedGamma(shape, x)).toBeCloseTo(p, 8);
      }
    }
  });

  it('scales linearly with the scale parameter', () => {
    const unit = gammaQuantile(0.75, 3, 1);
    expect(gammaQuantile(0.75, 3, 4)).toBeCloseTo(unit * 4, 8);
  });

  it('handles the small-shape case where the density is unbounded at zero', () => {
    // CV of 5 gives shape 0.04 — Newton alone diverges here; bisection catches it.
    const { shape, scale } = gammaFromMeanCv(10, 5);
    const x = gammaQuantile(0.5, shape, scale);
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
  });
});

describe('normal helpers', () => {
  it('normalQuantile inverts normalCdf', () => {
    for (const p of [0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 5);
    }
  });

  it('normalCdf hits the standard reference points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
});

describe('GammaQuantileTable', () => {
  it('interpolates close enough to the exact quantile to be invisible in a 10k sim', () => {
    const { shape, scale } = gammaFromMeanCv(14, 0.65);
    const table = new GammaQuantileTable(shape, scale);

    let worst = 0;
    for (let i = 1; i < 100; i += 1) {
      const u = i / 100;
      const exact = gammaQuantile(u, shape, scale);
      worst = Math.max(worst, Math.abs(table.at(u) - exact));
    }
    // Well under a tenth of a fantasy point across the body of the distribution.
    expect(worst).toBeLessThan(0.05);
  });

  it('reports the moments it was built with', () => {
    const { shape, scale } = gammaFromMeanCv(20, 0.5);
    const table = new GammaQuantileTable(shape, scale);
    expect(table.mean()).toBeCloseTo(20, 6);
    expect(table.sd()).toBeCloseTo(10, 6);
  });

  it('is right-skewed: the mean sits above the median', () => {
    const { shape, scale } = gammaFromMeanCv(14, 0.7);
    const table = new GammaQuantileTable(shape, scale);
    expect(table.at(0.5)).toBeLessThan(table.mean());
  });
});
