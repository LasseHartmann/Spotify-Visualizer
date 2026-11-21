import type { LyricLine } from '@shared/types';

export interface CharProgress {
  char: string;
  /** 0 = upcoming, 0..1 = loading bar sweeping through this letter, 1 = fully lit */
  fill: number;
  /** Smooth vertical lift (negative px = jumps upward as highlighted, settles back to 0) */
  hopPx: number;
  /** Subtle scale boost at peak of the letter jump (1.0 .. 1.065) */
  scale: number;
}

export interface WordCharGroup {
  isSpace: boolean;
  chars: CharProgress[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function charWeight(ch: string): number {
  if (ch === ' ') return 0.35;
  if (ch === ',' || ch === ';') return 1.8;
  if (ch === '.' || ch === '!' || ch === '?' || ch === '—' || ch === '-') return 2.1;
  return 1.0;
}

/**
 * Estimates natural vocal duration for a line-synced lyric so short lines before long
 * instrumental breaks sweep at a natural singing cadence rather than crawling slowly.
 */
export function estimateLineDurationMs(
  text: string,
  lineStartMs: number,
  nextLineTimeMs: number | null,
  trackDurationMs: number
): number {
  let weightSum = 0;
  for (const ch of text) {
    weightSum += charWeight(ch);
  }
  const naturalMs = clamp(weightSum * 92 + 420, 1100, 6800);
  const nextBoundary =
    nextLineTimeMs !== null && nextLineTimeMs > lineStartMs
      ? nextLineTimeMs
      : trackDurationMs > lineStartMs
        ? trackDurationMs
        : lineStartMs + naturalMs;

  const rawGap = Math.max(250, nextBoundary - lineStartMs);
  return Math.max(250, Math.min(rawGap * 0.92, naturalMs));
}

interface TimedChar {
  char: string;
  startMs: number;
  endMs: number;
}

function buildTimedChars(
  line: LyricLine,
  nextLineTimeMs: number | null,
  trackDurationMs: number
): TimedChar[] {
  const timed: TimedChar[] = [];

  if (line.words && line.words.length > 0) {
    const lineEndMs =
      line.timeMs +
      estimateLineDurationMs(line.text, line.timeMs, nextLineTimeMs, trackDurationMs);

    for (let wIdx = 0; wIdx < line.words.length; wIdx++) {
      const word = line.words[wIdx];
      const nextWordStart =
        wIdx + 1 < line.words.length ? line.words[wIdx + 1].timeMs : lineEndMs;
      const wordStart = word.timeMs;
      const wordDur = Math.max(120, Math.min(2600, nextWordStart - wordStart));
      const glyphs = Array.from(word.text);

      let totalW = 0;
      const weights = glyphs.map((g) => {
        const w = charWeight(g);
        totalW += w;
        return w;
      });
      if (totalW <= 0) continue;

      let acc = 0;
      for (let i = 0; i < glyphs.length; i++) {
        const cStart = wordStart + (acc / totalW) * wordDur;
        acc += weights[i];
        const cEnd = wordStart + (acc / totalW) * wordDur;
        timed.push({ char: glyphs[i], startMs: cStart, endMs: Math.max(cStart + 18, cEnd) });
      }
    }
    return timed;
  }

  const glyphs = Array.from(line.text);
  if (glyphs.length === 0) return timed;

  const lineDur = estimateLineDurationMs(
    line.text,
    line.timeMs,
    nextLineTimeMs,
    trackDurationMs
  );

  let totalW = 0;
  const weights = glyphs.map((g) => {
    const w = charWeight(g);
    totalW += w;
    return w;
  });

  let acc = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const cStart = line.timeMs + (acc / totalW) * lineDur;
    acc += weights[i];
    const cEnd = line.timeMs + (acc / totalW) * lineDur;
    timed.push({ char: glyphs[i], startMs: cStart, endMs: Math.max(cStart + 18, cEnd) });
  }

  return timed;
}

/**
 * Computes per-character loading-bar fill (0..1) and smooth wave jump offsets
 * grouped into non-breaking word chunks so line wrapping stays clean.
 */
export function computeLetterProgression(
  line: LyricLine,
  nextLineTimeMs: number | null,
  trackDurationMs: number,
  currentMs: number
): WordCharGroup[] {
  const timed = buildTimedChars(line, nextLineTimeMs, trackDurationMs);
  const groups: WordCharGroup[] = [];

  const WAVE_HALF_WIDTH_MS = 165;
  const MAX_HOP_PX = 5.5;
  const MAX_SCALE_BOOST = 0.065;

  let currentGroup: WordCharGroup | null = null;

  for (const item of timed) {
    const isSpace = item.char === ' ';
    const fill = clamp((currentMs - item.startMs) / Math.max(1, item.endMs - item.startMs), 0, 1);

    let hopPx = 0;
    let scale = 1;
    if (!isSpace) {
      const midMs = (item.startMs + item.endMs) * 0.5;
      const dist = Math.abs(currentMs - midMs) / WAVE_HALF_WIDTH_MS;
      if (dist < 1) {
        // Smooth raised-cosine wave peaking right as the loading bar sweeps through the letter
        const wave = 0.5 * (1 + Math.cos(dist * Math.PI));
        hopPx = -MAX_HOP_PX * wave;
        scale = 1 + MAX_SCALE_BOOST * wave;
      }
    }

    const cp: CharProgress = { char: item.char, fill, hopPx, scale };

    if (!currentGroup || currentGroup.isSpace !== isSpace) {
      currentGroup = { isSpace, chars: [cp] };
      groups.push(currentGroup);
    } else {
      currentGroup.chars.push(cp);
    }
  }

  return groups;
}
