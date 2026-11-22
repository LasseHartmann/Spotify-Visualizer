import type { LyricLine } from '@shared/types';

export interface CharProgress {
  char: string;
  /** 0 = upcoming, 0..1 = loading bar sweeping through this letter, 1 = fully lit */
  fill: number;
  /** Smooth vertical lift (negative px = jumps upward as highlighted, settles back to 0) */
  hopPx: number;
  /** Subtle scale boost at peak of the letter jump (1.0 .. 1.065) */
  scale: number;
  /** True for subtle parenthetical background vocal syllables when supplied */
  isBackground?: boolean;
}

export interface WordCharGroup {
  isSpace: boolean;
  chars: CharProgress[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function charWeight(ch: string, hasExplicitEnd = false): number {
  if (ch === ' ') return hasExplicitEnd ? 0.12 : 0.35;
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
  trackDurationMs: number,
  explicitLineEndMs?: number
): number {
  if (
    typeof explicitLineEndMs === 'number' &&
    Number.isFinite(explicitLineEndMs) &&
    explicitLineEndMs > lineStartMs
  ) {
    return clamp(explicitLineEndMs - lineStartMs, 250, 14_000);
  }

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
  isBackground?: boolean;
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
      estimateLineDurationMs(
        line.text,
        line.timeMs,
        nextLineTimeMs,
        trackDurationMs,
        line.endTimeMs
      );

    for (let wIdx = 0; wIdx < line.words.length; wIdx++) {
      const word = line.words[wIdx];
      const wordStart = word.timeMs;
      const hasExplicitEnd =
        typeof word.endTimeMs === 'number' &&
        Number.isFinite(word.endTimeMs) &&
        word.endTimeMs > wordStart;

      let wordDur: number;
      if (hasExplicitEnd) {
        // Exact millisecond syllable/word duration (e.g. Apple Music TTML via LyricsPlus)
        wordDur = clamp(word.endTimeMs! - wordStart, 35, 8000);
      } else {
        // Enhanced LRC <mm:ss.xx> without explicit end time: span until next word
        const nextWordStart =
          wIdx + 1 < line.words.length ? line.words[wIdx + 1].timeMs : lineEndMs;
        wordDur = clamp(nextWordStart - wordStart, 90, 3500);
      }

      const glyphs = Array.from(word.text);
      let totalW = 0;
      const weights = glyphs.map((g) => {
        const w = charWeight(g, hasExplicitEnd);
        totalW += w;
        return w;
      });
      if (totalW <= 0) continue;

      let acc = 0;
      for (let i = 0; i < glyphs.length; i++) {
        const cStart = wordStart + (acc / totalW) * wordDur;
        acc += weights[i];
        const cEnd = wordStart + (acc / totalW) * wordDur;
        timed.push({
          char: glyphs[i],
          startMs: cStart,
          endMs: Math.max(cStart + 18, cEnd),
          isBackground: word.isBackground,
        });
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
    trackDurationMs,
    line.endTimeMs
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
 * grouped into non-breaking word chunks so line wrapping stays clean even when
 * a single word is split into multiple timed syllables (e.g. "fan" + "ta" + "sy?").
 */
export function computeLetterProgression(
  line: LyricLine,
  nextLineTimeMs: number | null,
  trackDurationMs: number,
  currentMs: number
): WordCharGroup[] {
  const timed = buildTimedChars(line, nextLineTimeMs, trackDurationMs);
  const groups: WordCharGroup[] = [];

  const MAX_HOP_PX = 5.5;
  const MAX_SCALE_BOOST = 0.065;

  let currentGroup: WordCharGroup | null = null;

  for (const item of timed) {
    const isSpace = item.char === ' ';
    const charDur = Math.max(18, item.endMs - item.startMs);
    const fill = clamp((currentMs - item.startMs) / charDur, 0, 1);

    let hopPx = 0;
    let scale = 1;
    if (!isSpace) {
      // Adaptive wave width: snappy ripple on fast syllables, graceful buoyant lift on long held notes
      const waveHalfWidthMs = clamp(charDur * 0.72, 155, 340);
      const midMs = (item.startMs + item.endMs) * 0.5;
      const dist = Math.abs(currentMs - midMs) / waveHalfWidthMs;
      if (dist < 1) {
        const wave = 0.5 * (1 + Math.cos(dist * Math.PI));
        hopPx = -MAX_HOP_PX * wave;
        scale = 1 + MAX_SCALE_BOOST * wave;
      }
    }

    const cp: CharProgress = {
      char: item.char,
      fill,
      hopPx,
      scale,
      isBackground: item.isBackground,
    };

    if (!currentGroup || currentGroup.isSpace !== isSpace) {
      currentGroup = { isSpace, chars: [cp] };
      groups.push(currentGroup);
    } else {
      currentGroup.chars.push(cp);
    }
  }

  return groups;
}
