import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthState,
  ColorMode,
  LyricsLayoutMode,
  LyricsResult,
  PlaybackControlAction,
  PlaybackState,
  ShaderPresetId,
  SweepMode,
  ThemePalette,
  TrackInfo,
} from '@shared/types';
import {
  INITIAL_AUDIO_DIAGNOSTIC,
  type AudioCaptureStatus,
  type AudioDiagnosticInfo,
  type AudioEngine,
} from '@/audio/audioEngine';
import { parseLrc } from '@/lib/lrcParser';
import {
  DEFAULT_PALETTE,
  extractPaletteFromDataUrl,
  isLightColor,
  paletteFromCustomHex,
  parseHexColor,
  rgbToCss,
} from '@/lib/palette';
import { ShaderCanvas } from '@/components/ShaderCanvas';
import { LoginScreen } from '@/components/LoginScreen';
import { LyricsOverlay } from '@/components/LyricsOverlay';
import { ControlHud } from '@/components/ControlHud';
import { KeepAwakeManager, type KeepAwakeStatus } from '@/platform/keepAwake';
import { PwaInstallController, type PwaInstallState } from '@/platform/pwaInstall';
import { isWebPlatform } from '@/platform/webBridge';

const INITIAL_AUTH: AuthState = {
  isAuthenticated: false,
  isAuthenticating: false,
  clientId: '',
  redirectUri: 'http://127.0.0.1:43821/callback',
  user: null,
  error: null,
  errorCode: null,
};

const LAYOUT_CYCLE: LyricsLayoutMode[] = ['focus', 'cinema', 'hidden'];
const COLOR_MODE_CYCLE: ColorMode[] = ['album-cycle', 'album-lock', 'custom'];
const SWEEP_MODE_CYCLE: SweepMode[] = ['auto', 'always', 'off'];

function loadSavedPreset(): ShaderPresetId {
  const saved = localStorage.getItem('sv:preset:v3');
  if (
    saved === 'soft-cloud' ||
    saved === 'cloud' ||
    saved === 'bars' ||
    saved === 'vinyl' ||
    saved === 'oscilloscope' ||
    saved === 'blank'
  ) {
    return saved;
  }
  if (saved === 'wave') return 'bars';
  const legacy = localStorage.getItem('sv:preset:v2');
  if (legacy === 'blank') return 'blank';
  if (legacy === 'tide') return 'bars';
  if (legacy === 'eclipse') return 'vinyl';
  if (legacy === 'spectrum') return 'oscilloscope';
  return 'soft-cloud';
}

function loadSavedLayout(): LyricsLayoutMode {
  const saved = localStorage.getItem('sv:layout');
  if (saved === 'focus' || saved === 'cinema' || saved === 'hidden') {
    return saved;
  }
  return 'focus';
}

function loadSavedSweepMode(): SweepMode {
  const saved = localStorage.getItem('sv:sweepMode');
  if (saved === 'auto' || saved === 'always' || saved === 'off') {
    return saved;
  }
  const legacy = localStorage.getItem('sv:letterSweep');
  if (legacy === '0') return 'off';
  return 'auto';
}

function loadSavedColorMode(): ColorMode {
  const saved = localStorage.getItem('sv:colorMode');
  if (saved === 'album-cycle' || saved === 'album-lock' || saved === 'custom') {
    return saved;
  }
  const legacy = localStorage.getItem('sv:colorCycle');
  if (legacy === '0') return 'album-lock';
  return 'album-cycle';
}

function loadSavedCustomColor(): string {
  const saved = localStorage.getItem('sv:customColor');
  if (saved && /^#[a-f0-9]{6}$/i.test(saved)) {
    return saved.toLowerCase();
  }
  return '#0a0d14';
}

function loadSavedShowCover(): boolean {
  return localStorage.getItem('sv:showCover') === '1';
}

function loadSavedKeepAwake(): boolean {
  const saved = localStorage.getItem('sv:keepAwake');
  return saved === null ? true : saved === '1';
}

export function App() {
  const [auth, setAuth] = useState<AuthState>(INITIAL_AUTH);
  const [authLoaded, setAuthLoaded] = useState(false);

  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [currentMs, setCurrentMs] = useState(0);

  const [lyricsResult, setLyricsResult] = useState<LyricsResult | null>(null);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [offsetMs, setOffsetMs] = useState(0);
  const [offsetToast, setOffsetToast] = useState<string | null>(null);

  const [palette, setPalette] = useState<ThemePalette>(DEFAULT_PALETTE);
  const [albumArtDataUrl, setAlbumArtDataUrl] = useState<string | null>(null);

  const isWeb = isWebPlatform();
  const [preset, setPreset] = useState<ShaderPresetId>(loadSavedPreset);
  const [layoutMode, setLayoutMode] = useState<LyricsLayoutMode>(loadSavedLayout);
  const [showCover, setShowCover] = useState<boolean>(loadSavedShowCover);
  const [sweepMode, setSweepMode] = useState<SweepMode>(loadSavedSweepMode);
  const [audioEnabled, setAudioEnabled] = useState(!isWeb);
  const [audioStatus, setAudioStatus] = useState<AudioCaptureStatus>('idle');
  const [audioDiag, setAudioDiag] = useState<AudioDiagnosticInfo>(INITIAL_AUDIO_DIAGNOSTIC);
  const [colorMode, setColorMode] = useState<ColorMode>(loadSavedColorMode);
  const [customColor, setCustomColor] = useState<string>(loadSavedCustomColor);

  const [isFullscreen, setIsFullscreen] = useState(!isWeb);
  const [hudVisible, setHudVisible] = useState(true);
  const [trackPeekVisible, setTrackPeekVisible] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState<boolean>(loadSavedKeepAwake);
  const [keepAwakeStatus, setKeepAwakeStatus] = useState<KeepAwakeStatus>('off');
  const [pwaInstallState, setPwaInstallState] = useState<PwaInstallState>('hidden');

  const keepAwakeRef = useRef<KeepAwakeManager | null>(null);
  const pwaControllerRef = useRef<PwaInstallController | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const latestTrackRef = useRef<TrackInfo | null>(null);
  const pollNowRef = useRef<(() => void) | null>(null);
  const isPlayingRef = useRef(false);
  const hudTimeoutRef = useRef<number | null>(null);
  const peekTimeoutRef = useRef<number | null>(null);
  const offsetToastTimeoutRef = useRef<number | null>(null);

  const clockRef = useRef({
    trackId: null as string | null,
    anchorProgressMs: 0,
    anchorPerfMs: 0,
    isPlaying: false,
    durationMs: 0,
  });

  const parsedLines = useMemo(() => {
    if (lyricsResult?.status === 'synced') {
      if (lyricsResult.richLines && lyricsResult.richLines.length > 0) {
        return lyricsResult.richLines;
      }
      if (lyricsResult.syncedLyrics) {
        return parseLrc(lyricsResult.syncedLyrics);
      }
    }
    return [];
  }, [lyricsResult]);

  const hasWordSync = useMemo(
    () =>
      Boolean(lyricsResult?.hasWordSync) ||
      parsedLines.some((l) => Boolean(l.words && l.words.length > 0)),
    [lyricsResult, parsedLines]
  );

  const effectiveLetterSweep =
    sweepMode === 'always' || (sweepMode === 'auto' && hasWordSync);

  const effectivePalette = useMemo(
    () => (colorMode === 'custom' ? paletteFromCustomHex(customColor) : palette),
    [colorMode, customColor, palette]
  );

  const blankColor = useMemo(
    () => (colorMode === 'custom' ? parseHexColor(customColor) : palette.backdrop),
    [colorMode, customColor, palette.backdrop]
  );

  const isLightBackdrop = preset === 'blank' && isLightColor(blankColor);

  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', rgbToCss(effectivePalette.color1));
    root.setProperty('--accent-soft', rgbToCss(effectivePalette.color1, 0.3));
  }, [effectivePalette]);

  useEffect(() => {
    let active = true;
    Promise.all([
      window.visualizer.auth.getState(),
      window.visualizer.window.isFullscreen(),
    ]).then(([authState, fs]) => {
      if (!active) return;
      setAuth(authState);
      setIsFullscreen(fs);
      setAuthLoaded(true);
    });

    const unsubFs = window.visualizer.window.onFullscreenChanged((fs) => {
      setIsFullscreen(fs);
    });

    return () => {
      active = false;
      unsubFs();
    };
  }, []);

  const revealHud = useCallback((durationMs = 3000) => {
    setHudVisible(true);
    if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
    hudTimeoutRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, durationMs);
  }, []);

  // Web-only Keep Awake (Screen Wake Lock + silent audio stream for Amazon Silk / Echo Show 5 & phones)
  useEffect(() => {
    if (!isWeb) return;
    const manager = new KeepAwakeManager(setKeepAwakeStatus);
    keepAwakeRef.current = manager;
    manager.setEnabled(keepAwakeEnabled);
    return () => {
      manager.dispose();
      keepAwakeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWeb]);

  // Web-only PWA install prompt controller (Chrome / Edge / Android / iOS Safari)
  useEffect(() => {
    if (!isWeb) return;
    const controller = new PwaInstallController(setPwaInstallState);
    pwaControllerRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      pwaControllerRef.current = null;
    };
  }, [isWeb]);

  useEffect(() => {
    if (!isWeb) return;
    keepAwakeRef.current?.setEnabled(keepAwakeEnabled);
  }, [isWeb, keepAwakeEnabled]);

  useEffect(() => {
    if (!auth.isAuthenticated) {
      setHudVisible(true);
      if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
      return;
    }

    revealHud();
    const onMove = () => revealHud(3000);
    const onPointerDown = (e: PointerEvent) =>
      revealHud(e.pointerType === 'touch' ? 4500 : 3000);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', onPointerDown);
      if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
    };
  }, [auth.isAuthenticated, revealHud]);

  // Poll Spotify currently-playing when authenticated
  useEffect(() => {
    if (!auth.isAuthenticated) {
      setPlayback(null);
      setLyricsResult(null);
      setAlbumArtDataUrl(null);
      setPalette(DEFAULT_PALETTE);
      latestTrackRef.current = null;
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const poll = async () => {
      const next = await window.visualizer.spotify.getPlayback();
      if (cancelled) return;

      if (next.status === 'error' && next.errorCode === 'auth_expired') {
        const refreshedAuth = await window.visualizer.auth.getState();
        if (!cancelled) setAuth(refreshedAuth);
        return;
      }

      latestTrackRef.current = next.track;
      isPlayingRef.current = next.isPlaying;
      setPlayback(next);

      if (next.track) {
        const nowPerf = performance.now();
        const networkAgeMs = Math.max(0, Date.now() - next.fetchedAtMs);
        const targetProgress = next.isPlaying
          ? Math.min(next.progressMs + networkAgeMs, next.track.durationMs)
          : next.progressMs;

        const clk = clockRef.current;
        if (clk.trackId === next.track.id && clk.isPlaying && next.isPlaying) {
          const currentEst = clk.anchorProgressMs + (nowPerf - clk.anchorPerfMs);
          const drift = targetProgress - currentEst;
          if (Math.abs(drift) > 260) {
            clk.anchorProgressMs = targetProgress;
            clk.anchorPerfMs = nowPerf;
          } else {
            clk.anchorProgressMs = currentEst + drift * 0.35;
            clk.anchorPerfMs = nowPerf;
          }
        } else {
          clk.trackId = next.track.id;
          clk.anchorProgressMs = targetProgress;
          clk.anchorPerfMs = nowPerf;
          clk.isPlaying = next.isPlaying;
          clk.durationMs = next.track.durationMs;
        }
      } else {
        clockRef.current.trackId = null;
        clockRef.current.isPlaying = false;
      }

      const nextIntervalMs =
        next.status === 'playing'
          ? 2400
          : next.status === 'error' && next.errorCode === 'rate_limited'
            ? 6000
            : 4000;

      timerId = window.setTimeout(poll, nextIntervalMs);
    };

    pollNowRef.current = () => {
      if (timerId) window.clearTimeout(timerId);
      void poll();
    };

    void poll();

    return () => {
      cancelled = true;
      pollNowRef.current = null;
      if (timerId) window.clearTimeout(timerId);
    };
  }, [auth.isAuthenticated]);

  // Smooth 60 FPS clock tick while playing so letter-by-letter sweep & hop animate silky smooth
  useEffect(() => {
    if (!auth.isAuthenticated) return;
    let rafId = 0;
    let lastEmittedMs = -1;
    let lastIdleCheck = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);

      const clk = clockRef.current;
      if (!clk.trackId) {
        if (lastEmittedMs !== 0) {
          lastEmittedMs = 0;
          setCurrentMs(0);
        }
        return;
      }

      if (!clk.isPlaying) {
        if (now - lastIdleCheck < 100) return;
        lastIdleCheck = now;
      }

      const elapsed = clk.isPlaying ? now - clk.anchorPerfMs : 0;
      const computed = Math.max(0, Math.min(clk.durationMs, clk.anchorProgressMs + elapsed));
      if (Math.abs(computed - lastEmittedMs) >= 0.5) {
        lastEmittedMs = computed;
        setCurrentMs(computed);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [auth.isAuthenticated]);

  // Key ONLY on primitive trackId & albumArtUrl so 2.4s playback polls NEVER cancel in-flight art/palette/lyrics fetches!
  const trackId = playback?.track?.id ?? null;
  const trackAlbumArtUrl = playback?.track?.albumArtUrl ?? null;

  useEffect(() => {
    if (!trackId) {
      setLyricsResult(null);
      setAlbumArtDataUrl(null);
      setOffsetMs(0);
      setPalette(DEFAULT_PALETTE);
      setIsLoadingLyrics(false);
      return;
    }

    const currentTrack = latestTrackRef.current;
    if (!currentTrack || currentTrack.id !== trackId) return;

    let stale = false;
    setIsLoadingLyrics(true);
    setLyricsResult(null);

    setTrackPeekVisible(true);
    if (peekTimeoutRef.current) window.clearTimeout(peekTimeoutRef.current);
    peekTimeoutRef.current = window.setTimeout(() => {
      setTrackPeekVisible(false);
    }, 4500);

    Promise.all([
      window.visualizer.lyrics.getOffset(currentTrack.id),
      window.visualizer.lyrics.fetch(currentTrack),
    ]).then(([savedOffset, result]) => {
      if (stale) return;
      setOffsetMs(savedOffset);
      setLyricsResult(result);
      setIsLoadingLyrics(false);
    });

    if (trackAlbumArtUrl) {
      window.visualizer.spotify
        .fetchImageDataUrl(trackAlbumArtUrl)
        .then(async (dataUrl) => {
          if (stale) return;
          setAlbumArtDataUrl(dataUrl);
          if (dataUrl) {
            const extracted = await extractPaletteFromDataUrl(dataUrl);
            if (!stale) setPalette(extracted);
          } else {
            setPalette(DEFAULT_PALETTE);
          }
        });
    } else {
      setAlbumArtDataUrl(null);
      setPalette(DEFAULT_PALETTE);
    }

    return () => {
      stale = true;
    };
  }, [trackId, trackAlbumArtUrl]);

  const selectPreset = useCallback((next: ShaderPresetId) => {
    setPreset(next);
    localStorage.setItem('sv:preset:v3', next);
  }, []);

  const cycleLayout = useCallback(() => {
    setLayoutMode((prev) => {
      const next = LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(prev) + 1) % LAYOUT_CYCLE.length];
      localStorage.setItem('sv:layout', next);
      return next;
    });
  }, []);

  const toggleCover = useCallback(() => {
    setShowCover((prev) => {
      const next = !prev;
      localStorage.setItem('sv:showCover', next ? '1' : '0');
      return next;
    });
  }, []);

  const cycleSweepMode = useCallback(() => {
    setSweepMode((prev) => {
      const next =
        SWEEP_MODE_CYCLE[(SWEEP_MODE_CYCLE.indexOf(prev) + 1) % SWEEP_MODE_CYCLE.length];
      localStorage.setItem('sv:sweepMode', next);
      return next;
    });
  }, []);

  const selectColorMode = useCallback((next: ColorMode) => {
    setColorMode(next);
    localStorage.setItem('sv:colorMode', next);
  }, []);

  const cycleColorMode = useCallback(() => {
    setColorMode((prev) => {
      const next =
        COLOR_MODE_CYCLE[(COLOR_MODE_CYCLE.indexOf(prev) + 1) % COLOR_MODE_CYCLE.length];
      localStorage.setItem('sv:colorMode', next);
      return next;
    });
  }, []);

  const changeCustomColor = useCallback((hex: string) => {
    const normalized = hex.trim().toLowerCase();
    if (!/^#[a-f0-9]{6}$/.test(normalized)) return;
    setCustomColor(normalized);
    localStorage.setItem('sv:customColor', normalized);
  }, []);

  const flashOffsetToast = useCallback((ms: number) => {
    const label = `Lyric Sync: ${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`;
    setOffsetToast(label);
    if (offsetToastTimeoutRef.current) window.clearTimeout(offsetToastTimeoutRef.current);
    offsetToastTimeoutRef.current = window.setTimeout(() => {
      setOffsetToast(null);
    }, 1500);
  }, []);

  const nudgeOffset = useCallback(
    (deltaMs: number) => {
      const id = latestTrackRef.current?.id;
      setOffsetMs((prev) => {
        const next = Math.max(-15_000, Math.min(15_000, prev + deltaMs));
        if (id) void window.visualizer.lyrics.setOffset(id, next);
        flashOffsetToast(next);
        return next;
      });
    },
    [flashOffsetToast]
  );

  const resetOffset = useCallback(() => {
    const id = latestTrackRef.current?.id;
    setOffsetMs(0);
    if (id) void window.visualizer.lyrics.setOffset(id, 0);
    flashOffsetToast(0);
  }, [flashOffsetToast]);

  const handlePlaybackControl = useCallback(async (action: PlaybackControlAction) => {
    const currentlyPlaying = isPlayingRef.current;

    // Optimistic pause/play clock update so the UI & lyrics feel instant
    if (action === 'playPause') {
      const nextPlaying = !currentlyPlaying;
      isPlayingRef.current = nextPlaying;
      const nowPerf = performance.now();
      const clk = clockRef.current;
      if (clk.trackId) {
        const est = clk.isPlaying
          ? clk.anchorProgressMs + (nowPerf - clk.anchorPerfMs)
          : clk.anchorProgressMs;
        clk.anchorProgressMs = Math.max(0, Math.min(clk.durationMs, est));
        clk.anchorPerfMs = nowPerf;
        clk.isPlaying = nextPlaying;
      }
      setPlayback((prev) =>
        prev
          ? { ...prev, isPlaying: nextPlaying, status: nextPlaying ? 'playing' : 'paused' }
          : prev
      );
    }

    await window.visualizer.spotify.control(action, currentlyPlaying);

    // Trigger rapid re-polls so skip/pause reflects immediately in track art, colors & lyrics
    window.setTimeout(() => pollNowRef.current?.(), 320);
    window.setTimeout(() => pollNowRef.current?.(), 950);
  }, []);

  const flashToast = useCallback((label: string, durationMs = 2200) => {
    setOffsetToast(label);
    if (offsetToastTimeoutRef.current) window.clearTimeout(offsetToastTimeoutRef.current);
    offsetToastTimeoutRef.current = window.setTimeout(() => {
      setOffsetToast(null);
    }, durationMs);
  }, []);

  const handleInstallPwa = useCallback(async () => {
    const outcome = await pwaControllerRef.current?.triggerInstall();
    if (outcome === 'ios-guide') {
      flashToast('iPhone / iPad: tap Share → Add to Home Screen', 4200);
    } else if (outcome === 'accepted') {
      flashToast('Spotify Visualizer installed!', 2400);
    }
  }, [flashToast]);

  const handleToggleKeepAwake = useCallback(() => {
    if (!isWeb) return;
    if (keepAwakeEnabled && keepAwakeStatus === 'waiting') {
      void keepAwakeRef.current?.engage().then((ok) => {
        flashToast(ok ? 'Keep Awake active' : 'Tap once more to arm Keep Awake', 2000);
      });
      return;
    }
    setKeepAwakeEnabled((prev) => {
      const next = !prev;
      localStorage.setItem('sv:keepAwake', next ? '1' : '0');
      flashToast(next ? 'Keep Awake enabled' : 'Keep Awake off', 1800);
      return next;
    });
  }, [flashToast, isWeb, keepAwakeEnabled, keepAwakeStatus]);

  const handleToggleAudio = useCallback(() => {
    if (isWeb) {
      setShowAudioMenu((v) => !v);
      revealHud();
    } else if (audioEnabled && audioStatus === 'error') {
      flashToast('Retrying Windows audio capture…', 2000);
      void audioEngineRef.current?.startCapture('default');
    } else {
      setAudioEnabled((v) => !v);
    }
  }, [audioEnabled, audioStatus, flashToast, isWeb, revealHud]);

  const handleSelectWebAudioSource = useCallback(
    async (source: 'display' | 'mic' | 'off') => {
      setShowAudioMenu(false);
      if (source === 'off') {
        setAudioEnabled(false);
        audioEngineRef.current?.stopCapture();
        return;
      }

      setAudioEnabled(true);
      const ok = await audioEngineRef.current?.startCapture(source);
      if (!ok) {
        setAudioEnabled(false);
        flashToast(
          source === 'display'
            ? 'No tab/screen audio shared — try sharing a Spotify Web Player tab or use Microphone'
            : 'Microphone permission was not granted',
          3600
        );
      }
    },
    [flashToast]
  );

  const handleLogin = useCallback(
    async (clientId: string) => {
      setAuth((prev) => ({ ...prev, isAuthenticating: true, error: null, errorCode: null }));
      if (!isWeb && audioEnabled && audioStatus !== 'active') {
        void audioEngineRef.current?.startCapture('default');
      }
      const nextAuth = await window.visualizer.auth.login(clientId);
      setAuth(nextAuth);
    },
    [audioEnabled, audioStatus, isWeb]
  );

  const handleLogout = useCallback(async () => {
    const nextAuth = await window.visualizer.auth.logout();
    setAuth(nextAuth);
    setShowShortcuts(false);
    setShowColorMenu(false);
    setShowAudioMenu(false);
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    const fs = await window.visualizer.window.toggleFullscreen();
    setIsFullscreen(fs);
  }, []);

  const handleClose = useCallback(() => {
    void window.visualizer.window.close();
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'F11' || (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        void handleToggleFullscreen();
        return;
      }

      if (e.key === 'Escape') {
        if (showColorMenu) {
          setShowColorMenu(false);
        } else if (showAudioMenu) {
          setShowAudioMenu(false);
        } else if (showShortcuts) {
          setShowShortcuts(false);
        } else if (isFullscreen) {
          void window.visualizer.window.setFullscreen(false);
        }
        return;
      }

      if (!auth.isAuthenticated) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          void handlePlaybackControl('playPause');
          revealHud();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          void handlePlaybackControl('previous');
          revealHud();
          break;
        case 'ArrowRight':
          e.preventDefault();
          void handlePlaybackControl('next');
          revealHud();
          break;
        case '1':
          selectPreset('soft-cloud');
          revealHud();
          break;
        case '2':
          selectPreset('cloud');
          revealHud();
          break;
        case '3':
          selectPreset('bars');
          revealHud();
          break;
        case '4':
          selectPreset('vinyl');
          revealHud();
          break;
        case '5':
          selectPreset('oscilloscope');
          revealHud();
          break;
        case '6':
          selectPreset('blank');
          revealHud();
          break;
        case 'l':
        case 'L':
          cycleSweepMode();
          revealHud();
          break;
        case 'v':
        case 'V':
          toggleCover();
          revealHud();
          break;
        case 'c':
        case 'C':
          cycleColorMode();
          revealHud();
          break;
        case 'm':
        case 'M':
          cycleLayout();
          revealHud();
          break;
        case 'a':
        case 'A':
          handleToggleAudio();
          revealHud();
          break;
        case '[':
          nudgeOffset(-100);
          break;
        case ']':
          nudgeOffset(100);
          break;
        case '\\':
          resetOffset();
          break;
        case 'h':
        case 'H':
        case '?':
          setShowShortcuts((v) => !v);
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    auth.isAuthenticated,
    cycleColorMode,
    cycleLayout,
    handlePlaybackControl,
    handleToggleAudio,
    handleToggleFullscreen,
    isFullscreen,
    nudgeOffset,
    resetOffset,
    revealHud,
    selectPreset,
    showAudioMenu,
    showColorMenu,
    showShortcuts,
    toggleCover,
    cycleSweepMode,
  ]);

  const effectiveLyricTimeMs = Math.max(0, currentMs + offsetMs);
  const hideCursor =
    auth.isAuthenticated &&
    !hudVisible &&
    !showShortcuts &&
    !showColorMenu &&
    !showAudioMenu;

  return (
    <div
      className={`app-root ${hideCursor ? 'cursor-hidden' : ''} ${isLightBackdrop ? 'light-backdrop' : ''}`}
    >
      <ShaderCanvas
        preset={preset}
        palette={effectivePalette}
        blankColor={blankColor}
        albumArtDataUrl={albumArtDataUrl}
        audioEnabled={audioEnabled}
        colorMode={colorMode}
        isPlaying={Boolean(playback?.isPlaying)}
        onAudioStatusChange={setAudioStatus}
        onAudioDiagnosticChange={setAudioDiag}
        audioEngineRef={audioEngineRef}
      />

      {offsetToast && <div className="offset-toast">{offsetToast}</div>}

      {!authLoaded ? null : !auth.isAuthenticated ? (
        <LoginScreen
          auth={auth}
          isFullscreen={isFullscreen}
          pwaInstallState={pwaInstallState}
          onInstallPwa={() => void handleInstallPwa()}
          onLogin={(clientId) => void handleLogin(clientId)}
          onToggleFullscreen={() => void handleToggleFullscreen()}
          onClose={handleClose}
        />
      ) : (
        <>
          <LyricsOverlay
            playback={playback}
            albumArtDataUrl={albumArtDataUrl}
            lyricsResult={lyricsResult}
            parsedLines={parsedLines}
            currentMs={effectiveLyricTimeMs}
            layoutMode={layoutMode}
            showCover={showCover}
            letterSweep={effectiveLetterSweep}
            isLoadingLyrics={isLoadingLyrics}
          />

          <ControlHud
            visible={hudVisible || showShortcuts || showColorMenu || showAudioMenu}
            trackPeekVisible={trackPeekVisible}
            isWeb={isWeb}
            auth={auth}
            playback={playback}
            albumArtDataUrl={albumArtDataUrl}
            currentMs={currentMs}
            preset={preset}
            layoutMode={layoutMode}
            showCover={showCover}
            sweepMode={sweepMode}
            hasWordSync={hasWordSync}
            audioEnabled={audioEnabled}
            audioStatus={audioStatus}
            audioDiag={audioDiag}
            showAudioMenu={showAudioMenu}
            colorMode={colorMode}
            customColor={customColor}
            showColorMenu={showColorMenu}
            offsetMs={offsetMs}
            isFullscreen={isFullscreen}
            showShortcuts={showShortcuts}
            keepAwakeEnabled={keepAwakeEnabled}
            keepAwakeStatus={keepAwakeStatus}
            pwaInstallState={pwaInstallState}
            onSelectPreset={selectPreset}
            onCycleLayout={cycleLayout}
            onToggleCover={toggleCover}
            onCycleSweepMode={cycleSweepMode}
            onToggleAudio={handleToggleAudio}
            onCloseAudioMenu={() => setShowAudioMenu(false)}
            onSelectWebAudioSource={(src) => void handleSelectWebAudioSource(src)}
            onToggleColorMenu={() => {
              setShowColorMenu((v) => !v);
              revealHud();
            }}
            onCloseColorMenu={() => setShowColorMenu(false)}
            onSelectColorMode={selectColorMode}
            onChangeCustomColor={changeCustomColor}
            onPlaybackControl={(action) => void handlePlaybackControl(action)}
            onNudgeOffset={nudgeOffset}
            onResetOffset={resetOffset}
            onToggleKeepAwake={handleToggleKeepAwake}
            onInstallPwa={() => void handleInstallPwa()}
            onToggleFullscreen={() => void handleToggleFullscreen()}
            onToggleShortcuts={() => setShowShortcuts((v) => !v)}
            onLogout={() => void handleLogout()}
            onClose={handleClose}
          />
        </>
      )}
    </div>
  );
}
