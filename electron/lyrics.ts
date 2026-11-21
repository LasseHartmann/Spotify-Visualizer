import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { LyricsResult, TrackInfo } from '@shared/types';
import { normalizeForCompare, normalizeTrackTitle } from '@shared/titleNormalize';

interface LrcLibRecord {
  id: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

interface CacheEntry {
  result: LyricsResult;
  cachedAt: number;
}

const LRCLIB_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'SpotifyVisualizer/1.0.0 (Personal Windows Desktop Visualizer)';
const MAX_CACHE_ENTRIES = 500;
const NOT_FOUND_TTL_MS = 1000 * 60 * 60 * 12; // retry missing tracks after 12h

export class LyricsService {
  private cache = new Map<string, CacheEntry>();
  private offsets = new Map<string, number>();

  private get cacheFilePath(): string {
    return path.join(app.getPath('userData'), 'lyrics-cache.json');
  }

  private get offsetsFilePath(): string {
    return path.join(app.getPath('userData'), 'lyrics-offsets.json');
  }

  public init(): void {
    this.loadCache();
    this.loadOffsets();
  }

  public getOffset(trackId: string): number {
    return this.offsets.get(trackId) ?? 0;
  }

  public setOffset(trackId: string, offsetMs: number): void {
    const clamped = Math.max(-15_000, Math.min(15_000, Math.round(offsetMs)));
    if (clamped === 0) {
      this.offsets.delete(trackId);
    } else {
      this.offsets.set(trackId, clamped);
    }
    this.saveOffsets();
  }

  public async fetchLyrics(track: TrackInfo): Promise<LyricsResult> {
    const cached = this.cache.get(track.id);
    if (cached) {
      const expiredNotFound =
        cached.result.status === 'not_found' &&
        Date.now() - cached.cachedAt > NOT_FOUND_TTL_MS;
      if (!expiredNotFound) {
        return { ...cached.result, source: 'cache' };
      }
    }

    const primaryArtist = track.artists[0] ?? '';
    const durationSec = Math.round(track.durationMs / 1000);

    try {
      // 1. Exact lookup via /api/get
      const exact = await this.queryGet(track.name, primaryArtist, track.album, durationSec);
      if (exact && (exact.syncedLyrics || exact.instrumental)) {
        const result = this.recordToResult(track.id, exact);
        this.putCache(track.id, result);
        return result;
      }

      // 2. Fallback search with normalized track title
      const cleanTitle = normalizeTrackTitle(track.name);
      const searchCandidates = await this.querySearch(cleanTitle, primaryArtist);
      const best = this.pickBestCandidate(
        searchCandidates,
        cleanTitle,
        primaryArtist,
        durationSec
      );

      if (best && (best.syncedLyrics || best.instrumental)) {
        const result = this.recordToResult(track.id, best);
        this.putCache(track.id, result);
        return result;
      }

      // 3. Fallback to plain lyrics if either exact or search had them
      const plainRecord = exact?.plainLyrics ? exact : best?.plainLyrics ? best : null;
      if (plainRecord) {
        const result = this.recordToResult(track.id, plainRecord);
        this.putCache(track.id, result);
        return result;
      }

      const notFound: LyricsResult = {
        trackId: track.id,
        status: 'not_found',
        syncedLyrics: null,
        plainLyrics: null,
        source: 'none',
      };
      this.putCache(track.id, notFound);
      return notFound;
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

  private async queryGet(
    trackName: string,
    artistName: string,
    albumName: string,
    durationSec: number
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
      headers: {
        'User-Agent': USER_AGENT,
        'Lrclib-Client': USER_AGENT,
      },
    });

    if (res.status === 404 || !res.ok) return null;
    return (await res.json()) as LrcLibRecord;
  }

  private async querySearch(trackName: string, artistName: string): Promise<LrcLibRecord[]> {
    const params = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
    });

    const res = await fetch(`${LRCLIB_BASE}/search?${params.toString()}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Lrclib-Client': USER_AGENT,
      },
    });

    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as LrcLibRecord[]) : [];
  }

  private pickBestCandidate(
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

  private recordToResult(trackId: string, record: LrcLibRecord): LyricsResult {
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

  private putCache(trackId: string, result: LyricsResult): void {
    this.cache.delete(trackId);
    this.cache.set(trackId, { result, cachedAt: Date.now() });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.saveCache();
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cacheFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf-8')) as Record<
        string,
        CacheEntry
      >;
      for (const [k, v] of Object.entries(raw)) {
        this.cache.set(k, v);
      }
    } catch {
      // ignore corrupted cache
    }
  }

  private saveCache(): void {
    try {
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true });
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(obj));
    } catch {
      // ignore write failures
    }
  }

  private loadOffsets(): void {
    try {
      if (!fs.existsSync(this.offsetsFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.offsetsFilePath, 'utf-8')) as Record<
        string,
        number
      >;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.offsets.set(k, v);
        }
      }
    } catch {
      // ignore
    }
  }

  private saveOffsets(): void {
    try {
      const obj: Record<string, number> = {};
      for (const [k, v] of this.offsets.entries()) {
        obj[k] = v;
      }
      fs.mkdirSync(path.dirname(this.offsetsFilePath), { recursive: true });
      fs.writeFileSync(this.offsetsFilePath, JSON.stringify(obj));
    } catch {
      // ignore
    }
  }
}
