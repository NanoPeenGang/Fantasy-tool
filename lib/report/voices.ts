/**
 * Voice presets.
 *
 * Same stat packet, different costume. Voice affects diction and structure only:
 * the facts and the awards are identical across presets, which is a useful
 * correctness check — if two voices disagree about a number, one of them is
 * fabricating and the fact-check pass should have caught it.
 */

export const VOICE_KEYS = [
  'drunk_anchor',
  'noir',
  'wwe',
  'pit_lane',
  'british_football',
  'true_crime',
] as const;

export type VoiceKey = (typeof VOICE_KEYS)[number];

export type VoicePreset = {
  key: VoiceKey;
  label: string;
  /** Injected into the writing pass. Diction and structure only. */
  direction: string;
  /** A single line showing the register, not to be copied verbatim. */
  sample: string;
};

export const VOICE_PRESETS: Record<VoiceKey, VoicePreset> = {
  drunk_anchor: {
    key: 'drunk_anchor',
    label: 'Drunk ESPN anchor',
    direction: [
      'A late-night sports anchor four drinks past professionalism.',
      'Booming segment transitions, catchphrases that collapse mid-sentence,',
      'sincere emotional detours about a running back nobody asked about.',
      'Confidence wildly exceeding coherence, but every stat still lands.',
    ].join(' '),
    sample: "We're BACK, and folks, I need you to understand what I just watched.",
  },
  noir: {
    key: 'noir',
    label: 'Hard-boiled noir detective',
    direction: [
      'First-person past tense, clipped sentences, weary moral distance.',
      'The league is a city. The waiver wire is a bad part of town.',
      'Similes drawn from rain, cigarettes, and money that was never coming.',
      'Never cheerful. The wins are as bleak as the losses.',
    ].join(' '),
    sample: 'The lineup came in at ninety-three and change. It died the way most of them do — quietly, on a bench.',
  },
  wwe: {
    key: 'wwe',
    label: 'WWE promo',
    direction: [
      'Second person, shouted. Direct address to the manager being buried.',
      'Rhetorical questions, escalating triplets, a catchphrase per section.',
      'Everything is a betrayal, a reckoning, or a road to somewhere.',
      'ALL CAPS is permitted but only on the payoff word.',
    ].join(' '),
    sample: 'You looked that man in the eye, and you STARTED HIM ANYWAY.',
  },
  pit_lane: {
    key: 'pit_lane',
    label: 'Pit-lane reporter',
    direction: [
      'Breathless, present tense, radio-chatter urgency.',
      'Motorsport framing: strategy calls, tyre wear, undercuts, a bad stop.',
      'Interrupt yourself with updates. Everything is developing.',
    ].join(' '),
    sample: 'And he has stayed out — he has STAYED OUT on a tight end who gave him three points.',
  },
  british_football: {
    key: 'british_football',
    label: 'British football commentator',
    direction: [
      'Understated build, sudden crescendo, then a long dry silence of a sentence.',
      'Terrace vocabulary: shambles, shocking, having a stinker, no ideas whatsoever.',
      'Deep, unearned historical context for a five-week-old rivalry.',
    ].join(' '),
    sample: 'Oh, that is a shambles. That is an absolute shambles and he knows it.',
  },
  true_crime: {
    key: 'true_crime',
    label: 'True-crime docuseries narrator',
    direction: [
      'Measured, ominous, past tense. Timeline framing with specific timestamps.',
      'Treat the lineup decision as evidence and the bench as a crime scene.',
      'End paragraphs on an unsettling short sentence. Nobody saw it coming.',
    ].join(' '),
    sample: 'At 4:12 that afternoon, he was ninety-four percent to win. He would not win.',
  },
};

export function isVoiceKey(value: string): value is VoiceKey {
  return (VOICE_KEYS as readonly string[]).includes(value);
}

export function parseVoice(value: string | null | undefined, fallback: VoiceKey = 'drunk_anchor'): VoiceKey {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isVoiceKey(normalized) ? normalized : fallback;
}

export function voicePreset(key: string | null | undefined): VoicePreset {
  return VOICE_PRESETS[parseVoice(key)];
}
