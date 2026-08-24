import { parseJsonObject, type Generator } from '@/lib/anthropic/generator';
import type { StatPacket, Storyline } from '@/lib/compute/types';
import { buildFactIndex, factCheck, type FactCheckResult } from './factcheck';
import { optedDownManagers, resolveManagerHeat, type HeatLevel } from './heat';
import {
  anglesSystemPrompt,
  anglesUserPrompt,
  storylineSystemPrompt,
  writingSystemPrompt,
  writingUserPrompt,
} from './prompts';
import { voicePreset, type VoiceKey } from './voices';

/**
 * The three-pass generation pipeline for the Commissioner's Report.
 *
 *   1. Angle selection — what is actually notable this week. No prose.
 *   2. Writing        — the report, in a voice, at a heat level.
 *   3. Fact check     — deterministic verification against the stat packet.
 *
 * Pass 3 is not a model call. A model that hallucinates cannot be the thing that
 * catches hallucinations, so verification is pure code (see ./factcheck).
 */

export type Angle = {
  rank: number;
  headline: string;
  managers: string[];
  facts: string[];
  why: string;
};

export type AngleSelection = {
  angles: Angle[];
  marquee_matchup?: string;
  trap_matchup?: string;
};

export type StorylineUpdate = {
  thread_key: string;
  action: 'advance' | 'resolve' | 'retire';
  summary: string;
};

export type NewStoryline = {
  thread_key: string;
  summary: string;
  managers?: string[];
};

export type StorylineResponse = {
  updates: StorylineUpdate[];
  new_threads: NewStoryline[];
};

export type GenerateReportParams = {
  packet: StatPacket;
  storylines: Storyline[];
  seasonAwardCounts: Record<string, Record<string, number>>;
  heatCeiling: HeatLevel;
  voice: VoiceKey;
  managers: { manager: string; roastOptDown: boolean }[];
  generator: Generator;
  /** Skip the storyline maintenance call, which the AAR path does not need. */
  updateStorylines?: boolean;
};

export type GeneratedReport = {
  body: string;
  angles: AngleSelection;
  factCheck: FactCheckResult;
  storylines: StorylineResponse;
  /** The draft before verification, kept for debugging a rising failure rate. */
  draft: string;
};

export async function generateCommissionersReport(
  params: GenerateReportParams,
): Promise<GeneratedReport> {
  const { packet, storylines, generator } = params;

  // --- Pass 1: angle selection ---------------------------------------------
  const anglesRaw = await generator.generate({
    system: anglesSystemPrompt(),
    user: anglesUserPrompt(packet, storylines),
    maxTokens: 2048,
    temperature: 0.6,
    prefill: '{',
  });
  const angles = safeAngles(anglesRaw);

  // --- Pass 2: writing ------------------------------------------------------
  const managerHeat = resolveManagerHeat(params.heatCeiling, params.managers);
  const draft = await generator.generate({
    system: writingSystemPrompt({
      voice: voicePreset(params.voice),
      heat: params.heatCeiling,
      managerHeat,
      leagueName: packet.leagueName,
      week: packet.week,
    }),
    user: writingUserPrompt({
      packet,
      angles,
      storylines,
      seasonAwardCounts: params.seasonAwardCounts,
    }),
    maxTokens: 6144,
    temperature: 1,
  });

  // --- Pass 3: fact check ---------------------------------------------------
  const index = buildFactIndex(packet, { seasonAwardCounts: params.seasonAwardCounts });
  const checked = factCheck(draft, index, {
    heatLevel: params.heatCeiling,
    optedDownManagers: optedDownManagers(managerHeat),
  });

  // --- Storyline maintenance ------------------------------------------------
  let storylineResponse: StorylineResponse = { updates: [], new_threads: [] };
  if (params.updateStorylines !== false) {
    storylineResponse = await maintainStorylines({
      generator,
      packet,
      storylines,
      report: checked.body,
    });
  }

  return { body: checked.body, angles, factCheck: checked, storylines: storylineResponse, draft };
}

async function maintainStorylines(params: {
  generator: Generator;
  packet: StatPacket;
  storylines: Storyline[];
  report: string;
}): Promise<StorylineResponse> {
  try {
    const raw = await params.generator.generate({
      system: storylineSystemPrompt(),
      user: [
        'Existing threads:',
        '```json',
        JSON.stringify(params.storylines, null, 2),
        '```',
        '',
        'This week stat packet:',
        '```json',
        JSON.stringify(params.packet, null, 2),
        '```',
        '',
        'The report as published:',
        params.report,
      ].join('\n'),
      maxTokens: 1536,
      temperature: 0.4,
      prefill: '{',
    });

    const parsed = parseJsonObject<Partial<StorylineResponse>>(raw);
    return {
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      new_threads: Array.isArray(parsed.new_threads) ? parsed.new_threads : [],
    };
  } catch {
    // Storyline memory is an enhancement, not a dependency. A malformed
    // response costs continuity next week; it must not cost this week's report.
    return { updates: [], new_threads: [] };
  }
}

function safeAngles(raw: string): AngleSelection {
  try {
    const parsed = parseJsonObject<Partial<AngleSelection>>(raw);
    const angles = Array.isArray(parsed.angles) ? parsed.angles : [];
    return {
      angles: angles.slice(0, 5),
      marquee_matchup: parsed.marquee_matchup,
      trap_matchup: parsed.trap_matchup,
    };
  } catch {
    // An unusable selection pass degrades the report to a summary; it should not
    // fail the week outright.
    return { angles: [] };
  }
}

/**
 * Apply the model's storyline decisions to the stored threads. Pure, so the
 * merge rules are testable without a database.
 *
 * A resolved thread is kept rather than deleted: it is owed exactly one callback
 * in a later week, and that callback is what makes the continuity land.
 */
export function applyStorylineUpdates(
  existing: Storyline[],
  response: StorylineResponse,
  week: number,
): Storyline[] {
  const byKey = new Map(existing.map((s) => [s.threadKey, { ...s }]));

  for (const update of response.updates) {
    const thread = byKey.get(update.thread_key);
    if (!thread) continue;

    // Retired threads are terminal. Nothing brings one back.
    if (thread.status === 'retired') continue;

    thread.summary = update.summary || thread.summary;
    thread.lastReferencedWeek = week;

    if (update.action === 'resolve') thread.status = 'resolved';
    else if (update.action === 'retire') thread.status = 'retired';
    // 'advance' leaves a live thread live. A resolved thread that gets advanced
    // has had its one callback, so it retires rather than coming back to life.
    else if (thread.status === 'resolved') thread.status = 'retired';
  }

  for (const created of response.new_threads) {
    if (!created.thread_key || byKey.has(created.thread_key)) continue;
    byKey.set(created.thread_key, {
      threadKey: created.thread_key,
      summary: created.summary,
      sinceWeek: week,
      lastReferencedWeek: week,
      status: 'live',
      managerIds: created.managers ?? [],
    });
  }

  return [...byKey.values()];
}

/**
 * Threads to hand the next week's writer: live ones, plus any resolved thread
 * still owed its callback.
 */
export function activeStorylines(threads: Storyline[], week: number, staleAfter = 4): Storyline[] {
  return threads.filter((thread) => {
    if (thread.status === 'retired') return false;
    if (thread.status === 'resolved') return thread.lastReferencedWeek >= week - 1;
    return week - thread.lastReferencedWeek <= staleAfter;
  });
}
