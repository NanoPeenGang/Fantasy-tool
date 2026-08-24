import { describe, expect, it } from 'vitest';
import { buildStatPacket } from '@/lib/compute/packet';
import {
  buildFactIndex,
  extractNumbers,
  factCheck,
  splitSentences,
} from '@/lib/report/factcheck';
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

const index = buildFactIndex(packet);

describe('splitSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(splitSentences('One thing. Then another! And a third?')).toEqual([
      'One thing.', 'Then another!', 'And a third?',
    ]);
  });

  it('does not split inside a decimal', () => {
    expect(splitSentences('Dave scored 93.5 and lost.')).toEqual(['Dave scored 93.5 and lost.']);
  });

  it('returns nothing for empty input', () => {
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('extractNumbers', () => {
  it('finds decimals, percentages and signed values', () => {
    const claims = extractNumbers('He led 94% before falling to 93.5, a swing of -6.4.');
    expect(claims.map((c) => c.value)).toEqual([94, 93.5, -6.4]);
    expect(claims[0]?.isPercent).toBe(true);
  });

  it('reads a record as two numbers, not a subtraction', () => {
    const claims = extractNumbers('Kim is 2-1 on the season.');
    expect(claims.map((c) => c.value)).toEqual([2, 1]);
  });

  it('ignores decade forms', () => {
    expect(extractNumbers('a 1990s offense')).toEqual([]);
  });
});

describe('factCheck: numeric verification', () => {
  it('keeps a sentence whose every number comes from the packet', () => {
    const body = 'Dave scored 93.5 and left 20.9 on the bench.';
    const result = factCheck(body, index);
    expect(result.body).toBe(body);
    expect(result.violations).toEqual([]);
  });

  it('cuts a sentence containing a number the packet does not support', () => {
    const body = 'Dave scored 93.5 and left 20.9 on the bench. He also threw for 412 yards.';
    const result = factCheck(body, index);
    expect(result.body).toBe('Dave scored 93.5 and left 20.9 on the bench.');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('unverifiable_number');
  });

  it('cuts rather than corrects', () => {
    // 93.7 is close to Dave's real 93.5 but is not it. A corrected number would
    // be worse than a missing sentence: the reader would never know.
    const result = factCheck('Dave scored 93.7 on the week.', index, { tolerance: 0.01 });
    expect(result.body).toBe('');
    expect(result.violations[0]?.detail).toContain('93.7');
  });

  it('accepts a number rounded from the packet value', () => {
    const result = factCheck('Kim posted 99.9 to take it.', index);
    expect(result.violations).toEqual([]);
  });

  it('verifies a percentage against the underlying probability', () => {
    // Dave's peak was 0.94 in the odds snapshots.
    const result = factCheck('Dave was 94% to win at one point.', index);
    expect(result.violations).toEqual([]);
  });

  it('rejects a percentage no snapshot supports', () => {
    const result = factCheck('Dave was 71% to win at one point.', index);
    expect(result.violations[0]?.kind).toBe('unverifiable_number');
  });

  it('allows ordinals and small counts', () => {
    const result = factCheck('Kim is 1st in the power rankings after 3 weeks.', index);
    expect(result.violations).toEqual([]);
  });

  it('verifies the player-level numbers behind a coaching roast', () => {
    // Otton produced 3.2 in the TE slot while Kincaid's 24.1 sat on the bench.
    // Neither is a team total, so both have to reach the index through the
    // packet's bench-regret detail.
    const body = 'Dave started a tight end who produced 3.2 while 24.1 rotted on his bench.';
    expect(factCheck(body, index).violations).toEqual([]);
  });

  /**
   * A bare integer may not stand as the rounding of a decimal. Allowing it opens
   * a +/-0.5 window around every number in the packet, which with a few hundred
   * of them covers most integers a writer could invent.
   */
  it('does not let an invented integer borrow a nearby decimal', () => {
    // 88.32 is Sam's coaching efficiency as a percentage. It must not launder
    // an unrelated "88 yards" claim.
    const result = factCheck('Dave also rushed for 88 yards.', index);
    expect(result.violations[0]?.kind).toBe('unverifiable_number');
  });

  it('still accepts a decimal rounded from a packet value', () => {
    // Dave's coaching efficiency is 0.8173; 81.7% is a fair rendering.
    const efficiency = packet.teams.find((t) => t.manager === 'Dave')?.coachingEfficiency as number;
    const rounded = (Math.round(efficiency * 1000) / 10).toFixed(1);
    expect(factCheck(`Dave managed ${rounded}% of his ceiling.`, index).violations).toEqual([]);
  });

  it('allows a margin derived from two packet scores', () => {
    // 99.9 - 93.5 = 6.4, which the packet exposes as the matchup margin.
    const result = factCheck('Kim won by 6.4.', index);
    expect(result.violations).toEqual([]);
  });
});

describe('factCheck: the content rule', () => {
  it('cuts a line about appearance', () => {
    const result = factCheck("Dave's lineup was as bald as his strategy.", index);
    expect(result.body).toBe('');
    expect(result.violations[0]?.kind).toBe('banned_topic');
    expect(result.violations[0]?.detail).toContain('appearance');
  });

  it('cuts a line about family', () => {
    const result = factCheck('Raj benched him because his wife told him to.', index);
    expect(result.violations[0]?.detail).toContain('family');
  });

  it('cuts lines about work, money and health', () => {
    for (const [line, topic] of [
      ['Sam manages his roster like the job he got fired from.', 'work'],
      ['Raj is as broke as his running back room.', 'finances'],
      ['Dave needs therapy after that lineup.', 'health'],
    ] as const) {
      const result = factCheck(line, index);
      expect(result.violations[0]?.detail).toContain(topic);
    }
  });

  it('keeps football-grounded abuse, which is the entire point', () => {
    const body = 'Dave started a tight end who produced 3.2 while 24.1 rotted on his bench.';
    const result = factCheck(body, index);
    expect(result.body).toBe(body);
    expect(result.violations).toEqual([]);
  });
});

describe('factCheck: heat levels', () => {
  const profane = 'Raj scored 48.3, which is a genuinely shit performance.';

  it('permits profanity at Group Chat', () => {
    const result = factCheck(profane, index, { heatLevel: 'group_chat' });
    expect(result.body).toBe(profane);
  });

  it('cuts profanity at Locker Room', () => {
    const result = factCheck(profane, index, { heatLevel: 'locker_room' });
    expect(result.body).toBe('');
    expect(result.violations[0]?.kind).toBe('heat_exceeded');
  });

  it('holds an opted-down manager to their level even when the league is hotter', () => {
    const result = factCheck(profane, index, {
      heatLevel: 'unhinged',
      optedDownManagers: ['Raj'],
    });
    expect(result.body).toBe('');
    expect(result.violations[0]?.detail).toContain('Raj');
  });

  it('leaves other managers at the league level when one opts down', () => {
    const aboutDave = 'Dave scored 93.5, which is a shit way to lose.';
    const result = factCheck(aboutDave, index, {
      heatLevel: 'unhinged',
      optedDownManagers: ['Raj'],
    });
    expect(result.body).toBe(aboutDave);
  });
});

describe('factCheck: document structure', () => {
  it('preserves headings and blank lines', () => {
    const body = [
      '## Cold open',
      '',
      'Dave scored 93.5.',
      '',
      '## Power rankings',
      '',
      '1. Kim — 99.9 and nothing to apologise for.',
    ].join('\n');

    const result = factCheck(body, index);
    expect(result.body).toContain('## Cold open');
    expect(result.body).toContain('## Power rankings');
    expect(result.body).toContain('1. Kim');
  });

  it('drops a bullet entirely when its only sentence is cut', () => {
    const body = [
      '- Kim scored 99.9.',
      '- Dave threw for 412 yards.',
    ].join('\n');

    const result = factCheck(body, index);
    expect(result.body).toBe('- Kim scored 99.9.');
    expect(result.body).not.toContain('-\n');
  });

  it('keeps the surviving half of a mixed bullet', () => {
    const body = '- Dave scored 93.5. He also rushed for 88 yards.';
    const result = factCheck(body, index);
    expect(result.body).toBe('- Dave scored 93.5.');
  });

  it('does not leave triple blank lines behind a cut', () => {
    const body = 'Kim scored 99.9.\n\nDave threw for 412 yards.\n\nRaj scored 48.3.';
    const result = factCheck(body, index);
    expect(result.body).not.toMatch(/\n{3}/);
  });
});

describe('factCheck: reporting', () => {
  it('reports a failure rate for drift monitoring', () => {
    const body = 'Kim scored 99.9. Dave threw for 412 yards. Raj scored 48.3.';
    const result = factCheck(body, index);
    expect(result.stats.sentences).toBe(3);
    expect(result.stats.cutSentences).toBe(1);
    expect(result.stats.failureRate).toBeCloseTo(1 / 3, 4);
  });

  it('reports a zero failure rate for a clean draft', () => {
    const result = factCheck('Kim scored 99.9. Raj scored 48.3.', index);
    expect(result.stats.failureRate).toBe(0);
    expect(result.stats.numericClaims).toBe(2);
  });

  it('handles an empty draft without dividing by zero', () => {
    const result = factCheck('', index);
    expect(result.stats.failureRate).toBe(0);
    expect(result.body).toBe('');
  });
});

describe('buildFactIndex', () => {
  it('collects every manager and their team name', () => {
    expect(index.managers.has('Dave')).toBe(true);
    expect(index.managers.has('Dave Matthews Band')).toBe(true);
  });

  it('collects the players who appear in the packet', () => {
    expect(index.players.has('Jalen Hurts')).toBe(true);
    expect(index.players.has('Dalton Kincaid')).toBe(true);
  });

  it('collects award labels in play this week', () => {
    expect(index.awards.has('Sh*t the Bed')).toBe(true);
  });

  it('indexes award evidence, which the recap quotes directly', () => {
    // Sh*t the Bed carries the league mean as evidence.
    const mean = packet.awards.find((a) => a.key === 'shit_the_bed')?.evidence.leagueMean as number;
    const result = factCheck(`The league averaged ${mean} and Raj managed 48.3.`, index);
    expect(result.violations).toEqual([]);
  });
});
