/**
 * League scoring.
 *
 * Sleeper's scoring_settings is a flat map of stat key -> points per unit, so
 * fantasy points are a dot product against a stat line. The matchups endpoint
 * already returns players_points computed this way, and that is what we use for
 * anything retroactive. This module exists for the forward-looking half:
 * projections arrive as stat lines (or as another site's points under someone
 * else's scoring), and have to be re-scored against *this* league's settings
 * before they mean anything.
 */

export type StatLine = Record<string, number>;
export type ScoringSettings = Record<string, number>;

/** Bonus keys are thresholds, not per-unit rates, and need separate handling. */
const BONUS_KEYS: Record<string, { statKey: string; threshold: number }> = {
  bonus_rec_yd_100: { statKey: 'rec_yd', threshold: 100 },
  bonus_rush_yd_100: { statKey: 'rush_yd', threshold: 100 },
  bonus_pass_yd_300: { statKey: 'pass_yd', threshold: 300 },
  bonus_rec_yd_200: { statKey: 'rec_yd', threshold: 200 },
  bonus_rush_yd_200: { statKey: 'rush_yd', threshold: 200 },
  bonus_pass_yd_400: { statKey: 'pass_yd', threshold: 400 },
};

export function applyScoring(stats: StatLine, settings: ScoringSettings): number {
  let total = 0;
  for (const [key, perUnit] of Object.entries(settings)) {
    if (!perUnit) continue;

    const bonus = BONUS_KEYS[key];
    if (bonus) {
      if ((stats[bonus.statKey] ?? 0) >= bonus.threshold) total += perUnit;
      continue;
    }

    const value = stats[key];
    if (typeof value === 'number' && Number.isFinite(value)) total += value * perUnit;
  }
  return round2(total);
}

/**
 * How much a league's settings differ from a baseline, per position. Used by the
 * war room to explain why its board is not the generic board every site shows:
 * a TE-premium half-PPR board really is a different board.
 */
export const HALF_PPR_BASELINE: ScoringSettings = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1,
  rush_yd: 0.1, rush_td: 6,
  rec: 0.5, rec_yd: 0.1, rec_td: 6,
  fum_lost: -2,
};

export type ScoringProfile = {
  ppr: number;
  tePremium: number;
  passTdPoints: number;
  isSuperflex: boolean;
  /** Human-readable summary for the UI and the report's system prompt. */
  label: string;
};

export function scoringProfile(
  settings: ScoringSettings,
  rosterPositions: string[] = [],
): ScoringProfile {
  const ppr = settings.rec ?? 0;
  const teBonus = settings.bonus_rec_te ?? 0;
  const passTd = settings.pass_td ?? 4;
  const isSuperflex = rosterPositions.some((p) => p === 'SUPER_FLEX' || p === 'QB2');

  const parts: string[] = [];
  if (ppr >= 1) parts.push('full PPR');
  else if (ppr > 0) parts.push(`${ppr} PPR`);
  else parts.push('standard');
  if (teBonus > 0) parts.push(`TE premium (+${teBonus})`);
  if (passTd !== 4) parts.push(`${passTd}pt pass TD`);
  if (isSuperflex) parts.push('superflex');

  return {
    ppr,
    tePremium: teBonus,
    passTdPoints: passTd,
    isSuperflex,
    label: parts.join(', '),
  };
}

/**
 * Re-score a projection expressed in another site's points. Without a stat line
 * this is only an approximation — the reception and pass-TD deltas are the two
 * that move a projection enough to matter, so those are what we adjust.
 */
export function rescaleProjection(params: {
  points: number;
  assumedSettings: ScoringSettings;
  targetSettings: ScoringSettings;
  expectedReceptions?: number;
  expectedPassTds?: number;
}): number {
  const { points, assumedSettings, targetSettings } = params;
  let adjusted = points;

  const pprDelta = (targetSettings.rec ?? 0) - (assumedSettings.rec ?? 0);
  if (pprDelta !== 0 && params.expectedReceptions) {
    adjusted += pprDelta * params.expectedReceptions;
  }

  const passTdDelta = (targetSettings.pass_td ?? 4) - (assumedSettings.pass_td ?? 4);
  if (passTdDelta !== 0 && params.expectedPassTds) {
    adjusted += passTdDelta * params.expectedPassTds;
  }

  return round2(Math.max(adjusted, 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
