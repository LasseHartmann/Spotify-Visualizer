import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { LyricsResult, TrackInfo } from '@shared/types';
import { fetchLrclibLyrics } from '@shared/lyricsLookup';

interface CacheEntry {
  result: LyricsResult;
  cachedAt: number;
}

const MAX_CACHE_ENTRIES = 500;
const NOT_FOUND_TTL_MS = 1000 * 60 * 60 * 12; // retry missing tracks after 12h

export class LyricsService {
  private cache = new Map<string, CacheEntry>();
  private offsets = new Map<string, number>();

  private get cacheFilePath(): string {
    return path.join(app.getPath('userData'), 'lyrics-cache-v2.json');
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

    const result = await fetchLrclibLyrics(track, false);
    if (result.status !== 'error') {
      this.putCache(track.id, result);
    }
    return result;
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
