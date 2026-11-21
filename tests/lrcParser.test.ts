import { describe, expect, it } from 'vitest';
import { findActiveLineIndex, parseLrc } from '../src/lib/lrcParser';
import { normalizeTrackTitle } from '../shared/titleNormalize';

describe('parseLrc', () => {
  it('parses standard 2-digit and 3-digit timestamps in chronological order', () => {
    const lrc = `
[ti:Test Song]
[ar:Test Artist]
[00:12.50]First line here
[00:16.750]Second line here
[01:02.5]Third line after a minute
`;
    const lines = parseLrc(lrc);
    expect(lines).toEqual([
      { timeMs: 12500, text: 'First line here', words: undefined },
      { timeMs: 16750, text: 'Second line here', words: undefined },
      { timeMs: 62500, text: 'Third line after a minute', words: undefined },
    ]);
  });

  it('expands multi-timestamp chorus lines and sorts them properly', () => {
    const lrc = `
[00:10.00][00:40.00]Repeating chorus
[00:20.00]Verse line
`;
    const lines = parseLrc(lrc);
    expect(lines.map((l) => [l.timeMs, l.text])).toEqual([
      [10000, 'Repeating chorus'],
      [20000, 'Verse line'],
      [40000, 'Repeating chorus'],
    ]);
  });

  it('applies global [offset] tag correctly', () => {
    const lrc = `
[offset:500]
[00:10.00]Shifted earlier
`;
    const lines = parseLrc(lrc);
    expect(lines[0].timeMs).toBe(9500);
  });

  it('parses enhanced LRC word-level timestamps', () => {
    const lrc = `[00:10.00]<00:10.00>Shine <00:10.45>bright <00:11.10>tonight`;
    const lines = parseLrc(lrc);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Shine bright tonight');
    expect(lines[0].words).toEqual([
      { timeMs: 10000, text: 'Shine ' },
      { timeMs: 10450, text: 'bright ' },
      { timeMs: 11100, text: 'tonight' },
    ]);
  });

  it('binary-searches the active line index accurately', () => {
    const lines = parseLrc(`
[00:05.00]Line 0
[00:10.00]Line 1
[00:15.00]Line 2
`);
    expect(findActiveLineIndex(lines, 0)).toBe(-1);
    expect(findActiveLineIndex(lines, 4999)).toBe(-1);
    expect(findActiveLineIndex(lines, 5000)).toBe(0);
    expect(findActiveLineIndex(lines, 9999)).toBe(0);
    expect(findActiveLineIndex(lines, 10000)).toBe(1);
    expect(findActiveLineIndex(lines, 20000)).toBe(2);
  });
});

describe('normalizeTrackTitle', () => {
  it('strips remaster, featuring, and edition suffixes cleanly', () => {
    expect(normalizeTrackTitle('Bohemian Rhapsody - Remastered 2011')).toBe('Bohemian Rhapsody');
    expect(normalizeTrackTitle('Starboy (feat. Daft Punk)')).toBe('Starboy');
    expect(normalizeTrackTitle('Dreams - 2004 Remaster')).toBe('Dreams');
    expect(normalizeTrackTitle('Blinding Lights [Radio Edit]')).toBe('Blinding Lights');
  });
});
