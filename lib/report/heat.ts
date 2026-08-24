/**
 * The heat dial.
 *
 * The commissioner sets a ceiling for the league. Individual managers may opt
 * themselves *down* from it, and never up past it — that asymmetry is the whole
 * safety model, and it is enforced here rather than trusted to the prompt.
 */

export const HEAT_LEVELS = ['locker_room', 'group_chat', 'unhinged'] as const;
export type HeatLevel = (typeof HEAT_LEVELS)[number];

/** Ordered least to most severe, so opt-downs are a min() over this index. */
const SEVERITY: Record<HeatLevel, number> = {
  locker_room: 0,
  group_chat: 1,
  unhinged: 2,
};

export type HeatProfile = {
  level: HeatLevel;
  label: string;
  register: string;
  profanity: 'none' | 'unrestricted';
  guidance: string;
};

export const HEAT_PROFILES: Record<HeatLevel, HeatProfile> = {
  locker_room: {
    level: 'locker_room',
    label: 'Locker Room',
    register: 'Sharp, dry, no profanity.',
    profanity: 'none',
    guidance: [
      'Sharp and dry. Land the joke through precision and understatement, not volume.',
      'No profanity of any kind, including asterisked or euphemistic forms.',
      'Think a beat writer who has watched this team lose for a decade.',
    ].join(' '),
  },
  group_chat: {
    level: 'group_chat',
    label: 'Group Chat',
    register: 'Profane, personal about football.',
    profanity: 'unrestricted',
    guidance: [
      'Profane and personal — about football. Swear naturally, the way the league chat does.',
      'Aim every insult at a roster decision: the start, the sit, the trade, the pick.',
      'This is the default and it is what the report sounds like.',
    ].join(' '),
  },
  unhinged: {
    level: 'unhinged',
    label: 'Unhinged',
    register: 'Sustained abuse, elaborate metaphor.',
    profanity: 'unrestricted',
    guidance: [
      'Sustained, escalating, elaborately constructed abuse. Extended metaphor is welcome.',
      'Reserved for genuine crimes against the sport — the bye-week quarterback, the empty slot.',
      'Stay grounded: the more baroque the metaphor, the more precisely it must attach to a real decision.',
    ].join(' '),
  },
};

export function isHeatLevel(value: string): value is HeatLevel {
  return (HEAT_LEVELS as readonly string[]).includes(value);
}

export function parseHeatLevel(value: string | null | undefined, fallback: HeatLevel = 'group_chat'): HeatLevel {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isHeatLevel(normalized) ? normalized : fallback;
}

/**
 * The effective level for one manager: their own preference, capped by the
 * league ceiling. A manager who opted down is held to Locker Room in every line
 * about them, however hot the rest of the report runs.
 */
export function effectiveHeat(ceiling: HeatLevel, optedDown: boolean): HeatLevel {
  if (!optedDown) return ceiling;
  return SEVERITY.locker_room < SEVERITY[ceiling] ? 'locker_room' : ceiling;
}

export type ManagerHeat = {
  manager: string;
  level: HeatLevel;
  optedDown: boolean;
};

export function resolveManagerHeat(
  ceiling: HeatLevel,
  managers: { manager: string; roastOptDown: boolean }[],
): ManagerHeat[] {
  return managers.map((entry) => ({
    manager: entry.manager,
    optedDown: entry.roastOptDown,
    level: effectiveHeat(ceiling, entry.roastOptDown),
  }));
}

/** The subset held to Locker Room, which is what the fact-check pass enforces. */
export function optedDownManagers(heat: ManagerHeat[]): string[] {
  return heat.filter((entry) => entry.level === 'locker_room' && entry.optedDown).map((e) => e.manager);
}
