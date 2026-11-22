import type { LyricLine, LyricsResult, TrackInfo, WordTiming } from './types';
import { normalizeForCompare, normalizeTrackTitle } from './titleNormalize';

export interface LrcLibRecord {
  id: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsPlusSyllabus {
  time: number;
  duration?: number;
  text: string;
  isBackground?: boolean;
}

export interface LyricsPlusLine {
  time: number;
  duration?: number;
  text?: string;
  syllabus?: LyricsPlusSyllabus[];
  element?: {
    isBackground?: boolean;
  };
}

export interface LyricsPlusResponse {
  type?: string;
  metadata?: {
    source?: string;
    totalDuration?: string;
  };
  lyrics?: LyricsPlusLine[];
}

const LYRICSPLUS_BASE = 'https://lyricsplus.prjktla.my.id/v2/lyrics/get';
const LYRICSPLUS_SOURCES = 'apple,lyricsplus,musixmatch,spotify';
const LYRICSPLUS_TIMEOUT_MS = 2800;

const LRCLIB_BASE = 'https://lrclib.net/api';
const CLIENT_ID_HEADER =
  'SpotifyVisualizer/1.0.0 (https://github.com/LasseHartmann/Spotify-Visualizer)';

const ENHANCED_WORD_TAG_REGEX = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/;

export function hasEnhancedWordTags(syncedLyrics?: string | null): boolean {
  return Boolean(syncedLyrics && ENHANCED_WORD_TAG_REGEX.test(syncedLyrics));
}

export function parseDurationStringSec(raw?: string): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Converts a LyricsPlus JSON payload into validated, structured LyricLines.
 * Returns null if the payload is empty, malformed, or fails duration validation.
 */
export function parseLyricsPlusResponse(
  trackId: string,
  data: LyricsPlusResponse | null,
  expectedDurationSec: number
): LyricsResult | null {
  if (!data || !Array.isArray(data.lyrics) || data.lyrics.length === 0) {
    return null;
  }

  // Reject if reported totalDuration strongly disagrees with Spotify's track length
  const metaDurSec = parseDurationStringSec(data.metadata?.totalDuration);
  if (metaDurSec !== null && expectedDurationSec > 0) {
    if (Math.abs(metaDurSec - expectedDurationSec) > 14) {
      return null;
    }
  }

  const rawLines: LyricLine[] = [];
  let linesWithWords = 0;

  for (const item of data.lyrics) {
    if (typeof item.time !== 'number' || !Number.isFinite(item.time) || item.time < 0) {
      continue;
    }

    const timeMs = Math.round(item.time);
    const durMs =
      typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0
        ? Math.round(item.duration)
        : undefined;
    const endTimeMs = durMs !== undefined ? timeMs + durMs : undefined;

    let words: WordTiming[] | undefined;
    if (Array.isArray(item.syllabus) && item.syllabus.length > 0) {
      const validWords: WordTiming[] = [];
      for (const s of item.syllabus) {
        if (
          typeof s.time !== 'number' ||
          !Number.isFinite(s.time) ||
          typeof s.text !== 'string' ||
          s.text.length === 0
        ) {
          continue;
        }
        const wStart = Math.max(0, Math.round(s.time));
        const wDur =
          typeof s.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0
            ? Math.round(s.duration)
            : undefined;
        validWords.push({
          timeMs: wStart,
          endTimeMs: wDur !== undefined ? wStart + Math.max(20, wDur) : undefined,
          text: s.text,
          isBackground: Boolean(s.isBackground || item.element?.isBackground) || undefined,
        });
      }
      if (validWords.length > 0) {
        words = validWords;
        linesWithWords++;
      }
    }

    const reconstructedText = (
      item.text && item.text.trim().length > 0
        ? item.text
        : words
          ? words.map((w) => w.text).join('')
          : ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    if (!reconstructedText) continue;

    rawLines.push({
      timeMs,
      endTimeMs,
      text: reconstructedText,
      words,
    });
  }

  if (rawLines.length === 0) return null;

  rawLines.sort((a, b) => a.timeMs - b.timeMs);

  // Sanity-check last lyric timestamp against track duration
  if (expectedDurationSec > 0) {
    const lastLine = rawLines[rawLines.length - 1];
    const lastSec = (lastLine.endTimeMs ?? lastLine.timeMs) / 1000;
    if (lastSec > expectedDurationSec + 20) {
      return null;
    }
  }

  // Insert clean empty instrumental-break markers when there is a >= 12s vocal pause
  const richLines: LyricLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    richLines.push(line);
    if (i + 1 < rawLines.length && line.endTimeMs !== undefined) {
      const nextLine = rawLines[i + 1];
      if (nextLine.timeMs - line.endTimeMs >= 12_000) {
        richLines.push({
          timeMs: line.endTimeMs + 900,
          text: '',
        });
      }
    }
  }

  const isWordType =
    (data.type ?? '').toLowerCase() === 'word' &&
    linesWithWords >= Math.max(1, Math.floor(rawLines.length * 0.3));

  return {
    trackId,
    status: 'synced',
    syncedLyrics: null,
    richLines,
    hasWordSync: isWordType,
    plainLyrics: rawLines.map((l) => l.text).join('\n'),
    source: 'lyricsplus',
  };
}

async function fetchLyricsPlus(
  track: TrackInfo,
  durationSec: number
): Promise<LyricsResult | null> {
  const cleanTitle = normalizeTrackTitle(track.name) || track.name;
  const primaryArtist = track.artists[0] ?? '';
  if (!cleanTitle || !primaryArtist) return null;

  const params = new URLSearchParams({
    title: cleanTitle,
    artist: primaryArtist,
    source: LYRICSPLUS_SOURCES,
  });
  if (track.album) {
    params.set('album', normalizeTrackTitle(track.album) || track.album);
  }
  if (durationSec > 0) {
    params.set('duration', String(durationSec));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LYRICSPLUS_TIMEOUT_MS);

  try {
    const res = await fetch(`${LYRICSPLUS_BASE}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as LyricsPlusResponse;
    return parseLyricsPlusResponse(track.id, data, durationSec);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildLrclibHeaders(isBrowser: boolean): Record<string, string> {
  if (isBrowser) {
    return { 'Lrclib-Client': CLIENT_ID_HEADER };
  }
  return {
    'User-Agent': CLIENT_ID_HEADER,
    'Lrclib-Client': CLIENT_ID_HEADER,
  };
}

async function queryLrclibGet(
  trackName: string,
  artistName: string,
  albumName: string,
  durationSec: number,
  isBrowser: boolean
): Promise<LrcLibRecord | null> {
  const params = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName,
    duration: String(durationSec),
  });
  if (albumName) {
    params.set('album_name', albumName);
  }

  const res = await fetch(`${LRCLIB_BASE}/get?${params.toString()}`, {
    headers: buildLrclibHeaders(isBrowser),
  });

  if (res.status === 404 || !res.ok) return null;
  return (await res.json()) as LrcLibRecord;
}

async function queryLrclibSearch(
  trackName: string,
  artistName: string,
  isBrowser: boolean
): Promise<LrcLibRecord[]> {
  const params = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName,
  });

  const res = await fetch(`${LRCLIB_BASE}/search?${params.toString()}`, {
    headers: buildLrclibHeaders(isBrowser),
  });

  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as LrcLibRecord[]) : [];
}

export function pickBestLrclibCandidate(
  candidates: LrcLibRecord[],
  cleanTitle: string,
  artistName: string,
  durationSec: number
): LrcLibRecord | null {
  if (candidates.length === 0) return null;

  const targetTitle = normalizeForCompare(cleanTitle);
  const targetArtist = normalizeForCompare(artistName);

  let bestRecord: LrcLibRecord | null = null;
  let bestScore = -Infinity;

  for (const item of candidates) {
    let score = 0;

    if (item.syncedLyrics && item.syncedLyrics.trim().length > 0) {
      score += 100;
      // Strongly prefer Enhanced LRC (<mm:ss.xx> word-synced) entries over line-only LRC!
      if (hasEnhancedWordTags(item.syncedLyrics)) {
        score += 65;
      }
    } else if (item.instrumental) {
      score += 50;
    } else if (item.plainLyrics && item.plainLyrics.trim().length > 0) {
      score += 20;
    } else {
      continue;
    }

    const itemTitle = normalizeForCompare(normalizeTrackTitle(item.trackName ?? ''));
    const itemArtist = normalizeForCompare(item.artistName ?? '');

    if (itemTitle === targetTitle) score += 35;
    else if (itemTitle.includes(targetTitle) || targetTitle.includes(itemTitle)) score += 15;

    if (itemArtist === targetArtist) score += 30;
    else if (itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist)) score += 15;

    if (typeof item.duration === 'number' && durationSec > 0) {
      const diff = Math.abs(item.duration - durationSec);
      if (diff <= 2) score += 40;
      else if (diff <= 5) score += 25;
      else if (diff <= 10) score += 8;
      else score -= diff * 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRecord = item;
    }
  }

  return bestScore >= 40 ? bestRecord : null;
}

export function lrclibRecordToResult(trackId: string, record: LrcLibRecord): LyricsResult {
  if (record.syncedLyrics && record.syncedLyrics.trim().length > 0) {
    return {
      trackId,
      status: 'synced',
      syncedLyrics: record.syncedLyrics,
      richLines: null,
      hasWordSync: hasEnhancedWordTags(record.syncedLyrics),
      plainLyrics: record.plainLyrics ?? null,
      source: 'lrclib',
    };
  }
  if (record.instrumental) {
    return {
      trackId,
      status: 'instrumental',
      syncedLyrics: null,
      richLines: null,
      hasWordSync: false,
      plainLyrics: null,
      source: 'lrclib',
    };
  }
  if (record.plainLyrics && record.plainLyrics.trim().length > 0) {
    return {
      trackId,
      status: 'plain',
      syncedLyrics: null,
      richLines: null,
      hasWordSync: false,
      plainLyrics: record.plainLyrics,
      source: 'lrclib',
    };
  }
  return {
    trackId,
    status: 'not_found',
    syncedLyrics: null,
    richLines: null,
    hasWordSync: false,
    plainLyrics: null,
    source: 'none',
  };
}

/**
 * 2-tier lyrics resolver:
 * 1. Tier 1: LyricsPlus (Apple Music / Musixmatch / Spotify syllable & word-level timing, 2.8s timeout).
 * 2. Tier 2: LRCLIB (/api/get + /api/search, preferring Enhanced LRC <mm:ss.xx> word-synced entries).
 */
export async function fetchLrclibLyrics(
  track: TrackInfo,
  isBrowser: boolean
): Promise<LyricsResult> {
  const primaryArtist = track.artists[0] ?? '';
  const durationSec = Math.round(track.durationMs / 1000);
  const cleanTitle = normalizeTrackTitle(track.name);

  // Tier 1: Try LyricsPlus for true syllable/word-synced timing
  const lyricsPlusResult = await fetchLyricsPlus(track, durationSec);
  if (lyricsPlusResult && lyricsPlusResult.hasWordSync) {
    return lyricsPlusResult;
  }

  // Tier 2: LRCLIB (also prefers Enhanced LRC word-synced entries over line-only entries!)
  try {
    const exact = await queryLrclibGet(
      track.name,
      primaryArtist,
      track.album,
      durationSec,
      isBrowser
    );

    if (exact && hasEnhancedWordTags(exact.syncedLyrics)) {
      return lrclibRecordToResult(track.id, exact);
    }

    // Even if /api/get returned line-only synced lyrics, check /api/search for an Enhanced LRC upgrade
    const searchCandidates = await queryLrclibSearch(cleanTitle, primaryArtist, isBrowser);
    const best = pickBestLrclibCandidate(searchCandidates, cleanTitle, primaryArtist, durationSec);

    if (best && hasEnhancedWordTags(best.syncedLyrics)) {
      return lrclibRecordToResult(track.id, best);
    }

    if (exact && (exact.syncedLyrics || exact.instrumental)) {
      return lrclibRecordToResult(track.id, exact);
    }

    if (best && (best.syncedLyrics || best.instrumental)) {
      return lrclibRecordToResult(track.id, best);
    }

    // If LRCLIB had no synced entry, use line-synced LyricsPlus if we got one earlier
    if (lyricsPlusResult) {
      return lyricsPlusResult;
    }

    const plainRecord = exact?.plainLyrics ? exact : best?.plainLyrics ? best : null;
    if (plainRecord) {
      return lrclibRecordToResult(track.id, plainRecord);
    }

    return {
      trackId: track.id,
      status: 'not_found',
      syncedLyrics: null,
      richLines: null,
      hasWordSync: false,
      plainLyrics: null,
      source: 'none',
    };
  } catch {
    if (lyricsPlusResult) {
      return lyricsPlusResult;
    }
    return {
      trackId: track.id,
      status: 'error',
      syncedLyrics: null,
      richLines: null,
      hasWordSync: false,
      plainLyrics: null,
      source: 'none',
    };
  }
}
