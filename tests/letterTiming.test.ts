import { describe, expect, it } from 'vitest';
import type { LyricLine } from '../shared/types';
import {
  computeLetterProgression,
  estimateLineDurationMs,
} from '../src/lib/letterTiming';

describe('letterTiming', () => {
  it('caps line duration naturally when followed by a long instrumental break', () => {
    const dur = estimateLineDurationMs('Hello world', 10_000, 35_000, 180_000);
    // Natural cadence for 11 chars should finish in ~1.4-2.0s, not stretch across 25 seconds
    expect(dur).toBeGreaterThanOrEqual(1100);
    expect(dur).toBeLessThan(2600);
  });

  it('compresses cleanly when the next line arrives quickly', () => {
    const dur = estimateLineDurationMs(
      'Fast chorus line with many words right here',
      5_000,
      6_200,
      180_000
    );
    expect(dur).toBeLessThanOrEqual(1200 * 0.92 + 1);
    expect(dur).toBeGreaterThanOrEqual(250);
  });

  it('sweeps left-to-right per letter with non-breaking word groups and a local jump wave', () => {
    const line: LyricLine = { timeMs: 10_000, text: 'Shine bright' };
    const groups = computeLetterProgression(line, 13_000, 180_000, 10_750);

    // 3 groups: "Shine", " ", "bright"
    expect(groups).toHaveLength(3);
    expect(groups[0].isSpace).toBe(false);
    expect(groups[1].isSpace).toBe(true);
    expect(groups[2].isSpace).toBe(false);
    expect(groups[0].chars.map((c) => c.char).join('')).toBe('Shine');
    expect(groups[2].chars.map((c) => c.char).join('')).toBe('bright');

    const allChars = groups.flatMap((g) => (g.isSpace ? [] : g.chars));
    // Early letter is already lit
    expect(allChars[0].fill).toBe(1);
    // Last letter is still upcoming and stationary
    const last = allChars[allChars.length - 1];
    expect(last.fill).toBe(0);
    expect(last.hopPx).toBe(0);
    expect(last.scale).toBe(1);

    // At least one letter near the sweep frontier is actively filling or hopping upward
    const hopping = allChars.filter((c) => c.hopPx < -1.5);
    expect(hopping.length).toBeGreaterThan(0);
    expect(hopping.some((c) => c.scale > 1.02)).toBe(true);
  });

  it('honors enhanced word-level timestamps when present', () => {
    const line: LyricLine = {
      timeMs: 20_000,
      text: 'One two three',
      words: [
        { timeMs: 20_000, text: 'One ' },
        { timeMs: 21_500, text: 'two ' },
        { timeMs: 22_000, text: 'three' },
      ],
    };

    // At 21_600ms, "One" is 100% lit, "two" is actively sweeping/hopping, "three" is 0% lit
    const groups = computeLetterProgression(line, 24_000, 180_000, 21_620);
    const wordGroups = groups.filter((g) => !g.isSpace);
    expect(wordGroups).toHaveLength(3);

    expect(wordGroups[0].chars.every((c) => c.fill === 1)).toBe(true);
    expect(wordGroups[1].chars.some((c) => c.fill > 0 && c.fill < 1)).toBe(true);
    expect(wordGroups[1].chars.some((c) => c.hopPx < -1)).toBe(true);
    expect(wordGroups[2].chars.every((c) => c.fill === 0)).toBe(true);
  });

  it('honors exact syllable endTimeMs and keeps multi-syllable words unbroken', () => {
    // Mirrors Apple Music / LyricsPlus timing for "Instant Crush": "re" (215ms) + "gret" (1474ms)
    const line: LyricLine = {
      timeMs: 30_760,
      endTimeMs: 35_010,
      text: 'never regret',
      words: [
        { timeMs: 32_803, endTimeMs: 33_321, text: 'never ' },
        { timeMs: 33_321, endTimeMs: 33_536, text: 're' },
        { timeMs: 33_536, endTimeMs: 35_010, text: 'gret' },
      ],
    };

    // Mid-way through the long held "gret" syllable (34_200ms)
    const groups = computeLetterProgression(line, 36_000, 337_000, 34_200);
    const wordGroups = groups.filter((g) => !g.isSpace);
    // "re" + "gret" MUST remain glued into one non-breaking word group "regret"!
    expect(wordGroups).toHaveLength(2);
    expect(wordGroups[1].chars.map((c) => c.char).join('')).toBe('regret');

    // "r" and "e" (ended at 33_536) are 100% lit; "t" (near 35_010) is still unlit!
    expect(wordGroups[1].chars[0].fill).toBe(1);
    expect(wordGroups[1].chars[1].fill).toBe(1);
    expect(wordGroups[1].chars[5].fill).toBe(0);
    // Actively sweeping syllable letter is hopping upward
    expect(wordGroups[1].chars.some((c) => c.fill > 0 && c.fill < 1 && c.hopPx < -1)).toBe(true);
  });
});
