import type {
  AuthState,
  LyricsResult,
  NativeAudioPacket,
  PlaybackControlAction,
  PlaybackState,
  SpotifyUserProfile,
  TrackInfo,
  VisualizerApi,
} from '@shared/types';
import { fetchLrclibLyrics } from '@shared/lyricsLookup';

const SPOTIFY_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

const KEY_CLIENT_ID = 'sv:web:clientId';
const KEY_SESSION = 'sv:web:session';
const KEY_PKCE = 'sv:web:pkce';
const KEY_LYRICS_CACHE = 'sv:web:lyricsCache';
const KEY_LYRICS_OFFSETS = 'sv:web:lyricsOffsets';

const MAX_WEB_LYRICS_CACHE = 120;
const NOT_FOUND_TTL_MS = 1000 * 60 * 60 * 12;

interface StoredWebSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  user: SpotifyUserProfile | null;
}

interface PendingPkce {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}

interface CacheEntry {
  result: LyricsResult;
  cachedAt: number;
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface SpotifyMeResponse {
  id: string;
  display_name?: string;
  images?: Array<{ url: string }>;
}

interface SpotifyCurrentlyPlayingResponse {
  is_playing: boolean;
  progress_ms: number | null;
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
  item?: {
    id: string | null;
    name: string;
    duration_ms: number;
    is_local?: boolean;
    artists?: Array<{ name: string }>;
    album?: {
      name: string;
      images?: Array<{ url: string }>;
    };
  } | null;
}

export function isValidSpotifyClientId(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value.trim());
}

export function getWebRedirectUri(origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '');
  return `${base}/callback`;
}

export function buildSpotifyAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    scope: SPOTIFY_SCOPES,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge_method: 'S256',
    code_challenge: params.codeChallenge,
    show_dialog: 'true',
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${qs.toString()}`;
}

export function parseOAuthCallbackParams(search: string): {
  code: string | null;
  state: string | null;
  error: string | null;
} {
  const qs = new URLSearchParams(search);
  return {
    code: qs.get('code'),
    state: qs.get('state'),
    error: qs.get('error'),
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateBrowserPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const randomBytes = new Uint8Array(64);
  crypto.getRandomValues(randomBytes);
  const verifier = base64UrlEncode(randomBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function randomHexState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readJsonStorage<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonStorage(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage quota errors
  }
}

function readDefaultClientId(): string {
  const envId =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_SPOTIFY_CLIENT_ID === 'string'
      ? import.meta.env.VITE_SPOTIFY_CLIENT_ID.trim()
      : '';
  return isValidSpotifyClientId(envId) ? envId : '';
}

class WebAudioTap {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId = 0;
  private freqBins = new Uint8Array(1024);
  private timeBins = new Uint8Array(2048);
  private frameListeners = new Set<(packet: NativeAudioPacket) => void>();
  private stoppedListeners = new Set<() => void>();

  public async start(source: string): Promise<boolean> {
    this.stop(false);

    if (!navigator.mediaDevices) {
      return false;
    }

    try {
      let mediaStream: MediaStream;
      if (source === 'mic') {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
      } else {
        // Tab / Screen audio capture via getDisplayMedia
        // Keep a tiny 1x1@1fps video constraint so Chromium never terminates the share stream
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1, frameRate: 1 },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      const audioTracks = mediaStream.getAudioTracks();
      if (audioTracks.length === 0) {
        mediaStream.getTracks().forEach((t) => t.stop());
        return false;
      }

      const audioOnlyStream = new MediaStream(audioTracks);
      const AudioCtxCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtxCtor();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const sourceNode = ctx.createMediaStreamSource(audioOnlyStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      sourceNode.connect(analyser);

      this.stream = mediaStream;
      this.audioCtx = ctx;
      this.analyser = analyser;
      this.freqBins = new Uint8Array(analyser.frequencyBinCount);
      this.timeBins = new Uint8Array(analyser.fftSize);

      const handleEnded = () => {
        this.stop(true);
      };
      for (const track of mediaStream.getTracks()) {
        track.addEventListener('ended', handleEnded, { once: true });
      }

      const pump = () => {
        if (!this.analyser || !this.audioCtx) return;
        this.rafId = requestAnimationFrame(pump);

        this.analyser.getByteFrequencyData(this.freqBins);
        this.analyser.getByteTimeDomainData(this.timeBins);

        const packet: NativeAudioPacket = {
          sampleRate: this.audioCtx.sampleRate || 48000,
          freqBins: this.freqBins,
          timeBins: this.timeBins,
        };
        for (const cb of this.frameListeners) {
          cb(packet);
        }
      };

      this.rafId = requestAnimationFrame(pump);
      return true;
    } catch {
      this.stop(false);
      return false;
    }
  }

  public stop(notifyStopped = false): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.analyser = null;

    if (notifyStopped) {
      for (const cb of this.stoppedListeners) {
        cb();
      }
    }
  }

  public onFrame(cb: (packet: NativeAudioPacket) => void): () => void {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  public onStopped(cb: () => void): () => void {
    this.stoppedListeners.add(cb);
    return () => {
      this.stoppedListeners.delete(cb);
    };
  }
}

function createWebBridge(): VisualizerApi {
  let clientId = (localStorage.getItem(KEY_CLIENT_ID) ?? '').trim() || readDefaultClientId();
  let session = readJsonStorage<StoredWebSession>(localStorage, KEY_SESSION);
  if (session && !session.refreshToken) {
    session = null;
  }
  if (!clientId && session?.clientId) {
    clientId = session.clientId;
  }

  let isAuthenticating = false;
  let lastError: string | null = null;
  let lastErrorCode: AuthState['errorCode'] = null;
  let refreshPromise: Promise<void> | null = null;
  let rateLimitedUntilMs = 0;

  const audioTap = new WebAudioTap();

  const lyricsCache = new Map<string, CacheEntry>();
  const savedCache = readJsonStorage<Record<string, CacheEntry>>(localStorage, KEY_LYRICS_CACHE);
  if (savedCache) {
    for (const [k, v] of Object.entries(savedCache)) {
      lyricsCache.set(k, v);
    }
  }

  const lyricsOffsets = new Map<string, number>();
  const savedOffsets = readJsonStorage<Record<string, number>>(localStorage, KEY_LYRICS_OFFSETS);
  if (savedOffsets) {
    for (const [k, v] of Object.entries(savedOffsets)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        lyricsOffsets.set(k, v);
      }
    }
  }

  function getActiveClientId(): string {
    return (session?.clientId || clientId || readDefaultClientId()).trim();
  }

  function buildAuthState(): AuthState {
    return {
      isAuthenticated: Boolean(session?.refreshToken && getActiveClientId()),
      isAuthenticating,
      clientId,
      redirectUri: getWebRedirectUri(),
      user: session?.user ?? null,
      error: lastError,
      errorCode: lastErrorCode,
    };
  }

  function persistSession(next: StoredWebSession | null): void {
    session = next;
    if (next) {
      writeJsonStorage(localStorage, KEY_SESSION, next);
    } else {
      try {
        localStorage.removeItem(KEY_SESSION);
      } catch {
        // ignore
      }
    }
  }

  function clearPendingPkce(): void {
    try {
      sessionStorage.removeItem(KEY_PKCE);
      localStorage.removeItem(KEY_PKCE);
    } catch {
      // ignore
    }
  }

  async function fetchProfile(
    accessToken: string
  ): Promise<{ user: SpotifyUserProfile | null; allowlistBlocked: boolean }> {
    try {
      const res = await fetch(`${SPOTIFY_API_BASE}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 403) {
        return { user: null, allowlistBlocked: true };
      }
      if (!res.ok) {
        return { user: null, allowlistBlocked: false };
      }
      const data = (await res.json()) as SpotifyMeResponse;
      return {
        user: {
          id: data.id,
          displayName: data.display_name || data.id,
          avatarUrl: data.images?.[0]?.url ?? null,
        },
        allowlistBlocked: false,
      };
    } catch {
      return { user: null, allowlistBlocked: false };
    }
  }

  async function exchangeCodeForTokens(
    activeClientId: string,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<SpotifyTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: activeClientId,
      code_verifier: codeVerifier,
    });

    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spotify token exchange failed (${res.status}): ${text}`);
    }
    return (await res.json()) as SpotifyTokenResponse;
  }

  async function refreshAccessToken(): Promise<void> {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      if (!session?.refreshToken) throw new Error('Missing refresh token');
      const activeClientId = getActiveClientId();
      if (!activeClientId) throw new Error('Missing Spotify Client ID');

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: activeClientId,
      });

      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!res.ok) {
        throw new Error(`Token refresh failed (${res.status})`);
      }

      const data = (await res.json()) as SpotifyTokenResponse;
      persistSession({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || session.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        clientId: activeClientId,
        user: session.user,
      });
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function ensureFreshToken(): Promise<void> {
    if (!session) throw new Error('No session');
    if (Date.now() < session.expiresAt - 120_000) return;
    await refreshAccessToken();
  }

  // Handle Spotify OAuth callback immediately on load if returning to /callback?code=...
  const callbackReadyPromise: Promise<void> = (async () => {
    const { code, state, error } = parseOAuthCallbackParams(window.location.search);
    const isCallbackRoute =
      window.location.pathname === '/callback' ||
      window.location.pathname === '/callback/' ||
      Boolean(code) ||
      Boolean(error);

    if (!isCallbackRoute || (!code && !error)) {
      if (window.location.pathname === '/callback' || window.location.pathname === '/callback/') {
        window.history.replaceState({}, '', '/');
      }
      return;
    }

    // Clean query params out of the browser URL right away so reloads never replay stale codes
    window.history.replaceState({}, '', '/');

    if (error) {
      clearPendingPkce();
      lastError = `Spotify sign-in cancelled (${error}).`;
      lastErrorCode = 'auth_failed';
      return;
    }

    const pending =
      readJsonStorage<PendingPkce>(sessionStorage, KEY_PKCE) ??
      readJsonStorage<PendingPkce>(localStorage, KEY_PKCE);
    clearPendingPkce();

    if (!code || !pending || pending.state !== state) {
      lastError = 'OAuth state verification failed. Please click Connect with Spotify again.';
      lastErrorCode = 'auth_failed';
      return;
    }

    isAuthenticating = true;
    try {
      const tokenResp = await exchangeCodeForTokens(
        pending.clientId,
        code,
        pending.verifier,
        pending.redirectUri
      );

      clientId = pending.clientId;
      try {
        localStorage.setItem(KEY_CLIENT_ID, clientId);
      } catch {
        // ignore
      }

      const nextSession: StoredWebSession = {
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token ?? '',
        expiresAt: Date.now() + tokenResp.expires_in * 1000,
        clientId: pending.clientId,
        user: null,
      };

      const profileCheck = await fetchProfile(nextSession.accessToken);
      if (profileCheck.allowlistBlocked) {
        persistSession(null);
        lastErrorCode = 'allowlist';
        lastError =
          'Your Spotify account is not on this app’s allowlist yet. Add your Spotify email under User Management in your Spotify Developer Dashboard.';
      } else {
        nextSession.user = profileCheck.user;
        persistSession(nextSession);
        lastError = null;
        lastErrorCode = null;
      }
    } catch (err) {
      persistSession(null);
      lastError = err instanceof Error ? err.message : 'Spotify sign-in failed.';
      lastErrorCode = 'auth_failed';
    } finally {
      isAuthenticating = false;
    }
  })();

  function saveLyricsCache(): void {
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of lyricsCache.entries()) {
      obj[k] = v;
    }
    writeJsonStorage(localStorage, KEY_LYRICS_CACHE, obj);
  }

  function saveLyricsOffsets(): void {
    const obj: Record<string, number> = {};
    for (const [k, v] of lyricsOffsets.entries()) {
      obj[k] = v;
    }
    writeJsonStorage(localStorage, KEY_LYRICS_OFFSETS, obj);
  }

  return {
    platform: 'web',
    auth: {
      getState: async () => {
        await callbackReadyPromise;
        return buildAuthState();
      },
      setClientId: async (rawClientId: string) => {
        const cleaned = rawClientId.trim();
        if (cleaned === '') {
          clientId = '';
          try {
            localStorage.removeItem(KEY_CLIENT_ID);
          } catch {
            // ignore
          }
          lastError = null;
          lastErrorCode = null;
          return buildAuthState();
        }
        if (!isValidSpotifyClientId(cleaned)) {
          lastError =
            'Spotify Client IDs are 32-character hexadecimal strings (found under Settings in your Spotify Developer Dashboard).';
          lastErrorCode = 'missing_client_id';
          return buildAuthState();
        }
        clientId = cleaned;
        try {
          localStorage.setItem(KEY_CLIENT_ID, cleaned);
        } catch {
          // ignore
        }
        lastError = null;
        lastErrorCode = null;
        return buildAuthState();
      },
      login: async (clientIdOverride?: string) => {
        await callbackReadyPromise;
        lastError = null;
        lastErrorCode = null;

        const candidateId = (clientIdOverride ?? clientId).trim();
        if (!isValidSpotifyClientId(candidateId)) {
          lastError = 'Please enter your 32-character Spotify Client ID before connecting.';
          lastErrorCode = 'missing_client_id';
          return buildAuthState();
        }

        if (!window.crypto?.subtle) {
          lastError =
            'Browser OAuth PKCE requires HTTPS (or 127.0.0.1). Open this site over HTTPS.';
          lastErrorCode = 'auth_failed';
          return buildAuthState();
        }

        clientId = candidateId;
        try {
          localStorage.setItem(KEY_CLIENT_ID, candidateId);
        } catch {
          // ignore
        }

        isAuthenticating = true;
        const { verifier, challenge } = await generateBrowserPkcePair();
        const state = randomHexState();
        const redirectUri = getWebRedirectUri();
        const pending: PendingPkce = {
          verifier,
          state,
          clientId: candidateId,
          redirectUri,
          createdAt: Date.now(),
        };
        writeJsonStorage(sessionStorage, KEY_PKCE, pending);
        writeJsonStorage(localStorage, KEY_PKCE, pending);

        const authUrl = buildSpotifyAuthorizeUrl({
          clientId: candidateId,
          redirectUri,
          state,
          codeChallenge: challenge,
        });
        window.location.assign(authUrl);
        return buildAuthState();
      },
      logout: async () => {
        clearPendingPkce();
        persistSession(null);
        lastError = null;
        lastErrorCode = null;
        audioTap.stop(false);
        return buildAuthState();
      },
    },
    spotify: {
      getPlayback: async (): Promise<PlaybackState> => {
        if (!session) {
          return {
            status: 'error',
            track: null,
            progressMs: 0,
            fetchedAtMs: Date.now(),
            isPlaying: false,
            error: 'Not authenticated with Spotify.',
            errorCode: 'auth_expired',
          };
        }

        if (Date.now() < rateLimitedUntilMs) {
          return {
            status: 'error',
            track: null,
            progressMs: 0,
            fetchedAtMs: Date.now(),
            isPlaying: false,
            error: 'Spotify rate limit active; backing off briefly.',
            errorCode: 'rate_limited',
          };
        }

        try {
          await ensureFreshToken();
        } catch {
          persistSession(null);
          return {
            status: 'error',
            track: null,
            progressMs: 0,
            fetchedAtMs: Date.now(),
            isPlaying: false,
            error: 'Your Spotify session expired. Please sign in again.',
            errorCode: 'auth_expired',
          };
        }

        const t0 = Date.now();
        try {
          let res = await fetch(
            `${SPOTIFY_API_BASE}/me/player/currently-playing?additional_types=track`,
            {
              headers: { Authorization: `Bearer ${session.accessToken}` },
            }
          );

          if (res.status === 401) {
            await refreshAccessToken();
            res = await fetch(
              `${SPOTIFY_API_BASE}/me/player/currently-playing?additional_types=track`,
              {
                headers: { Authorization: `Bearer ${session.accessToken}` },
              }
            );
          }

          const t1 = Date.now();
          const halfRtt = Math.min(Math.round((t1 - t0) / 2), 600);

          if (res.status === 204) {
            return {
              status: 'idle',
              track: null,
              progressMs: 0,
              fetchedAtMs: t1,
              isPlaying: false,
            };
          }

          if (res.status === 429) {
            const retryAfterSec = Number(res.headers.get('Retry-After') ?? '5');
            rateLimitedUntilMs = Date.now() + Math.max(retryAfterSec, 3) * 1000;
            return {
              status: 'error',
              track: null,
              progressMs: 0,
              fetchedAtMs: t1,
              isPlaying: false,
              error: `Spotify rate limited. Retrying in ${retryAfterSec}s.`,
              errorCode: 'rate_limited',
            };
          }

          if (res.status === 403) {
            return {
              status: 'error',
              track: null,
              progressMs: 0,
              fetchedAtMs: t1,
              isPlaying: false,
              error:
                'Spotify denied access (403). Make sure your Spotify email is added under User Management in the Spotify Developer Dashboard.',
              errorCode: 'allowlist',
            };
          }

          if (!res.ok) {
            return {
              status: 'error',
              track: null,
              progressMs: 0,
              fetchedAtMs: t1,
              isPlaying: false,
              error: `Spotify API error (${res.status}).`,
              errorCode: 'network',
            };
          }

          const data = (await res.json()) as SpotifyCurrentlyPlayingResponse;

          if (data.currently_playing_type === 'ad') {
            return {
              status: 'ad',
              track: null,
              progressMs: 0,
              fetchedAtMs: t1,
              isPlaying: data.is_playing,
            };
          }

          if (!data.item || data.currently_playing_type !== 'track') {
            return {
              status: 'idle',
              track: null,
              progressMs: 0,
              fetchedAtMs: t1,
              isPlaying: false,
            };
          }

          const item = data.item;
          const artists = (item.artists ?? []).map((a) => a.name).filter(Boolean);
          const albumArtUrl = item.album?.images?.[0]?.url ?? null;
          const trackId =
            item.id ?? `local:${item.name}:${artists.join(',')}:${item.duration_ms}`;

          const track: TrackInfo = {
            id: trackId,
            name: item.name,
            artists: artists.length > 0 ? artists : ['Unknown Artist'],
            album: item.album?.name ?? '',
            albumArtUrl,
            durationMs: item.duration_ms,
            isLocal: Boolean(item.is_local),
          };

          const rawProgress = data.progress_ms ?? 0;
          const compensatedProgress = data.is_playing
            ? Math.min(rawProgress + halfRtt, item.duration_ms)
            : rawProgress;

          return {
            status: data.is_playing ? 'playing' : 'paused',
            track,
            progressMs: compensatedProgress,
            fetchedAtMs: t1,
            isPlaying: data.is_playing,
          };
        } catch (err) {
          return {
            status: 'error',
            track: null,
            progressMs: 0,
            fetchedAtMs: Date.now(),
            isPlaying: false,
            error: err instanceof Error ? err.message : 'Network error reaching Spotify.',
            errorCode: 'network',
          };
        }
      },
      control: async (action: PlaybackControlAction, currentlyPlaying: boolean) => {
        if (!session) return false;
        try {
          await ensureFreshToken();
        } catch {
          return false;
        }

        const method = action === 'playPause' ? 'PUT' : 'POST';
        const endpoint =
          action === 'playPause'
            ? currentlyPlaying
              ? '/me/player/pause'
              : '/me/player/play'
            : action === 'next'
              ? '/me/player/next'
              : '/me/player/previous';

        const send = () =>
          fetch(`${SPOTIFY_API_BASE}${endpoint}`, {
            method,
            headers: { Authorization: `Bearer ${session!.accessToken}` },
          });

        try {
          let res = await send();
          if (res.status === 401) {
            await refreshAccessToken();
            res = await send();
          }
          return res.ok || res.status === 204;
        } catch {
          return false;
        }
      },
      fetchImageDataUrl: async (url: string): Promise<string | null> => {
        if (!url || !url.startsWith('https://')) return null;
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (!res.ok) return null;
          const blob = await res.blob();
          return await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () =>
              resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } catch {
          return null;
        }
      },
    },
    lyrics: {
      fetch: async (track: TrackInfo): Promise<LyricsResult> => {
        const cached = lyricsCache.get(track.id);
        if (cached) {
          const expiredNotFound =
            cached.result.status === 'not_found' &&
            Date.now() - cached.cachedAt > NOT_FOUND_TTL_MS;
          if (!expiredNotFound) {
            return { ...cached.result, source: 'cache' };
          }
        }

        const result = await fetchLrclibLyrics(track, true);
        if (result.status !== 'error') {
          lyricsCache.delete(track.id);
          lyricsCache.set(track.id, { result, cachedAt: Date.now() });
          while (lyricsCache.size > MAX_WEB_LYRICS_CACHE) {
            const oldestKey = lyricsCache.keys().next().value;
            if (oldestKey) lyricsCache.delete(oldestKey);
          }
          saveLyricsCache();
        }
        return result;
      },
      getOffset: async (trackId: string) => lyricsOffsets.get(trackId) ?? 0,
      setOffset: async (trackId: string, offsetMs: number) => {
        const clamped = Math.max(-15_000, Math.min(15_000, Math.round(offsetMs)));
        if (clamped === 0) {
          lyricsOffsets.delete(trackId);
        } else {
          lyricsOffsets.set(trackId, clamped);
        }
        saveLyricsOffsets();
      },
    },
    audio: {
      startTap: (source: string) => audioTap.start(source),
      stopTap: async () => {
        audioTap.stop(false);
      },
      onFrame: (cb) => audioTap.onFrame(cb),
      onStopped: (cb) => audioTap.onStopped(cb),
    },
    window: {
      isFullscreen: async () => Boolean(document.fullscreenElement),
      toggleFullscreen: async () => {
        try {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
            return false;
          }
          await document.documentElement.requestFullscreen();
          return true;
        } catch {
          return Boolean(document.fullscreenElement);
        }
      },
      setFullscreen: async (value: boolean) => {
        try {
          if (value && !document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          } else if (!value && document.fullscreenElement) {
            await document.exitFullscreen();
          }
        } catch {
          // ignore fullscreen errors
        }
        return Boolean(document.fullscreenElement);
      },
      onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
        const listener = () => {
          callback(Boolean(document.fullscreenElement));
        };
        document.addEventListener('fullscreenchange', listener);
        return () => {
          document.removeEventListener('fullscreenchange', listener);
        };
      },
      openExternal: async (url: string) => {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:') return false;
          window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
          return true;
        } catch {
          return false;
        }
      },
      minimize: async () => {},
      close: async () => {},
    },
  };
}

export function installWebBridgeIfNeeded(): void {
  if (typeof window !== 'undefined' && !window.visualizer) {
    window.visualizer = createWebBridge();
  }
}

export function isWebPlatform(): boolean {
  return typeof window !== 'undefined' && window.visualizer?.platform === 'web';
}
