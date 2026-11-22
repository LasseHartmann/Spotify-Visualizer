export type ShaderPresetId = 'soft-cloud' | 'cloud' | 'bars' | 'vinyl' | 'oscilloscope' | 'blank';

export type ColorMode = 'album-cycle' | 'album-lock' | 'custom';

export type SweepMode = 'auto' | 'always' | 'off';

export type LyricsLayoutMode = 'focus' | 'cinema' | 'hidden';

export type PlaybackControlAction = 'playPause' | 'next' | 'previous';

export interface SpotifyUserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthState {
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  clientId: string;
  redirectUri: string;
  user: SpotifyUserProfile | null;
  error: string | null;
  errorCode: 'allowlist' | 'auth_failed' | 'network' | 'missing_client_id' | null;
}

export interface TrackInfo {
  id: string;
  name: string;
  artists: string[];
  album: string;
  albumArtUrl: string | null;
  durationMs: number;
  isLocal: boolean;
}

export interface PlaybackState {
  status: 'playing' | 'paused' | 'idle' | 'ad' | 'error';
  track: TrackInfo | null;
  progressMs: number;
  fetchedAtMs: number;
  isPlaying: boolean;
  error?: string;
  errorCode?: 'allowlist' | 'auth_expired' | 'rate_limited' | 'network';
}

export interface WordTiming {
  timeMs: number;
  endTimeMs?: number;
  text: string;
  isBackground?: boolean;
}

export interface LyricLine {
  timeMs: number;
  endTimeMs?: number;
  text: string;
  words?: WordTiming[];
}

export interface LyricsResult {
  trackId: string;
  status: 'synced' | 'plain' | 'instrumental' | 'not_found' | 'error';
  syncedLyrics: string | null;
  /** Structured word/syllable-timed lines (e.g. from LyricsPlus / Apple TTML) when available */
  richLines?: LyricLine[] | null;
  /** True when the track has real per-word / per-syllable timestamps */
  hasWordSync?: boolean;
  plainLyrics: string | null;
  source: 'lyricsplus' | 'lrclib' | 'cache' | 'none';
}

export interface RGB {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
}

/**
 * Faithful album-cover palette preserving real black backgrounds, neutral white/silver,
 * metallic gold, and bold chromatic accents without inventing fake blue/green tints.
 */
export interface ThemePalette {
  backdrop: RGB;
  color1: RGB;
  color2: RGB;
  color3: RGB;
  darkStage: number; // 0..1: 1 = true black-backed cover (e.g. RAM, Sick Boi, B&W)
}

export interface NativeAudioPacket {
  sampleRate: number;
  freqBins: Uint8Array;
  timeBins: Uint8Array;
}

export interface NativeAudioStatus {
  state: 'starting' | 'active' | 'error' | 'silent_apo' | 'stopped';
  deviceName?: string;
  backend?: 'wasapi' | 'chromium';
  message?: string;
}

export interface VisualizerApi {
  platform?: 'electron' | 'web';
  auth: {
    getState: () => Promise<AuthState>;
    setClientId: (clientId: string) => Promise<AuthState>;
    login: (clientId?: string) => Promise<AuthState>;
    logout: () => Promise<AuthState>;
  };
  spotify: {
    getPlayback: () => Promise<PlaybackState>;
    control: (action: PlaybackControlAction, currentlyPlaying: boolean) => Promise<boolean>;
    fetchImageDataUrl: (url: string) => Promise<string | null>;
  };
  lyrics: {
    fetch: (track: TrackInfo) => Promise<LyricsResult>;
    getOffset: (trackId: string) => Promise<number>;
    setOffset: (trackId: string, offsetMs: number) => Promise<void>;
  };
  audio: {
    startTap: (deviceId: string) => Promise<boolean>;
    stopTap: () => Promise<void>;
    onFrame: (callback: (packet: NativeAudioPacket) => void) => () => void;
    onStatus?: (callback: (status: NativeAudioStatus) => void) => () => void;
    onStopped?: (callback: () => void) => () => void;
  };
  window: {
    toggleFullscreen: () => Promise<boolean>;
    setFullscreen: (value: boolean) => Promise<boolean>;
    isFullscreen: () => Promise<boolean>;
    onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;
    openExternal: (url: string) => Promise<boolean>;
    minimize: () => Promise<void>;
    close: () => Promise<void>;
  };
}

declare global {
  interface Window {
    visualizer: VisualizerApi;
  }
}
