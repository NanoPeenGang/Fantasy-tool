import { describe, expect, it } from 'vitest';
import type { GenerateParams, Generator } from '@/lib/anthropic/generator';
import { parseJsonObject } from '@/lib/anthropic/generator';
import { buildStatPacket } from '@/lib/compute/packet';
import type { Storyline } from '@/lib/compute/types';
import {
  activeStorylines,
  applyStorylineUpdates,
  generateCommissionersReport,
} from '@/lib/report/generate';
import { effectiveHeat, optedDownManagers, parseHeatLevel, resolveManagerHeat } from '@/lib/report/heat';
import { parseVoice, VOICE_PRESETS, voicePreset } from '@/lib/report/voices';
import {
  formatForDiscord,
  formatForEmail,
  formatForSlack,
  formatForSleeper,
  parseSections,
  stripMarkdown,
} from '@/lib/report/delivery';
import {
  HISTORY,
  MATCHUPS,
  ODDS_BY_MATCHUP,
  PLAYERS,
  ROSTER_POSITIONS,
} from './fixtures/league';

const packet = buildStatPacket({
  leagueId: 'lg_1',
  leagueName: 'The League',
  season: '2026',
  week: 3,
  rosterPositions: ROSTER_POSITIONS,
  matchups: MATCHUPS,
  players: PLAYERS,
  history: HISTORY,
  oddsByMatchup: ODDS_BY_MATCHUP,
});

const MANAGERS = [
  { manager: 'Dave', roastOptDown: false },
  { manager: 'Kim', roastOptDown: false },
  { manager: 'Raj', roastOptDown: true },
  { manager: 'Sam', roastOptDown: false },
];

/**
 * A scripted generator. The pipeline's job is orchestration, verification and
 * storyline bookkeeping — none of which needs a live model, and all of which
 * needs deterministic inputs to test at all.
 */
class ScriptedGenerator implements Generator {
  readonly calls: GenerateParams[] = [];

  constructor(private readonly responses: string[]) {}

  async generate(params: GenerateParams): Promise<string> {
    this.calls.push(params);
    const response = this.responses[this.calls.length - 1];
    if (response === undefined) throw new Error(`No scripted response for call ${this.calls.length}`);
    return response;
  }
}

const ANGLES_RESPONSE = JSON.stringify({
  angles: [
    {
      rank: 1,
      headline: 'Dave loses to his own bench',
      managers: ['Dave'],
      facts: ['93.5 actual', '114.4 optimal', 'Kincaid 24.1 benched'],
      why: 'He had the winning lineup and did not start it.',
    },
  ],
  marquee_matchup: 'Kim vs Sam',
  trap_matchup: 'Raj vs Dave',
});

const STORYLINE_RESPONSE = JSON.stringify({
  updates: [{ thread_key: 'dave_bench_curse', action: 'advance', summary: 'Dave benched 24.1 in week 3.' }],
  new_threads: [{ thread_key: 'raj_slide', summary: 'Raj has scored under 85 three weeks running.', managers: ['Raj'] }],
});

function scripted(draft: string): ScriptedGenerator {
  return new ScriptedGenerator([ANGLES_RESPONSE, draft, STORYLINE_RESPONSE]);
}

const EXISTING_STORYLINES: Storyline[] = [
  {
    threadKey: 'dave_bench_curse',
    summary: 'Dave keeps benching his best tight end.',
    sinceWeek: 1,
    lastReferencedWeek: 2,
    status: 'live',
    managerIds: ['mgr_dave'],
  },
];

describe('heat dial', () => {
  it('parses stored values and falls back on nonsense', () => {
    expect(parseHeatLevel('Group Chat')).toBe('group_chat');
    expect(parseHeatLevel('unhinged')).toBe('unhinged');
    expect(parseHeatLevel('nuclear')).toBe('group_chat');
    expect(parseHeatLevel(null)).toBe('group_chat');
  });

  it('lets a manager opt down but never up', () => {
    expect(effectiveHeat('unhinged', true)).toBe('locker_room');
    expect(effectiveHeat('locker_room', true)).toBe('locker_room');
    // No input can raise a manager above the league ceiling.
    expect(effectiveHeat('locker_room', false)).toBe('locker_room');
  });

  it('resolves per-manager levels against the ceiling', () => {
    const resolved = resolveManagerHeat('unhinged', MANAGERS);
    expect(resolved.find((m) => m.manager === 'Raj')?.level).toBe('locker_room');
    expect(resolved.find((m) => m.manager === 'Dave')?.level).toBe('unhinged');
    expect(optedDownManagers(resolved)).toEqual(['Raj']);
  });

  it('reports nobody opted down when the league is already at the floor', () => {
    const resolved = resolveManagerHeat('locker_room', MANAGERS);
    expect(optedDownManagers(resolved)).toEqual(['Raj']);
    expect(resolved.every((m) => m.level === 'locker_room')).toBe(true);
  });
});

describe('voice presets', () => {
  it('parses and falls back', () => {
    expect(parseVoice('noir')).toBe('noir');
    expect(parseVoice('True Crime')).toBe('true_crime');
    expect(parseVoice('shakespeare')).toBe('drunk_anchor');
  });

  it('ships every preset the spec names', () => {
    expect(Object.keys(VOICE_PRESETS)).toHaveLength(6);
    for (const preset of Object.values(VOICE_PRESETS)) {
      expect(preset.direction.length).toBeGreaterThan(40);
      expect(preset.sample).toBeTruthy();
    }
  });

  it('resolves an unknown key to the default rather than throwing', () => {
    expect(voicePreset(undefined).key).toBe('drunk_anchor');
  });
});

describe('generateCommissionersReport', () => {
  const cleanDraft = [
    '## Cold open',
    '',
    'Dave scored 93.5 and had 114.4 sitting right there.',
    '',
    '## Awards',
    '',
    '- Bench Warmer: Dave, 20.9 left behind.',
  ].join('\n');

  it('runs three passes in order', async () => {
    const generator = scripted(cleanDraft);
    await generateCommissionersReport({
      packet, storylines: EXISTING_STORYLINES, seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS, generator,
    });

    expect(generator.calls).toHaveLength(3);
    expect(generator.calls[0]?.system).toContain('selection, not writing');
    expect(generator.calls[1]?.system).toContain('Commissioner');
    expect(generator.calls[2]?.system).toContain('storyline');
  });

  it('passes the selected angles into the writing pass', async () => {
    const generator = scripted(cleanDraft);
    await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS, generator,
    });

    expect(generator.calls[1]?.user).toContain('Dave loses to his own bench');
  });

  it('puts the chosen voice and heat guidance in the writing prompt', async () => {
    const generator = scripted(cleanDraft);
    await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'unhinged', voice: 'wwe', managers: MANAGERS, generator,
    });

    const system = generator.calls[1]?.system as string;
    expect(system).toContain('WWE promo');
    expect(system).toContain('Unhinged');
    // Raj opted down, so the writing prompt has to say so.
    expect(system).toContain('Raj');
  });

  it('carries the content rule into the writing prompt', async () => {
    const generator = scripted(cleanDraft);
    await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS, generator,
    });
    expect(generator.calls[1]?.system).toContain('CONTENT RULE');
  });

  it('returns a verified body and the draft it came from', async () => {
    const generator = scripted(cleanDraft);
    const result = await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS, generator,
    });

    expect(result.body).toContain('93.5');
    expect(result.draft).toBe(cleanDraft);
    expect(result.factCheck.stats.failureRate).toBe(0);
  });

  it('cuts a fabricated stat out of the delivered report', async () => {
    const dirty = [
      '## Cold open',
      '',
      'Dave scored 93.5 and had 114.4 sitting right there. He also threw for 388 yards.',
    ].join('\n');

    const result = await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS,
      generator: scripted(dirty),
    });

    expect(result.body).toContain('93.5');
    expect(result.body).not.toContain('388');
    expect(result.factCheck.violations).toHaveLength(1);
  });

  it('holds an opted-down manager to their level in the delivered report', async () => {
    const dirty = '## Cold open\n\nRaj scored 48.3, the shit performance of the week.';
    const result = await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'unhinged', voice: 'noir', managers: MANAGERS,
      generator: scripted(dirty),
    });

    expect(result.body).not.toContain('shit');
    expect(result.factCheck.violations[0]?.kind).toBe('heat_exceeded');
  });

  it('degrades to a summary rather than failing when angle selection is unusable', async () => {
    const generator = new ScriptedGenerator(['not json at all', cleanDraft, STORYLINE_RESPONSE]);
    const result = await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS, generator,
    });

    expect(result.angles.angles).toEqual([]);
    expect(result.body).toContain('93.5');
  });

  it('does not lose the week when storyline maintenance fails', async () => {
    const generator = new ScriptedGenerator([ANGLES_RESPONSE, cleanDraft, 'garbage']);
    const result = await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS, generator,
    });

    expect(result.storylines).toEqual({ updates: [], new_threads: [] });
    expect(result.body).toContain('93.5');
  });

  it('skips the storyline pass when asked to', async () => {
    const generator = new ScriptedGenerator([ANGLES_RESPONSE, cleanDraft]);
    await generateCommissionersReport({
      packet, storylines: [], seasonAwardCounts: {},
      heatCeiling: 'group_chat', voice: 'noir', managers: MANAGERS,
      generator, updateStorylines: false,
    });
    expect(generator.calls).toHaveLength(2);
  });
});

describe('storyline memory', () => {
  it('advances an existing thread and stamps the week', () => {
    const updated = applyStorylineUpdates(
      EXISTING_STORYLINES,
      { updates: [{ thread_key: 'dave_bench_curse', action: 'advance', summary: 'Still benching him.' }], new_threads: [] },
      3,
    );
    const thread = updated.find((t) => t.threadKey === 'dave_bench_curse');
    expect(thread?.status).toBe('live');
    expect(thread?.summary).toBe('Still benching him.');
    expect(thread?.lastReferencedWeek).toBe(3);
  });

  it('opens a new thread', () => {
    const updated = applyStorylineUpdates(
      EXISTING_STORYLINES,
      { updates: [], new_threads: [{ thread_key: 'raj_slide', summary: 'Three bad weeks.', managers: ['mgr_raj'] }] },
      3,
    );
    expect(updated).toHaveLength(2);
    expect(updated.find((t) => t.threadKey === 'raj_slide')?.sinceWeek).toBe(3);
  });

  it('ignores a new thread that already exists', () => {
    const updated = applyStorylineUpdates(
      EXISTING_STORYLINES,
      { updates: [], new_threads: [{ thread_key: 'dave_bench_curse', summary: 'Duplicate.' }] },
      3,
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.summary).toBe('Dave keeps benching his best tight end.');
  });

  /** A joke referenced in six consecutive weeks is dead. */
  it('retires a resolved thread that gets referenced again', () => {
    const resolved: Storyline[] = [{ ...EXISTING_STORYLINES[0]!, status: 'resolved' }];
    const updated = applyStorylineUpdates(
      resolved,
      { updates: [{ thread_key: 'dave_bench_curse', action: 'advance', summary: 'Again.' }], new_threads: [] },
      4,
    );
    expect(updated[0]?.status).toBe('retired');
  });

  it('never revives a retired thread', () => {
    const retired: Storyline[] = [{ ...EXISTING_STORYLINES[0]!, status: 'retired' }];
    const updated = applyStorylineUpdates(
      retired,
      { updates: [{ thread_key: 'dave_bench_curse', action: 'advance', summary: 'Back again.' }], new_threads: [] },
      5,
    );
    expect(updated[0]?.status).toBe('retired');
    expect(updated[0]?.summary).toBe('Dave keeps benching his best tight end.');
  });

  it('ignores an update for a thread that does not exist', () => {
    const updated = applyStorylineUpdates(
      EXISTING_STORYLINES,
      { updates: [{ thread_key: 'nonexistent', action: 'resolve', summary: 'x' }], new_threads: [] },
      3,
    );
    expect(updated).toHaveLength(1);
  });

  describe('activeStorylines', () => {
    const thread = (over: Partial<Storyline>): Storyline => ({
      threadKey: 'k', summary: 's', sinceWeek: 1, lastReferencedWeek: 1,
      status: 'live', managerIds: [], ...over,
    });

    it('keeps live threads that are still fresh', () => {
      expect(activeStorylines([thread({ lastReferencedWeek: 4 })], 6)).toHaveLength(1);
    });

    it('drops live threads that have gone stale', () => {
      expect(activeStorylines([thread({ lastReferencedWeek: 1 })], 8)).toHaveLength(0);
    });

    it('owes a just-resolved thread exactly one callback', () => {
      const resolved = thread({ status: 'resolved', lastReferencedWeek: 5 });
      expect(activeStorylines([resolved], 6)).toHaveLength(1);
      expect(activeStorylines([resolved], 7)).toHaveLength(0);
    });

    it('never surfaces a retired thread', () => {
      expect(activeStorylines([thread({ status: 'retired', lastReferencedWeek: 9 })], 9)).toHaveLength(0);
    });
  });
});

describe('parseJsonObject', () => {
  it('reads bare JSON', () => {
    expect(parseJsonObject<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON out of a fenced block', () => {
    expect(parseJsonObject<{ a: number }>('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('reads JSON out of surrounding prose', () => {
    expect(parseJsonObject<{ a: number }>('Sure! {"a":3} Hope that helps.')).toEqual({ a: 3 });
  });

  it('throws when there is no object at all', () => {
    expect(() => parseJsonObject('no json here')).toThrow(/Expected a JSON object/);
  });
});

describe('delivery formatting', () => {
  const report = [
    '## Cold open',
    '',
    'Dave had **114.4** sitting there and started 93.5 of it.',
    '',
    '## Awards',
    '',
    '- Bench Warmer: Dave, 20.9 left behind.',
    '- Heist of the Week: Kim.',
  ].join('\n');

  it('splits a report into its sections', () => {
    const sections = parseSections(report);
    expect(sections.map((s) => s.heading)).toEqual(['Cold open', 'Awards']);
    expect(sections[1]?.body).toContain('Bench Warmer');
  });

  describe('Sleeper', () => {
    it('produces plain text with no markdown left in it', () => {
      const messages = formatForSleeper(report);
      const joined = messages.join('\n');
      expect(joined).not.toContain('**');
      expect(joined).not.toContain('##');
      expect(joined).toContain('COLD OPEN');
    });

    it('keeps every message inside the character budget', () => {
      const long = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nDave scored 93.5 in a paragraph that runs on for a while to eat budget.`).join('\n\n');
      for (const message of formatForSleeper(long, 1800)) {
        expect(message.length).toBeLessThanOrEqual(1800);
      }
    });

    it('splits rather than truncating', () => {
      const long = Array.from({ length: 60 }, () => 'Dave scored 93.5 and it was a whole thing that went on.').join('\n\n');
      const messages = formatForSleeper(long, 500);
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.join(' ')).toContain('93.5');
    });

    it('carries the footer, which is the acquisition channel', () => {
      const messages = formatForSleeper(report);
      expect(messages[messages.length - 1]).toContain('LeagueOps');
    });

    it('puts the footer in its own message when it will not fit', () => {
      const long = Array.from({ length: 20 }, () => 'Dave scored 93.5 in a sentence.').join(' ');
      const messages = formatForSleeper(long, 120);
      expect(messages[messages.length - 1]).toContain('LeagueOps');
      for (const message of messages) expect(message.length).toBeLessThanOrEqual(120);
    });
  });

  describe('email', () => {
    it('renders headings, paragraphs and lists as HTML', () => {
      const html = formatForEmail(report, packet);
      expect(html).toContain('<h2');
      expect(html).toContain('<ul');
      expect(html).toContain('<strong>114.4</strong>');
    });

    it('escapes HTML in league and manager names', () => {
      const hostile = { ...packet, leagueName: '<script>alert(1)</script>' };
      const html = formatForEmail(report, hostile);
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('includes the footer link', () => {
      expect(formatForEmail(report, packet)).toContain('leagueops.app');
    });
  });

  describe('Discord', () => {
    it('maps sections to embed fields', () => {
      const payload = formatForDiscord(report, packet);
      const fields = payload.embeds[0]?.fields as { name: string }[];
      expect(fields.map((f) => f.name)).toEqual(['Cold open', 'Awards']);
    });

    it('respects the field limits', () => {
      const many = Array.from({ length: 40 }, (_, i) => `## S${i}\n\n${'x'.repeat(2000)}`).join('\n\n');
      const payload = formatForDiscord(many, packet);
      const fields = payload.embeds[0]?.fields as { value: string }[];
      expect(fields.length).toBeLessThanOrEqual(25);
      for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(1024);
    });
  });

  describe('Slack', () => {
    it('converts markdown bold to mrkdwn', () => {
      const payload = formatForSlack(report, packet);
      const text = JSON.stringify(payload.blocks);
      expect(text).toContain('*114.4*');
      expect(text).not.toContain('**114.4**');
    });

    it('opens with a header and closes with the footer', () => {
      const blocks = formatForSlack(report, packet).blocks;
      expect(blocks[0]?.type).toBe('header');
      expect(JSON.stringify(blocks[blocks.length - 1])).toContain('leagueops.app');
    });
  });

  describe('stripMarkdown', () => {
    it('removes emphasis, headings, links and code', () => {
      const stripped = stripMarkdown('# H\n\n**bold** *em* `code` [link](https://x.com)\n\n- item');
      expect(stripped).toBe('H\n\nbold em code link\n\n• item');
    });
  });
});
