import type { TradeLine, TransactionLine, WaiverRoiLine } from './types';

/**
 * Transaction analysis, including waiver ROI: points produced by an add minus
 * points produced by the player dropped for them, counted from the acquisition
 * forward. Counting a dropped player's whole season would punish a manager for
 * points scored before they ever owned him.
 */

export type TransactionRecord = {
  transactionId: string;
  type: 'trade' | 'free_agent' | 'waiver';
  week: number;
  rosterIds: number[];
  /** player id -> roster id that received them. */
  adds: Record<string, number>;
  /** player id -> roster id that gave them up. */
  drops: Record<string, number>;
  bid: number | null;
};

export type WeeklyPoints = {
  /** week -> player id -> fantasy points. */
  byWeek: Record<number, Record<string, number>>;
};

export type TransactionContext = {
  transactions: TransactionRecord[];
  points: WeeklyPoints;
  /** roster id -> manager display name. */
  managerByRoster: Record<number, string>;
  /** player id -> display name. */
  playerNames: Record<string, string>;
  throughWeek: number;
};

export function summarizeTransactions(context: TransactionContext): {
  adds: TransactionLine[];
  drops: TransactionLine[];
  trades: TradeLine[];
  waiverRoi: WaiverRoiLine[];
} {
  const { transactions, managerByRoster, playerNames } = context;

  const weekTransactions = transactions.filter((t) => t.week === context.throughWeek);

  const adds: TransactionLine[] = [];
  const drops: TransactionLine[] = [];
  const trades: TradeLine[] = [];

  for (const transaction of weekTransactions) {
    if (transaction.type === 'trade') {
      const received: Record<string, string[]> = {};
      for (const [playerId, rosterId] of Object.entries(transaction.adds)) {
        const manager = managerByRoster[rosterId] ?? `Roster ${rosterId}`;
        (received[manager] ??= []).push(playerNames[playerId] ?? playerId);
      }
      trades.push({ managers: Object.keys(received), received });
      continue;
    }

    for (const [playerId, rosterId] of Object.entries(transaction.adds)) {
      adds.push({
        manager: managerByRoster[rosterId] ?? `Roster ${rosterId}`,
        player: playerNames[playerId] ?? playerId,
        playerId,
        bid: transaction.bid,
      });
    }
    for (const [playerId, rosterId] of Object.entries(transaction.drops)) {
      drops.push({
        manager: managerByRoster[rosterId] ?? `Roster ${rosterId}`,
        player: playerNames[playerId] ?? playerId,
        playerId,
      });
    }
  }

  return { adds, drops, trades, waiverRoi: waiverRoi(context) };
}

/**
 * ROI for every add across the season so far, best first.
 *
 * Pairing an add with a drop uses the same transaction where possible, which is
 * how Sleeper models a waiver claim — the drop that funded the add is the fair
 * comparison. Adds with no corresponding drop score their own points against
 * zero.
 */
export function waiverRoi(context: TransactionContext): WaiverRoiLine[] {
  const { transactions, points, managerByRoster, playerNames, throughWeek } = context;
  const lines: WaiverRoiLine[] = [];

  for (const transaction of transactions) {
    if (transaction.type === 'trade') continue;
    if (transaction.week > throughWeek) continue;

    const droppedIds = Object.keys(transaction.drops);

    for (const [playerId, rosterId] of Object.entries(transaction.adds)) {
      const pointsSinceAdd = pointsBetween(points, playerId, transaction.week, throughWeek);
      const droppedId = droppedIds.shift() ?? null;
      const droppedPoints = droppedId
        ? pointsBetween(points, droppedId, transaction.week, throughWeek)
        : 0;

      lines.push({
        manager: managerByRoster[rosterId] ?? `Roster ${rosterId}`,
        player: playerNames[playerId] ?? playerId,
        playerId,
        pointsSinceAdd: round2(pointsSinceAdd),
        droppedPlayer: droppedId ? playerNames[droppedId] ?? droppedId : null,
        droppedPointsSinceDrop: round2(droppedPoints),
        roi: round2(pointsSinceAdd - droppedPoints),
        addedWeek: transaction.week,
      });
    }
  }

  return lines.sort((a, b) => b.roi - a.roi);
}

function pointsBetween(
  points: WeeklyPoints,
  playerId: string,
  fromWeek: number,
  toWeek: number,
): number {
  let total = 0;
  for (let week = fromWeek; week <= toWeek; week += 1) {
    total += points.byWeek[week]?.[playerId] ?? 0;
  }
  return total;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
