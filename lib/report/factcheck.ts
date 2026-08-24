import type { Award, StatPacket } from '@/lib/compute/types';

/**
 * Pass 3: fact check.
 *
 * Every numeric claim and every named attribution in a generated draft is
 * verified against the stat packet. Unverifiable claims are **cut, not
 * corrected** — a fabricated stat in a league recap is the fastest way to lose a
 * commissioner's trust, because eleven people will check it, and a silently
 * corrected number is worse than a missing sentence.
 *
 * This pass is deliberately pure and deterministic. It is the one part of the
 * generation pipeline that must never itself be a language model: a model that
 * hallucinates cannot be the thing that catches hallucinations.
 */

export type FactIndex = {
  /** Every number the packet supports, at 2dp, for exact membership. */
  numbers: Set<string>;
  /** The same values numerically, for tolerance and rounding comparisons. */
  knownValues: number[];
  /** Probabilities, kept separately so "94%" can be checked against 0.94. */
  probabilities: number[];
  /** Manager display names and team names. */
  managers: Set<string>;
  /** Player names on any roster this week. */
  players: Set<string>;
  /** Award labels in play. */
  awards: Set<string>;
  teamCount: number;
  week: number;
  season: string;
};

export type Violation = {
  kind: 'unverifiable_number' | 'unknown_name' | 'banned_topic' | 'heat_exceeded';
  detail: string;
  sentence: string;
};

export type FactCheckResult = {
  /** The draft with every offending sentence removed. */
  body: string;
  violations: Violation[];
  /** Claims checked, and how many failed. A rising rate means drift. */
  stats: {
    sentences: number;
    numericClaims: number;
    cutSentences: number;
    failureRate: number;
  };
};

/**
 * The one content rule (spec 8.3): roasts target fantasy sins only. This is a
 * product decision before it is a taste decision — specific football-grounded
 * abuse is funnier than generic insult, and it is what keeps the report
 * shareable rather than the thing that gets the group chat locked.
 *
 * The generator is told this in its system prompt; this list is the enforcement
 * that does not depend on the model having complied.
 */
export const BANNED_TOPIC_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'appearance', pattern: /\b(fat|obese|ugly|bald(ing)?|skinny|weight|receding|acne|teeth)\b/i },
  { label: 'family', pattern: /\b(wife|husband|girlfriend|boyfriend|ex-wife|ex-husband|divorce|kids|children|son|daughter|mother|father|mom|dad|marriage)\b/i },
  { label: 'work', pattern: /\b(fired|unemployed|jobless|salary|boss|laid off|career|promotion)\b/i },
  { label: 'finances', pattern: /\b(broke|bankrupt|debt|mortgage|rent money|credit score|paycheck)\b/i },
  { label: 'health', pattern: /\b(cancer|depress(ed|ion)|therapy|medication|rehab|alcoholic|addiction|overdose|disabled)\b/i },
];

/** Used only to enforce the Locker Room heat level, which permits none. */
const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|ass(hole)?|dick\w*|cunt\w*|piss\w*|bastard\w*|damn|goddamn|prick\w*|douche\w*)\b/i;

export function buildFactIndex(
  packet: StatPacket,
  extras: { seasonAwardCounts?: Record<string, Record<string, number>> } = {},
): FactIndex {
  const numbers = new Set<string>();
  const probabilities: number[] = [];
  const managers = new Set<string>();
  const players = new Set<string>();
  const awards = new Set<string>();

  const add = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    numbers.add(key(value));
    numbers.add(key(Math.abs(value)));
  };
  const addProbability = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    probabilities.push(value);
    add(value);
    add(value * 100);
  };

  for (const team of packet.teams) {
    managers.add(team.manager);
    if (team.teamName) managers.add(team.teamName);
    add(team.score);
    add(team.optimal);
    add(team.benchPointsLeft);
    add(team.pf);
    add(team.pa);
    add(team.luckIndex);
    add(team.powerScore);
    add(team.powerRank);
    add(team.rankDelta);
    add(team.seasonMean);
    add(team.seasonSd);
    add(team.record.w);
    add(team.record.l);
    add(team.record.t);
    add(team.allPlay.w);
    add(team.allPlay.l);
    add(team.allPlay.t);
    addProbability(team.coachingEfficiency);
    // The gap between what a roster could score and what it did is a claim the
    // recap makes constantly; it is derivable, so it is allowed.
    add(team.optimal - team.score);

    // Bench regrets carry the player-level numbers behind every coaching roast.
    for (const regret of team.benchRegret) {
      players.add(regret.player);
      if (regret.replacing) players.add(regret.replacing);
      add(regret.points);
      add(regret.replacingPoints);
      add(regret.delta);
    }
  }

  for (const matchup of packet.matchups) {
    add(matchup.scoreA);
    add(matchup.scoreB);
    add(matchup.scoreA - matchup.scoreB);
    addProbability(matchup.comebackIndex);
    if (matchup.opening) {
      addProbability(matchup.opening.winProbA);
      addProbability(1 - matchup.opening.winProbA);
      add(matchup.opening.spread);
      add(matchup.opening.total);
    }
    if (matchup.peakWinProb) addProbability(matchup.peakWinProb.value);
    if (matchup.turningPoint) addProbability(matchup.turningPoint.swing);
  }

  for (const award of packet.awards) {
    awards.add(award.label);
    add(award.value);
    if (Math.abs(award.value) <= 1) add(award.value * 100);
    collectEvidenceNumbers(award, add);
  }

  for (const hot of packet.hotPlayers) {
    players.add(hot.player);
    add(hot.points);
    add(hot.vsProjection);
  }

  if (packet.teamOfTheWeek) {
    add(packet.teamOfTheWeek.total);
    add(packet.teamOfTheWeek.startedTotal);
    add(packet.teamOfTheWeek.total - packet.teamOfTheWeek.startedTotal);
    for (const slot of packet.teamOfTheWeek.slots) {
      players.add(slot.player);
      add(slot.points);
    }
  }

  for (const line of [...packet.transactions.adds, ...packet.transactions.drops]) {
    players.add(line.player);
    add(line.bid);
  }
  for (const trade of packet.transactions.trades) {
    for (const received of Object.values(trade.received)) received.forEach((p) => players.add(p));
  }
  for (const roi of packet.transactions.waiverRoi) {
    players.add(roi.player);
    if (roi.droppedPlayer) players.add(roi.droppedPlayer);
    add(roi.pointsSinceAdd);
    add(roi.droppedPointsSinceDrop);
    add(roi.roi);
    add(roi.addedWeek);
  }

  for (const counts of Object.values(extras.seasonAwardCounts ?? {})) {
    for (const count of Object.values(counts)) add(count);
  }

  add(packet.week);
  add(packet.teams.length);
  numbers.add(key(Number(packet.season)));

  // Ranks and small counts: any integer up to the league size is a legitimate
  // ordinal ("third in power rankings", "two straight losses").
  for (let i = 0; i <= Math.max(packet.teams.length, 18); i += 1) add(i);

  return {
    numbers,
    knownValues: [...numbers].map(Number),
    probabilities,
    managers,
    players,
    awards,
    teamCount: packet.teams.length,
    week: packet.week,
    season: packet.season,
  };
}

function collectEvidenceNumbers(award: Award, add: (n: number) => void): void {
  const walk = (value: unknown): void => {
    if (typeof value === 'number') add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(award.evidence);
}

export type FactCheckOptions = {
  /** Locker Room forbids profanity outright; the other levels do not. */
  heatLevel?: 'locker_room' | 'group_chat' | 'unhinged';
  /** Managers who opted down to Locker Room. Lines about them are held to it. */
  optedDownManagers?: string[];
  /** Absolute tolerance when matching a claimed number to a packet number. */
  tolerance?: number;
};

export function factCheck(
  body: string,
  index: FactIndex,
  options: FactCheckOptions = {},
): FactCheckResult {
  const tolerance = options.tolerance ?? 0.05;
  const optedDown = new Set(options.optedDownManagers ?? []);

  const blocks = body.split('\n');
  const violations: Violation[] = [];
  const kept: string[] = [];

  let sentenceCount = 0;
  let numericClaims = 0;
  let cutSentences = 0;

  for (const block of blocks) {
    if (block.trim() === '' || isStructural(block)) {
      kept.push(block);
      continue;
    }

    const { prefix, content } = splitPrefix(block);
    const sentences = splitSentences(content);
    const survivors: string[] = [];

    for (const sentence of sentences) {
      sentenceCount += 1;
      const found = checkSentence(sentence, index, {
        tolerance,
        heatLevel: options.heatLevel ?? 'group_chat',
        optedDown,
      });
      numericClaims += found.numericClaims;

      if (found.violations.length > 0) {
        violations.push(...found.violations);
        cutSentences += 1;
        continue;
      }
      survivors.push(sentence);
    }

    // A heading or bullet whose every sentence was cut leaves no orphan marker.
    if (survivors.length === 0) continue;
    kept.push(`${prefix}${survivors.join(' ')}`);
  }

  return {
    body: tidy(kept.join('\n')),
    violations,
    stats: {
      sentences: sentenceCount,
      numericClaims,
      cutSentences,
      failureRate: sentenceCount === 0 ? 0 : round4(cutSentences / sentenceCount),
    },
  };
}

function checkSentence(
  sentence: string,
  index: FactIndex,
  options: { tolerance: number; heatLevel: string; optedDown: Set<string> },
): { violations: Violation[]; numericClaims: number } {
  const violations: Violation[] = [];

  for (const { label, pattern } of BANNED_TOPIC_PATTERNS) {
    if (pattern.test(sentence)) {
      violations.push({
        kind: 'banned_topic',
        detail: `references ${label}, which the content rule puts out of bounds`,
        sentence,
      });
    }
  }

  const profane = PROFANITY.test(sentence);
  if (profane && options.heatLevel === 'locker_room') {
    violations.push({
      kind: 'heat_exceeded',
      detail: 'profanity is not permitted at the Locker Room heat level',
      sentence,
    });
  } else if (profane) {
    // A manager who opted down is held to Locker Room in lines about them, even
    // when the league ceiling is higher.
    for (const manager of options.optedDown) {
      if (mentions(sentence, manager)) {
        violations.push({
          kind: 'heat_exceeded',
          detail: `${manager} opted down and this line exceeds their level`,
          sentence,
        });
        break;
      }
    }
  }

  const claims = extractNumbers(sentence);
  for (const claim of claims) {
    if (!verifyNumber(claim, index, options.tolerance)) {
      violations.push({
        kind: 'unverifiable_number',
        detail: `${claim.raw} does not appear in the stat packet`,
        sentence,
      });
    }
  }

  return { violations, numericClaims: claims.length };
}

export type NumericClaim = { raw: string; value: number; isPercent: boolean };

/**
 * Pull numeric literals out of prose. Ordinal suffixes, records like "5-2", and
 * percentages all have to be understood rather than skipped — "5-2" is two
 * claims, not the number three.
 */
export function extractNumbers(sentence: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  // Strip possessive/decade forms that are not claims: "the '90s", "2010s".
  const text = sentence.replace(/\b\d{4}s\b/g, ' ');

  const pattern = /([+-]?\d+(?:\.\d+)?)\s*(%)?/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] as string;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;

    // A hyphen between two digits is a record or a score line, not a negative.
    const previousChar = text[match.index - 1];
    const isRecordHalf = raw.startsWith('-') && previousChar !== undefined && /\d/.test(previousChar);
    claims.push({
      raw: match[0].trim(),
      value: isRecordHalf ? Math.abs(value) : value,
      isPercent: match[2] === '%',
    });
  }

  return claims;
}

function verifyNumber(claim: NumericClaim, index: FactIndex, tolerance: number): boolean {
  if (claim.isPercent) {
    // "94%" is verified against a probability of 0.94, or against a raw 94.
    for (const probability of index.probabilities) {
      if (Math.abs(probability * 100 - claim.value) <= 0.6) return true;
    }
  }
  return matchesKnown(claim.value, index, tolerance);
}

/**
 * A claim is verified when it is the packet's number, within tolerance, or a
 * rounding of it.
 *
 * The direction matters and is easy to get backwards. "Is there a packet number
 * that rounds to the claim?" is the correct test: a writer may render 118.44 as
 * "118.4". The inverse — "does the claim round to some packet number?" — is far
 * too permissive, because it lets any value between 93.5 and 94.49 be justified
 * by an unrelated 94 sitting somewhere in the packet.
 *
 * Rounding is allowed only for claims that carry a decimal. Permitting a bare
 * integer to stand as the rounding of a decimal opens a +/-0.5 window around
 * every number in the packet, and with a few hundred of them that covers most
 * of the integers a writer might invent. The prompt tells the writer to quote
 * figures exactly, so the strictness costs nothing real, and a cut is the safe
 * failure mode.
 *
 * The honest limit of this pass: it verifies that a number exists in the
 * packet, not that it is being used to mean what it meant there. A player's
 * yardage total that happens to coincide with someone's points-against will
 * survive. Catching that needs claim-to-field binding, which is future work —
 * see the README.
 */
function matchesKnown(value: number, index: FactIndex, tolerance: number): boolean {
  if (index.numbers.has(key(value))) return true;

  const decimals = decimalPlaces(value);
  const factor = 10 ** decimals;

  for (const known of index.knownValues) {
    if (Math.abs(known - value) <= tolerance) return true;
    if (decimals > 0 && Math.round(known * factor) / factor === value) return true;
  }
  return false;
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function mentions(sentence: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(sentence);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Headings, horizontal rules and table rows pass through unexamined. */
function isStructural(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s/.test(trimmed) || /^([-*_])\1{2,}$/.test(trimmed) || /^\|/.test(trimmed);
}

/** Separate a bullet or numbered-list marker from the prose after it. */
function splitPrefix(line: string): { prefix: string; content: string } {
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\*\*[^*]+\*\*[:\s-]*)?)/.exec(line);
  if (!match) return { prefix: '', content: line };
  return { prefix: match[1] as string, content: line.slice((match[1] as string).length) };
}

export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  // Split on sentence-ending punctuation followed by whitespace and a capital
  // or quote. Decimals survive because a digit never follows the boundary.
  return trimmed
    .split(/(?<=[.!?])\s+(?=["'“”(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function tidy(body: string): string {
  return body
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function key(value: number): string {
  // Normalise -0 and floating noise so set membership is stable.
  const rounded = Math.round(value * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
