import type { LyricLine, WordTiming } from '@shared/types';

const LINE_TIME_REGEX = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG_REGEX = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
const WORD_TIME_REGEX = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

function parseTimestampMs(minStr: string, secStr: string, fracStr?: string): number {
  const minutes = Number(minStr);
  const seconds = Number(secStr);
  let ms = 0;
  if (fracStr) {
    if (fracStr.length === 1) ms = Number(fracStr) * 100;
    else if (fracStr.length === 2) ms = Number(fracStr) * 10;
    else ms = Number(fracStr.slice(0, 3));
  }
  return minutes * 60_000 + seconds * 1000 + ms;
}

function parseEnhancedWords(rawText: string, lineTimeMs: number, offsetMs: number): {
  cleanText: string;
  words?: WordTiming[];
} {
  WORD_TIME_REGEX.lastIndex = 0;
  if (!WORD_TIME_REGEX.test(rawText)) {
    return { cleanText: rawText.trim() };
  }

  WORD_TIME_REGEX.lastIndex = 0;
  const matches: Array<{ index: number; end: number; timeMs: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = WORD_TIME_REGEX.exec(rawText)) !== null) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      timeMs: Math.max(0, parseTimestampMs(m[1], m[2], m[3]) - offsetMs),
    });
  }

  const words: WordTiming[] = [];
  const prefix = rawText.slice(0, matches[0].index);
  if (prefix.trim().length > 0) {
    words.push({ timeMs: lineTimeMs, text: prefix });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    const segment = rawText.slice(start, end);
    if (segment.length > 0) {
      words.push({
        timeMs: matches[i].timeMs,
        text: segment,
      });
    }
  }

  const cleanText = words
    .map((w) => w.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    cleanText,
    words: words.length > 0 ? words : undefined,
  };
}

export function parseLrc(lrcText: string): LyricLine[] {
  if (!lrcText || !lrcText.trim()) return [];

  const rawLines = lrcText.split(/\r?\n/);
  let lrcOffsetMs = 0;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    const offsetMatch = OFFSET_TAG_REGEX.exec(trimmed);
    if (offsetMatch) {
      lrcOffsetMs = Number(offsetMatch[1]) || 0;
      break;
    }
  }

  const parsed: LyricLine[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    LINE_TIME_REGEX.lastIndex = 0;
    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastEnd = 0;

    while ((match = LINE_TIME_REGEX.exec(trimmed)) !== null) {
      const timeMs = Math.max(
        0,
        parseTimestampMs(match[1], match[2], match[3]) - lrcOffsetMs
      );
      timestamps.push(timeMs);
      lastEnd = match.index + match[0].length;
    }

    if (timestamps.length === 0) continue;

    const rest = trimmed.slice(lastEnd);

    for (const timeMs of timestamps) {
      const { cleanText, words } = parseEnhancedWords(rest, timeMs, lrcOffsetMs);
      parsed.push({
        timeMs,
        text: cleanText,
        words,
      });
    }
  }

  parsed.sort((a, b) => a.timeMs - b.timeMs);

  // Deduplicate identical consecutive empty instrumental markers
  const cleaned: LyricLine[] = [];
  for (const line of parsed) {
    const prev = cleaned[cleaned.length - 1];
    if (line.text === '' && (!prev || prev.text === '')) {
      continue;
    }
    cleaned.push(line);
  }

  // Strip trailing empty line
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].text === '') {
    cleaned.pop();
  }

  return cleaned;
}

/**
 * Returns the index of the active lyric line for `currentMs`, or -1 if before the first line.
 */
export function findActiveLineIndex(lines: LyricLine[], currentMs: number): number {
  if (lines.length === 0 || currentMs < lines[0].timeMs) {
    return -1;
  }

  let lo = 0;
  let hi = lines.length - 1;
  let ans = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= currentMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return ans;
}
