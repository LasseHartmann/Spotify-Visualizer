import type { LyricsResult, TrackInfo } from './types';
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

const LRCLIB_BASE = 'https://lrclib.net/api';
const CLIENT_ID_HEADER = 'SpotifyVisualizer/1.0.0 (https://github.com/LasseHartmann/Spotify-Visualizer)';

function buildHeaders(isBrowser: boolean): Record<string, string> {
  if (isBrowser) {
    return {
      'Lrclib-Client': CLIENT_ID_HEADER,
    };
  }
  return {
    'User-Agent': CLIENT_ID_HEADER,
    'Lrclib-Client': CLIENT_ID_HEADER,
  };
}

async function queryGet(
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
    headers: buildHeaders(isBrowser),
  });

  if (res.status === 404 || !res.ok) return null;
  return (await res.json()) as LrcLibRecord;
}

async function querySearch(
  trackName: string,
  artistName: string,
  isBrowser: boolean
): Promise<LrcLibRecord[]> {
  const params = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName,
  });

  const res = await fetch(`${LRCLIB_BASE}/search?${params.toString()}`, {
    headers: buildHeaders(isBrowser),
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
      plainLyrics: record.plainLyrics ?? null,
      source: 'lrclib',
    };
  }
  if (record.instrumental) {
    return {
      trackId,
      status: 'instrumental',
      syncedLyrics: null,
      plainLyrics: null,
      source: 'lrclib',
    };
  }
  if (record.plainLyrics && record.plainLyrics.trim().length > 0) {
    return {
      trackId,
      status: 'plain',
      syncedLyrics: null,
      plainLyrics: record.plainLyrics,
      source: 'lrclib',
    };
  }
  return {
    trackId,
    status: 'not_found',
    syncedLyrics: null,
    plainLyrics: null,
    source: 'none',
  };
}

export async function fetchLrclibLyrics(
  track: TrackInfo,
  isBrowser: boolean
): Promise<LyricsResult> {
  const primaryArtist = track.artists[0] ?? '';
  const durationSec = Math.round(track.durationMs / 1000);

  try {
    // 1. Exact lookup via /api/get
    const exact = await queryGet(track.name, primaryArtist, track.album, durationSec, isBrowser);
    if (exact && (exact.syncedLyrics || exact.instrumental)) {
      return lrclibRecordToResult(track.id, exact);
    }

    // 2. Fallback search with normalized track title
    const cleanTitle = normalizeTrackTitle(track.name);
    const searchCandidates = await querySearch(cleanTitle, primaryArtist, isBrowser);
    const best = pickBestLrclibCandidate(searchCandidates, cleanTitle, primaryArtist, durationSec);

    if (best && (best.syncedLyrics || best.instrumental)) {
      return lrclibRecordToResult(track.id, best);
    }

    // 3. Fallback to plain lyrics if either exact or search had them
    const plainRecord = exact?.plainLyrics ? exact : best?.plainLyrics ? best : null;
    if (plainRecord) {
      return lrclibRecordToResult(track.id, plainRecord);
    }

    return {
      trackId: track.id,
      status: 'not_found',
      syncedLyrics: null,
      plainLyrics: null,
      source: 'none',
    };
  } catch {
    return {
      trackId: track.id,
      status: 'error',
      syncedLyrics: null,
      plainLyrics: null,
      source: 'none',
    };
  }
}
