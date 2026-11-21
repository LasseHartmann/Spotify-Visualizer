import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app, safeStorage, shell } from 'electron';
import { isValidSpotifyClientId, SPOTIFY_CONFIG } from './config';
import type {
  AuthState,
  PlaybackControlAction,
  PlaybackState,
  SpotifyUserProfile,
  TrackInfo,
} from '@shared/types';

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId?: string;
  user: SpotifyUserProfile | null;
}

interface StoredConfig {
  clientId: string;
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
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
      images?: Array<{ url: string; width?: number; height?: number }>;
    };
  } | null;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function renderCallbackHtml(success: boolean, title: string, subtitle: string): string {
  const accent = success ? '#1ed760' : '#ff5e7e';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Spotify Visualizer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at 25% 20%, rgba(30,215,96,0.22), transparent 45%),
                  radial-gradient(circle at 80% 80%, rgba(124,58,237,0.22), transparent 50%),
                  #07090f;
      color: #f8fafc;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    }
    .card {
      padding: 40px 48px;
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(20px);
      text-align: center;
      max-width: 440px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
    }
    .dot {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: ${accent};
      box-shadow: 0 0 24px ${accent};
      margin: 0 auto 20px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 10px; font-weight: 700; letter-spacing: -0.02em; }
    p { font-size: 0.96rem; color: rgba(248,250,252,0.72); line-height: 1.55; }
  </style>
</head>
<body>
  <div class="card">
    <div class="dot"></div>
    <h1>${title}</h1>
    <p>${subtitle}</p>
  </div>
  <script>setTimeout(() => window.close(), 1800);</script>
</body>
</html>`;
}

export class SpotifyService {
  private tokens: StoredTokens | null = null;
  private clientId = '';
  private activeAuthServer: http.Server | null = null;
  private isAuthenticating = false;
  private refreshPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastErrorCode: AuthState['errorCode'] = null;
  private rateLimitedUntilMs = 0;

  private get tokenFilePath(): string {
    return path.join(app.getPath('userData'), 'spotify-session.bin');
  }

  private get configFilePath(): string {
    return path.join(app.getPath('userData'), 'config.json');
  }

  public init(): void {
    this.clientId = this.loadClientId() || SPOTIFY_CONFIG.defaultClientId;
    this.tokens = this.loadTokens();
    // Migrate older saved sessions that did not record clientId
    if (this.tokens && !this.tokens.clientId && this.clientId) {
      this.tokens.clientId = this.clientId;
    }
    if (!this.clientId && this.tokens?.clientId) {
      this.clientId = this.tokens.clientId;
    }
  }

  public getAuthState(): AuthState {
    return {
      isAuthenticated: Boolean(this.tokens?.refreshToken && this.getActiveClientId()),
      isAuthenticating: this.isAuthenticating,
      clientId: this.clientId,
      redirectUri: SPOTIFY_CONFIG.redirectUri,
      user: this.tokens?.user ?? null,
      error: this.lastError,
      errorCode: this.lastErrorCode,
    };
  }

  public setClientId(rawClientId: string): AuthState {
    const cleaned = rawClientId.trim();
    if (cleaned === '') {
      this.clientId = '';
      this.saveClientId('');
      this.lastError = null;
      this.lastErrorCode = null;
      return this.getAuthState();
    }

    if (!isValidSpotifyClientId(cleaned)) {
      this.lastError =
        'Spotify Client IDs are 32-character hexadecimal strings (found under Settings in your Spotify Developer Dashboard).';
      this.lastErrorCode = 'missing_client_id';
      return this.getAuthState();
    }

    this.clientId = cleaned;
    this.saveClientId(cleaned);
    this.lastError = null;
    this.lastErrorCode = null;
    return this.getAuthState();
  }

  private getActiveClientId(): string {
    return (this.tokens?.clientId || this.clientId || SPOTIFY_CONFIG.defaultClientId).trim();
  }

  public async login(clientIdOverride?: string, onFocusWindow?: () => void): Promise<AuthState> {
    this.cancelActiveAuthServer();
    this.lastError = null;
    this.lastErrorCode = null;

    const candidateId = (clientIdOverride ?? this.clientId).trim();
    if (!isValidSpotifyClientId(candidateId)) {
      this.lastError =
        'Please enter your 32-character Spotify Client ID before connecting.';
      this.lastErrorCode = 'missing_client_id';
      return this.getAuthState();
    }

    this.clientId = candidateId;
    this.saveClientId(candidateId);
    this.isAuthenticating = true;

    const { verifier, challenge } = generatePkcePair();
    const state = crypto.randomBytes(16).toString('hex');

    try {
      const code = await this.waitForAuthorizationCode(candidateId, state, challenge);
      const tokenResp = await this.exchangeCodeForTokens(candidateId, code, verifier);

      this.tokens = {
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token ?? '',
        expiresAt: Date.now() + tokenResp.expires_in * 1000,
        clientId: candidateId,
        user: null,
      };

      const profileCheck = await this.fetchProfile(this.tokens.accessToken);
      if (profileCheck.allowlistBlocked) {
        this.tokens = null;
        this.clearStoredTokens();
        this.lastErrorCode = 'allowlist';
        this.lastError =
          'Your Spotify account is not on this app’s allowlist yet. Add your Spotify email under User Management in your Spotify Developer Dashboard.';
      } else {
        this.tokens.user = profileCheck.user;
        this.saveTokens(this.tokens);
      }

      onFocusWindow?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Spotify sign-in failed.';
      this.lastError = message;
      this.lastErrorCode = 'auth_failed';
    } finally {
      this.isAuthenticating = false;
      this.cancelActiveAuthServer();
    }

    return this.getAuthState();
  }

  public logout(): AuthState {
    this.cancelActiveAuthServer();
    this.tokens = null;
    this.lastError = null;
    this.lastErrorCode = null;
    this.clearStoredTokens();
    return this.getAuthState();
  }

  public async getCurrentlyPlaying(): Promise<PlaybackState> {
    if (!this.tokens) {
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

    if (Date.now() < this.rateLimitedUntilMs) {
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
      await this.ensureFreshToken();
    } catch {
      this.tokens = null;
      this.clearStoredTokens();
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
        `${SPOTIFY_CONFIG.apiBaseUrl}/me/player/currently-playing?additional_types=track`,
        {
          headers: {
            Authorization: `Bearer ${this.tokens.accessToken}`,
          },
        }
      );

      if (res.status === 401) {
        await this.refreshAccessToken();
        res = await fetch(
          `${SPOTIFY_CONFIG.apiBaseUrl}/me/player/currently-playing?additional_types=track`,
          {
            headers: {
              Authorization: `Bearer ${this.tokens.accessToken}`,
            },
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
        this.rateLimitedUntilMs = Date.now() + Math.max(retryAfterSec, 3) * 1000;
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
  }

  public async controlPlayback(
    action: PlaybackControlAction,
    currentlyPlaying: boolean
  ): Promise<boolean> {
    if (!this.tokens) return false;
    try {
      await this.ensureFreshToken();
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
      fetch(`${SPOTIFY_CONFIG.apiBaseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.tokens!.accessToken}`,
        },
      });

    try {
      let res = await send();
      if (res.status === 401) {
        await this.refreshAccessToken();
        res = await send();
      }
      return res.ok || res.status === 204;
    } catch {
      return false;
    }
  }

  public async fetchImageDataUrl(url: string): Promise<string | null> {
    if (!url || !url.startsWith('https://')) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const arrayBuf = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuf).toString('base64');
      return `data:${contentType};base64,${base64}`;
    } catch {
      return null;
    }
  }

  private waitForAuthorizationCode(
    clientId: string,
    expectedState: string,
    codeChallenge: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.cancelActiveAuthServer();
          reject(new Error('Sign-in timed out after 3 minutes. Please try again.'));
        }
      }, 180_000);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      const server = http.createServer((req, res) => {
        const reqUrl = new URL(
          req.url ?? '/',
          `http://${SPOTIFY_CONFIG.redirectHost}:${SPOTIFY_CONFIG.redirectPort}`
        );

        if (reqUrl.pathname !== SPOTIFY_CONFIG.redirectPath) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const error = reqUrl.searchParams.get('error');
        const state = reqUrl.searchParams.get('state');
        const code = reqUrl.searchParams.get('code');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderCallbackHtml(
              false,
              'Sign-in cancelled',
              'You can close this tab and try again from Spotify Visualizer.'
            )
          );
          finish(() => reject(new Error(`Spotify authorization cancelled (${error}).`)));
          return;
        }

        if (!code || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderCallbackHtml(
              false,
              'Invalid response',
              'State verification failed. Please return to Spotify Visualizer and retry.'
            )
          );
          finish(() => reject(new Error('OAuth state mismatch. Please retry sign-in.')));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderCallbackHtml(
            true,
            'Connected to Spotify Visualizer',
            'You’re all set! This tab will close automatically.'
          )
        );
        finish(() => resolve(code));
      });

      this.activeAuthServer = server;

      server.on('error', (err) => {
        finish(() =>
          reject(
            new Error(
              `Could not start local auth callback on port ${SPOTIFY_CONFIG.redirectPort}: ${err.message}`
            )
          )
        );
      });

      server.listen(SPOTIFY_CONFIG.redirectPort, SPOTIFY_CONFIG.redirectHost, () => {
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          scope: SPOTIFY_CONFIG.scopes,
          redirect_uri: SPOTIFY_CONFIG.redirectUri,
          state: expectedState,
          code_challenge_method: 'S256',
          code_challenge: codeChallenge,
          show_dialog: 'true',
        });

        const authUrl = `${SPOTIFY_CONFIG.authorizeUrl}?${params.toString()}`;
        shell.openExternal(authUrl).catch((err) => {
          finish(() => reject(new Error(`Failed to open browser: ${err.message}`)));
        });
      });
    });
  }

  private cancelActiveAuthServer(): void {
    if (this.activeAuthServer) {
      try {
        this.activeAuthServer.close();
      } catch {
        // ignore
      }
      this.activeAuthServer = null;
    }
  }

  private async exchangeCodeForTokens(
    clientId: string,
    code: string,
    codeVerifier: string
  ): Promise<SpotifyTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_CONFIG.redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    const res = await fetch(SPOTIFY_CONFIG.tokenUrl, {
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

  private async ensureFreshToken(): Promise<void> {
    if (!this.tokens) throw new Error('No session');
    if (Date.now() < this.tokens.expiresAt - 120_000) return;
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      if (!this.tokens?.refreshToken) {
        throw new Error('Missing refresh token');
      }

      const activeClientId = this.getActiveClientId();
      if (!activeClientId) {
        throw new Error('Missing Spotify Client ID');
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: activeClientId,
      });

      const res = await fetch(SPOTIFY_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!res.ok) {
        throw new Error(`Token refresh failed (${res.status})`);
      }

      const data = (await res.json()) as SpotifyTokenResponse;
      this.tokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || this.tokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        clientId: activeClientId,
        user: this.tokens.user,
      };
      this.saveTokens(this.tokens);
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async fetchProfile(
    accessToken: string
  ): Promise<{ user: SpotifyUserProfile | null; allowlistBlocked: boolean }> {
    try {
      const res = await fetch(`${SPOTIFY_CONFIG.apiBaseUrl}/me`, {
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

  private saveTokens(tokens: StoredTokens): void {
    try {
      const raw = JSON.stringify(tokens);
      const dir = path.dirname(this.tokenFilePath);
      fs.mkdirSync(dir, { recursive: true });
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(raw);
        fs.writeFileSync(this.tokenFilePath, encrypted);
      } else {
        fs.writeFileSync(this.tokenFilePath, Buffer.from(raw, 'utf-8'));
      }
    } catch (err) {
      console.error('[spotify] Failed to persist tokens:', err);
    }
  }

  private loadTokens(): StoredTokens | null {
    try {
      if (!fs.existsSync(this.tokenFilePath)) return null;
      const buf = fs.readFileSync(this.tokenFilePath);
      const raw = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString('utf-8');
      const parsed = JSON.parse(raw) as StoredTokens;
      if (!parsed.refreshToken) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private clearStoredTokens(): void {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        fs.unlinkSync(this.tokenFilePath);
      }
    } catch {
      // ignore
    }
  }

  private saveClientId(clientId: string): void {
    try {
      const dir = path.dirname(this.configFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload: StoredConfig = { clientId };
      fs.writeFileSync(this.configFilePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.error('[spotify] Failed to persist config:', err);
    }
  }

  private loadClientId(): string {
    try {
      if (!fs.existsSync(this.configFilePath)) return '';
      const parsed = JSON.parse(fs.readFileSync(this.configFilePath, 'utf-8')) as Partial<StoredConfig>;
      return typeof parsed.clientId === 'string' ? parsed.clientId.trim() : '';
    } catch {
      return '';
    }
  }
}
