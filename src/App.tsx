import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthState,
  LyricsLayoutMode,
  LyricsResult,
  PlaybackControlAction,
  PlaybackState,
  ShaderPresetId,
  ThemePalette,
  TrackInfo,
} from '@shared/types';
import type { AudioCaptureStatus, AudioEngine } from '@/audio/audioEngine';
import { parseLrc } from '@/lib/lrcParser';
import { DEFAULT_PALETTE, extractPaletteFromDataUrl, rgbToCss } from '@/lib/palette';
import { ShaderCanvas } from '@/components/ShaderCanvas';
import { LoginScreen } from '@/components/LoginScreen';
import { LyricsOverlay } from '@/components/LyricsOverlay';
import { ControlHud } from '@/components/ControlHud';

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

function loadSavedPreset(): ShaderPresetId {
  const saved = localStorage.getItem('sv:preset:v2');
  if (saved === 'pulse' || saved === 'eclipse' || saved === 'tide' || saved === 'spectrum') {
    return saved;
  }
  return 'pulse';
}

function loadSavedLayout(): LyricsLayoutMode {
  const saved = localStorage.getItem('sv:layout');
  if (saved === 'focus' || saved === 'cinema' || saved === 'hidden') {
    return saved;
  }
  return 'focus';
}

function loadSavedColorCycle(): boolean {
  const saved = localStorage.getItem('sv:colorCycle');
  return saved === null ? true : saved === '1';
}

function loadSavedShowCover(): boolean {
  return localStorage.getItem('sv:showCover') === '1';
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

  const [preset, setPreset] = useState<ShaderPresetId>(loadSavedPreset);
  const [layoutMode, setLayoutMode] = useState<LyricsLayoutMode>(loadSavedLayout);
  const [showCover, setShowCover] = useState<boolean>(loadSavedShowCover);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [audioStatus, setAudioStatus] = useState<AudioCaptureStatus>('idle');
  const [colorCycle, setColorCycle] = useState(loadSavedColorCycle);

  const [isFullscreen, setIsFullscreen] = useState(true);
  const [hudVisible, setHudVisible] = useState(true);
  const [trackPeekVisible, setTrackPeekVisible] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

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
    if (lyricsResult?.status === 'synced' && lyricsResult.syncedLyrics) {
      return parseLrc(lyricsResult.syncedLyrics);
    }
    return [];
  }, [lyricsResult]);

  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', rgbToCss(palette.color1));
    root.setProperty('--accent-soft', rgbToCss(palette.color1, 0.3));
  }, [palette]);

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

  const revealHud = useCallback(() => {
    setHudVisible(true);
    if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
    hudTimeoutRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    if (!auth.isAuthenticated) {
      setHudVisible(true);
      if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
      return;
    }

    revealHud();
    const onMove = () => revealHud();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerdown', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', onMove);
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

  // Smooth ~30 FPS clock tick for lyric progression & progress bar
  useEffect(() => {
    if (!auth.isAuthenticated) return;
    let rafId = 0;
    let lastEmit = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (now - lastEmit < 32) return;
      lastEmit = now;

      const clk = clockRef.current;
      if (!clk.trackId) {
        setCurrentMs(0);
        return;
      }
      const elapsed = clk.isPlaying ? now - clk.anchorPerfMs : 0;
      const computed = Math.max(0, Math.min(clk.durationMs, clk.anchorProgressMs + elapsed));
      setCurrentMs(computed);
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
    localStorage.setItem('sv:preset:v2', next);
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

  const toggleColorCycle = useCallback(() => {
    setColorCycle((prev) => {
      const next = !prev;
      localStorage.setItem('sv:colorCycle', next ? '1' : '0');
      return next;
    });
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

  const handleLogin = useCallback(
    async (clientId: string) => {
      setAuth((prev) => ({ ...prev, isAuthenticating: true, error: null, errorCode: null }));
      if (audioEnabled && audioStatus !== 'active') {
        void audioEngineRef.current?.startCapture();
      }
      const nextAuth = await window.visualizer.auth.login(clientId);
      setAuth(nextAuth);
    },
    [audioEnabled, audioStatus]
  );

  const handleLogout = useCallback(async () => {
    const nextAuth = await window.visualizer.auth.logout();
    setAuth(nextAuth);
    setShowShortcuts(false);
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
        if (showShortcuts) {
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
          selectPreset('pulse');
          revealHud();
          break;
        case '2':
          selectPreset('eclipse');
          revealHud();
          break;
        case '3':
          selectPreset('tide');
          revealHud();
          break;
        case '4':
          selectPreset('spectrum');
          revealHud();
          break;
        case 'v':
        case 'V':
          toggleCover();
          revealHud();
          break;
        case 'c':
        case 'C':
          toggleColorCycle();
          revealHud();
          break;
        case 'm':
        case 'M':
          cycleLayout();
          revealHud();
          break;
        case 'a':
        case 'A':
          setAudioEnabled((v) => !v);
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
    cycleLayout,
    handlePlaybackControl,
    handleToggleFullscreen,
    isFullscreen,
    nudgeOffset,
    resetOffset,
    revealHud,
    selectPreset,
    showShortcuts,
    toggleColorCycle,
    toggleCover,
  ]);

  const effectiveLyricTimeMs = Math.max(0, currentMs + offsetMs);
  const hideCursor = auth.isAuthenticated && !hudVisible && !showShortcuts;

  return (
    <div className={`app-root ${hideCursor ? 'cursor-hidden' : ''}`}>
      <ShaderCanvas
        preset={preset}
        palette={palette}
        audioEnabled={audioEnabled}
        colorCycle={colorCycle}
        isPlaying={Boolean(playback?.isPlaying)}
        onAudioStatusChange={setAudioStatus}
        audioEngineRef={audioEngineRef}
      />

      {!authLoaded ? null : !auth.isAuthenticated ? (
        <LoginScreen
          auth={auth}
          isFullscreen={isFullscreen}
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
            isLoadingLyrics={isLoadingLyrics}
          />

          <ControlHud
            visible={hudVisible || showShortcuts}
            trackPeekVisible={trackPeekVisible}
            auth={auth}
            playback={playback}
            albumArtDataUrl={albumArtDataUrl}
            currentMs={currentMs}
            preset={preset}
            layoutMode={layoutMode}
            showCover={showCover}
            audioEnabled={audioEnabled}
            audioStatus={audioStatus}
            colorCycle={colorCycle}
            offsetMs={offsetMs}
            offsetToast={offsetToast}
            isFullscreen={isFullscreen}
            showShortcuts={showShortcuts}
            onSelectPreset={selectPreset}
            onCycleLayout={cycleLayout}
            onToggleCover={toggleCover}
            onToggleAudio={() => setAudioEnabled((v) => !v)}
            onToggleColorCycle={toggleColorCycle}
            onPlaybackControl={(action) => void handlePlaybackControl(action)}
            onNudgeOffset={nudgeOffset}
            onResetOffset={resetOffset}
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
