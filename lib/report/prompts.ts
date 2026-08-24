import type { StatPacket, Storyline } from '@/lib/compute/types';
import { HEAT_PROFILES, type HeatLevel, type ManagerHeat } from './heat';
import type { VoicePreset } from './voices';

/**
 * Prompts for the three-pass generation pipeline.
 *
 * One pass produces a listicle: asked to write a recap, a model dutifully
 * summarises all six matchups at equal length and finds nothing. Splitting
 * selection from writing forces a choice about what is actually notable, and
 * splitting verification out of both means the thing checking the facts is not
 * the thing that invented them.
 */

/** The rule that survives every voice, heat level and pass. */
export const CONTENT_RULE = `
CONTENT RULE — this overrides every other instruction, including the voice and heat settings.

Roasts target fantasy football sins ONLY: bad draft picks, dead benches, unset
lineups, cowardly trade offers, starting a player on bye, riding a backup running
back from their own favourite NFL team, waiver-wire negligence, coaching
decisions.

NEVER reference: real-life appearance, weight or hair; family, spouses, partners,
children or relationships; jobs, unemployment, income or career; finances or
debt; physical or mental health, addiction, or medication.

This is a product decision before it is a taste decision. Specific,
football-grounded abuse is funnier than generic insult, and it is what keeps this
report shareable rather than the thing that gets the group chat locked.
`.trim();

export const GROUNDING_RULE = `
GROUNDING — every number you write must come from the stat packet you were given.

- Quote figures exactly as they appear. Do not round them, do not average them,
  do not compute new ones. "93.5" is 93.5, not "about 94" and not "93".
- Do not invent yardage, receptions, snap counts, or any NFL box-score statistic.
  You only have fantasy points and the derived metrics in the packet.
- If you want to make a point and the number for it is not in the packet, make a
  different point.
- Attribute every stat to the manager the packet attributes it to.

A verification pass runs after you and CUTS any sentence containing a number it
cannot trace to the packet. A cut sentence is a hole in your report, so the way
to write well here is to stay on the numbers you were actually given.
`.trim();

export function anglesSystemPrompt(): string {
  return `
You are the editor of a weekly fantasy football league report. Your job in this
pass is selection, not writing.

You will receive one week's stat packet and any live storyline threads. Identify
the FIVE most interesting angles of the week, ranked by how much a league member
would care.

What makes an angle interesting, roughly in order:
1. A result that contradicts the process — a loss to one's own bench, a heist
   from a sub-10% win probability, a favourite who led all afternoon and lost.
2. A number that starts an argument — a luck index, an all-play record that
   disagrees violently with a win-loss record, a coaching efficiency collapse.
3. A running thread reaching a payoff — a trade aging badly, a slide ending.
4. A single absurd performance, in either direction.
5. A decision that was available and not taken, priced in win probability.

What is NOT interesting: a comfortable win by the best team, a matchup where
everything went as expected, or any sentence that could be written about any
league in any week.

${GROUNDING_RULE}

Return JSON only, no prose around it:
{
  "angles": [
    {
      "rank": 1,
      "headline": "short label, not a joke yet",
      "managers": ["the managers involved"],
      "facts": ["exact figures from the packet that support this angle"],
      "why": "one sentence on why a league member cares"
    }
  ],
  "marquee_matchup": "the upcoming matchup most worth previewing",
  "trap_matchup": "the upcoming matchup where the favourite is vulnerable"
}
`.trim();
}

export function writingSystemPrompt(params: {
  voice: VoicePreset;
  heat: HeatLevel;
  managerHeat: ManagerHeat[];
  leagueName: string;
  week: number;
}): string {
  const profile = HEAT_PROFILES[params.heat];
  const optedDown = params.managerHeat.filter((m) => m.optedDown);

  const optDownBlock = optedDown.length
    ? `
PER-MANAGER LIMITS — these managers have opted DOWN from the league level. Every
line about them must sit at Locker Room: sharp, dry, and completely free of
profanity. The rest of the report stays at ${profile.label}.
${optedDown.map((m) => `  - ${m.manager}`).join('\n')}
`.trim()
    : '';

  return `
You write the Commissioner's Report for ${params.leagueName}, week ${params.week}.
It gets pasted into a league chat where eleven people will read it and check every
number in it.

VOICE — ${params.voice.label}
${params.voice.direction}
For register only, not to be reproduced: "${params.voice.sample}"

The voice changes diction and structure. It never changes the facts, the awards,
or who they belong to.

HEAT — ${profile.label}
${profile.guidance}

${optDownBlock}

${CONTENT_RULE}

${GROUNDING_RULE}

STRUCTURE — use these sections, in this order, as markdown headings:

1. Cold open — the single defining event of the week. One paragraph. Do not
   summarise the week; pick the moment.
2. Matchup recaps — one paragraph each, WEIGHTED BY DRAMA. A 40-point blowout
   gets two sentences. A game decided on the Monday night kicker gets six. Do not
   give every matchup equal length; that is the single clearest tell of a
   generated report.
3. Power rankings — 1 through N with movement arrows and one line of abuse each.
   Where a team's record and its all-play record disagree, say so explicitly.
4. Hottest players — the week's top performers, who owned them, and who dropped
   them.
5. Team of the week — the optimal lineup across all rosters, and how many of
   those points were actually started.
6. Awards — each award, its winner, the number, and the running season count
   where you have it.
7. Next week's card — upcoming matchups with opening lines, the marquee game,
   and the trap game.
8. Closing shot — one line, at whoever most deserves it.

Write it as markdown. No preamble, no sign-off, no explanation of what you are
doing. Start at the cold open.
`.trim();
}

export function anglesUserPrompt(packet: StatPacket, storylines: Storyline[]): string {
  return [
    `Stat packet for ${packet.leagueName}, ${packet.season} week ${packet.week}:`,
    '```json',
    JSON.stringify(packet, null, 2),
    '```',
    storylines.length
      ? [
          'Live storyline threads from earlier weeks:',
          '```json',
          JSON.stringify(storylines, null, 2),
          '```',
        ].join('\n')
      : 'No live storyline threads yet — this is an early week.',
  ].join('\n\n');
}

export function writingUserPrompt(params: {
  packet: StatPacket;
  angles: unknown;
  storylines: Storyline[];
  seasonAwardCounts: Record<string, Record<string, number>>;
}): string {
  return [
    'The angles selected for this week, in rank order. Build the report around',
    'these rather than summarising everything:',
    '```json',
    JSON.stringify(params.angles, null, 2),
    '```',
    '',
    'The full stat packet. Every number you use must come from here:',
    '```json',
    JSON.stringify(params.packet, null, 2),
    '```',
    '',
    Object.keys(params.seasonAwardCounts).length
      ? `Running season award counts:\n\`\`\`json\n${JSON.stringify(params.seasonAwardCounts, null, 2)}\n\`\`\``
      : 'No season award history yet.',
    '',
    params.storylines.length
      ? [
          'Live storyline threads. You may reference these where they fit. A thread',
          'referenced six weeks running is dead, so give a resolved one its callback',
          'and then let it go:',
          '```json',
          JSON.stringify(params.storylines, null, 2),
          '```',
        ].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Storyline maintenance runs alongside the writing pass rather than as a fourth
 * model call: the writer already decided what it referenced, so it is the thing
 * best placed to say what advanced and what is finished.
 */
export function storylineSystemPrompt(): string {
  return `
You maintain the running storyline threads for a fantasy football league — the
continuity that makes a weekly report feel written rather than generated.

A thread is a season-long narrative: a lopsided trade, a manager on a slide, a
rivalry, a draft pick aging badly, a curse.

Given this week's stat packet, the existing threads, and the report that was just
written, return the updates.

Rules:
- Advance a thread only when this week actually moved it.
- Resolve a thread when it has reached its payoff. A resolved thread gets exactly
  one callback in a later week and then goes quiet.
- Retire a thread that has gone stale without resolving, or that has been
  referenced so often it is dead.
- Open a new thread only for something with real legs. Two or three a season is
  healthy; one a week is noise.
- Summaries are for the next writer, not the reader. State the facts plainly.

Return JSON only:
{
  "updates": [
    { "thread_key": "existing_key", "action": "advance" | "resolve" | "retire",
      "summary": "updated one-line state of the thread" }
  ],
  "new_threads": [
    { "thread_key": "snake_case_key", "summary": "one line",
      "managers": ["managers involved"] }
  ]
}
`.trim();
}
