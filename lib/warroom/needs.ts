import { SLOT_ELIGIBILITY, scoringSlots, slotAccepts } from '@/lib/compute/lineup';

/**
 * Roster construction: what the roster still needs, and what it is about to
 * break.
 *
 * The board tells you who is good. This tells you who is good *for you*, which
 * diverges sharply by round three — the best player available stops being the
 * right pick the moment a starting slot is going to go empty.
 */

export type RosterPlayer = {
  playerId: string;
  position: string;
  name: string;
  /** NFL bye week, when known. */
  byeWeek?: number | null;
};

export type PositionalNeed = {
  position: string;
  /** Dedicated starting slots for this position. */
  required: number;
  filled: number;
  /** Slots still empty. */
  missing: number;
  /** Flex slots this position can also fill. */
  flexEligible: number;
  /** 0 to 1. Drives how hard the board should push this position. */
  urgency: number;
};

/**
 * What the roster still has to fill.
 *
 * Urgency counts flex slots as partial need rather than full: a second tight end
 * can fill a FLEX, but so can a fourth receiver, so an unfilled flex is not the
 * same emergency as an unfilled TE slot.
 */
export function positionalNeeds(params: {
  roster: RosterPlayer[];
  rosterPositions: string[];
}): PositionalNeed[] {
  const slots = scoringSlots(params.rosterPositions);
  const counts = new Map<string, number>();
  for (const player of params.roster) {
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
  }

  const dedicated = new Map<string, number>();
  const flexSlots: string[] = [];
  for (const slot of slots) {
    if (SLOT_ELIGIBILITY[slot]) flexSlots.push(slot);
    else dedicated.set(slot, (dedicated.get(slot) ?? 0) + 1);
  }

  const positions = new Set<string>([...dedicated.keys(), ...counts.keys()]);
  const needs: PositionalNeed[] = [];

  for (const position of positions) {
    const required = dedicated.get(position) ?? 0;
    const filled = counts.get(position) ?? 0;
    const missing = Math.max(0, required - filled);
    const flexEligible = flexSlots.filter((slot) => slotAccepts(slot, position)).length;

    // A missing dedicated slot is the emergency. Flex adds pressure, but only
    // a fraction of it, and only once the dedicated slots are covered.
    const dedicatedUrgency = required > 0 ? missing / required : 0;
    const flexPressure =
      missing === 0 && flexEligible > 0 && filled <= required ? 0.35 : 0;

    needs.push({
      position,
      required,
      filled,
      missing,
      flexEligible,
      urgency: round2(Math.min(1, dedicatedUrgency + flexPressure)),
    });
  }

  return needs.sort((a, b) => b.urgency - a.urgency || a.position.localeCompare(b.position));
}

export type ByeCollision = {
  week: number;
  position: string;
  /** Players at this position sharing the bye. */
  players: string[];
  /** Starting slots that would go unfilled that week. */
  shortBy: number;
};

/**
 * Bye-week collisions that would actually cost you a starting slot.
 *
 * Two receivers sharing a bye is only a problem if it leaves a slot empty, so
 * this counts what remains startable rather than flagging every shared bye. The
 * false alarms are what make a warning stop being read.
 */
export function byeCollisions(params: {
  roster: RosterPlayer[];
  rosterPositions: string[];
}): ByeCollision[] {
  const slots = scoringSlots(params.rosterPositions);
  const collisions: ByeCollision[] = [];

  const byWeek = new Map<number, RosterPlayer[]>();
  for (const player of params.roster) {
    if (!player.byeWeek) continue;
    const list = byWeek.get(player.byeWeek) ?? [];
    list.push(player);
    byWeek.set(player.byeWeek, list);
  }

  for (const [week, onBye] of byWeek) {
    const available = params.roster.filter((player) => player.byeWeek !== week);

    const byPosition = new Map<string, RosterPlayer[]>();
    for (const player of onBye) {
      const list = byPosition.get(player.position) ?? [];
      list.push(player);
      byPosition.set(player.position, list);
    }

    for (const [position, players] of byPosition) {
      const dedicated = slots.filter((slot) => slot === position).length;
      if (dedicated === 0) continue;

      const stillAvailable = available.filter((player) => player.position === position).length;
      const shortBy = Math.max(0, dedicated - stillAvailable);
      if (shortBy > 0) {
        collisions.push({
          week,
          position,
          players: players.map((player) => player.name),
          shortBy,
        });
      }
    }
  }

  return collisions.sort((a, b) => a.week - b.week || b.shortBy - a.shortBy);
}

/** Starting slots by position, counting only dedicated ones. */
export function startersByPosition(rosterPositions: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const slot of scoringSlots(rosterPositions)) {
    if (SLOT_ELIGIBILITY[slot]) continue;
    out[slot] = (out[slot] ?? 0) + 1;
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
