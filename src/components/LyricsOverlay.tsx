import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { LocateFixed, Music2 } from 'lucide-react';
import type {
  LyricLine,
  LyricsLayoutMode,
  LyricsResult,
  PlaybackState,
  TrackInfo,
} from '@shared/types';
import { findActiveLineIndex } from '@/lib/lrcParser';
import { computeLetterProgression } from '@/lib/letterTiming';

interface LyricsOverlayProps {
  playback: PlaybackState | null;
  albumArtDataUrl: string | null;
  lyricsResult: LyricsResult | null;
  parsedLines: LyricLine[];
  currentMs: number;
  layoutMode: LyricsLayoutMode;
  showCover: boolean;
  letterSweep: boolean;
  isLoadingLyrics: boolean;
}

function renderActiveLineContent(
  line: LyricLine,
  nextLineTimeMs: number | null,
  trackDurationMs: number,
  currentMs: number,
  letterSweep: boolean
) {
  if (letterSweep) {
    const groups = computeLetterProgression(line, nextLineTimeMs, trackDurationMs, currentMs);
    return groups.map((group, gIdx) => {
      if (group.isSpace) {
        return <Fragment key={`sp-${gIdx}`}>{' '.repeat(group.chars.length)}</Fragment>;
      }
      return (
        <span key={`w-${gIdx}`} className="lyric-word-group">
          {group.chars.map((c, cIdx) => {
            const style = {
              '--fill': c.fill.toFixed(3),
              '--hop': `${c.hopPx.toFixed(2)}px`,
              '--cscale': c.scale.toFixed(3),
            } as CSSProperties;
            return (
              <span
                key={`c-${gIdx}-${cIdx}`}
                className={`lyric-char ${c.isBackground ? 'is-bg-vocal' : ''}`}
                style={style}
              >
                {c.char}
              </span>
            );
          })}
        </span>
      );
    });
  }

  if (!line.words || line.words.length === 0) {
    return line.text;
  }

  return line.words.map((word, idx) => {
    const sung = currentMs >= word.timeMs;
    return (
      <span
        key={`${idx}-${word.timeMs}`}
        className={`lyric-word ${sung ? 'word-sung' : 'word-upcoming'}`}
      >
        {word.text}
      </span>
    );
  });
}

function AlbumCoverCard({
  track,
  albumArtDataUrl,
  compact = false,
}: {
  track: TrackInfo;
  albumArtDataUrl: string | null;
  compact?: boolean;
}) {
  const src = albumArtDataUrl ?? track.albumArtUrl;
  return (
    <div className={`cover-showcase-pane ${compact ? 'is-compact' : ''}`}>
      <div className="cover-showcase-frame">
        {src ? (
          <img src={src} alt={track.album || track.name} className="cover-showcase-art" />
        ) : (
          <div className="cover-showcase-art cover-placeholder">
            <Music2 size={56} opacity={0.45} />
          </div>
        )}
      </div>
      <div className="cover-showcase-meta">
        <div className="cover-showcase-title">{track.name}</div>
        <div className="cover-showcase-artist">{track.artists.join(', ')}</div>
      </div>
    </div>
  );
}

export function LyricsOverlay({
  playback,
  albumArtDataUrl,
  lyricsResult,
  parsedLines,
  currentMs,
  layoutMode,
  showCover,
  letterSweep,
  isLoadingLyrics,
}: LyricsOverlayProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [vpHeight, setVpHeight] = useState(520);
  const [isUserScrolled, setIsUserScrolled] = useState(false);

  const ignoreScrollUntilRef = useRef(0);
  const expectedScrollTopRef = useRef(0);
  const hasInitialPositionedRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);

  const track = playback?.track ?? null;
  const trackId = track?.id ?? null;

  const activeIndex = useMemo(
    () => findActiveLineIndex(parsedLines, currentMs),
    [parsedLines, currentMs]
  );

  // Reset manual scroll state whenever switching tracks, lyrics source, or layout mode
  useEffect(() => {
    setIsUserScrolled(false);
    hasInitialPositionedRef.current = false;
  }, [trackId, layoutMode, lyricsResult?.status]);

  // Measure the Focus viewport height so first & last lyric lines center accurately on every screen
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const updateHeight = () => {
      const h = vp.clientHeight;
      if (h > 0) setVpHeight(h);
    };
    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateHeight);
      ro.observe(vp);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [layoutMode, showCover, lyricsResult?.status, parsedLines.length]);

  const scrollToActiveLine = useCallback(
    (behavior: ScrollBehavior) => {
      const vp = viewportRef.current;
      if (!vp || parsedLines.length === 0) return;
      const targetIndex = activeIndex < 0 ? 0 : activeIndex;
      const el = lineRefs.current[targetIndex];
      if (!el) return;

      const targetTop = Math.max(0, el.offsetTop + el.offsetHeight / 2 - vp.clientHeight / 2);
      expectedScrollTopRef.current = targetTop;
      ignoreScrollUntilRef.current = performance.now() + (behavior === 'smooth' ? 850 : 200);
      vp.scrollTo({ top: targetTop, behavior });
    },
    [activeIndex, parsedLines.length]
  );

  // Auto-scroll smoothly to active line in Focus mode unless the user manually scrolled away
  useLayoutEffect(() => {
    if (layoutMode !== 'focus' || parsedLines.length === 0 || isUserScrolled) {
      return;
    }
    const behavior: ScrollBehavior = hasInitialPositionedRef.current ? 'smooth' : 'auto';
    hasInitialPositionedRef.current = true;
    scrollToActiveLine(behavior);
  }, [activeIndex, isUserScrolled, layoutMode, parsedLines.length, scrollToActiveLine, showCover, vpHeight]);

  // Gentle auto-drift for unsynced plain lyrics unless user manually scrolled
  useEffect(() => {
    if (
      layoutMode !== 'focus' ||
      lyricsResult?.status !== 'plain' ||
      !track ||
      track.durationMs <= 0 ||
      isUserScrolled
    ) {
      return;
    }
    const vp = viewportRef.current;
    if (!vp) return;
    const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
    const ratio = Math.max(0, Math.min(1, currentMs / track.durationMs));
    const targetTop = ratio * maxScroll;
    expectedScrollTopRef.current = targetTop;
    ignoreScrollUntilRef.current = performance.now() + 250;
    vp.scrollTo({ top: targetTop, behavior: 'auto' });
  }, [currentMs, isUserScrolled, layoutMode, lyricsResult?.status, track]);

  useEffect(() => {
    lineRefs.current = lineRefs.current.slice(0, parsedLines.length);
  }, [parsedLines.length]);

  const markUserScrolled = useCallback(() => {
    ignoreScrollUntilRef.current = 0;
    setIsUserScrolled(true);
  }, []);

  const handleViewportWheel = useCallback(() => {
    markUserScrolled();
  }, [markUserScrolled]);

  const handleViewportTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleViewportTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (touchStartYRef.current === null) return;
      const y = e.touches[0]?.clientY ?? touchStartYRef.current;
      if (Math.abs(y - touchStartYRef.current) > 8) {
        markUserScrolled();
      }
    },
    [markUserScrolled]
  );

  const handleViewportScroll = useCallback(() => {
    if (isUserScrolled) return;
    const vp = viewportRef.current;
    if (!vp) return;
    if (performance.now() < ignoreScrollUntilRef.current) return;
    if (Math.abs(vp.scrollTop - expectedScrollTopRef.current) > 36) {
      setIsUserScrolled(true);
    }
  }, [isUserScrolled]);

  const handleResync = useCallback(() => {
    setIsUserScrolled(false);
    if (lyricsResult?.status === 'synced') {
      scrollToActiveLine('smooth');
    } else if (lyricsResult?.status === 'plain' && track && track.durationMs > 0) {
      const vp = viewportRef.current;
      if (!vp) return;
      const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
      const ratio = Math.max(0, Math.min(1, currentMs / track.durationMs));
      const targetTop = ratio * maxScroll;
      expectedScrollTopRef.current = targetTop;
      ignoreScrollUntilRef.current = performance.now() + 850;
      vp.scrollTo({ top: targetTop, behavior: 'smooth' });
    }
  }, [currentMs, lyricsResult?.status, scrollToActiveLine, track]);

  // Error states (e.g., allowlist block)
  if (playback?.status === 'error' && playback.errorCode === 'allowlist') {
    return (
      <div className="lyrics-stage">
        <div className="stage-status-card">
          <span className="stage-status-pill">Allowlist Required</span>
          <h2 className="stage-status-title">Account Not Registered Yet</h2>
          <p className="stage-status-sub">
            Ask the app owner to add your Spotify email under <strong>User Management</strong> in
            the Spotify Developer Dashboard, then wait a few seconds.
          </p>
        </div>
      </div>
    );
  }

  // Hidden lyrics mode: either pure visualizer or clean centered album showcase
  if (layoutMode === 'hidden') {
    if (showCover && track) {
      return (
        <div className="lyrics-stage mode-cover-only">
          <AlbumCoverCard track={track} albumArtDataUrl={albumArtDataUrl} />
        </div>
      );
    }
    return null;
  }

  // Idle / nothing playing on Spotify
  if (!playback || playback.status === 'idle' || !track) {
    if (playback?.status === 'ad') {
      return (
        <div className="lyrics-stage">
          <div className="stage-status-card">
            <span className="stage-status-pill">Spotify Ad</span>
            <div className="instrumental-dots" aria-hidden="true">
              <span className="instrumental-dot" />
              <span className="instrumental-dot" />
              <span className="instrumental-dot" />
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="lyrics-stage">
        <div className="stage-status-card">
          <span className="stage-status-pill">Listening for Spotify</span>
          <h2 className="stage-status-title">Play a song on Spotify</h2>
          <p className="stage-status-sub">
            Start playback on your PC, phone, or speakers — synced lyrics and album colors will
            appear automatically.
          </p>
        </div>
      </div>
    );
  }

  // Cinema mode: album cover occupies the upper flex slot, subtitles strictly in the lower slot (zero overlap)
  if (layoutMode === 'cinema') {
    const activeLine = activeIndex >= 0 ? parsedLines[activeIndex] : null;
    const nextLine =
      activeIndex + 1 < parsedLines.length ? parsedLines[activeIndex + 1] : null;

    return (
      <div className={`lyrics-stage mode-cinema ${showCover ? 'has-cover-cinema' : ''}`}>
        {showCover && (
          <div className="cover-cinema-slot">
            <AlbumCoverCard track={track} albumArtDataUrl={albumArtDataUrl} compact />
          </div>
        )}

        <div className="cinema-stack">
          {lyricsResult?.status === 'synced' && parsedLines.length > 0 ? (
            <>
              {activeLine && activeLine.text ? (
                <div
                  key={activeIndex}
                  className={`cinema-active ${letterSweep ? 'is-sweep' : ''}`}
                >
                  {renderActiveLineContent(
                    activeLine,
                    nextLine ? nextLine.timeMs : null,
                    track.durationMs,
                    currentMs,
                    letterSweep
                  )}
                </div>
              ) : (
                <div className="instrumental-dots" aria-hidden="true">
                  <span className="instrumental-dot" />
                  <span className="instrumental-dot" />
                  <span className="instrumental-dot" />
                </div>
              )}
              {nextLine && nextLine.text && (
                <div className="cinema-next">{nextLine.text}</div>
              )}
            </>
          ) : isLoadingLyrics ? (
            <div className="instrumental-dots" aria-hidden="true">
              <span className="instrumental-dot" />
              <span className="instrumental-dot" />
              <span className="instrumental-dot" />
            </div>
          ) : (
            <span className="stage-status-pill">
              {lyricsResult?.status === 'instrumental' ? 'Instrumental' : 'Pure Visualizer'}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Focus mode: side-by-side non-overlapping flex layout when showCover is ON
  const renderFocusLyricsContent = () => {
    if (isLoadingLyrics && parsedLines.length === 0) {
      return (
        <div className="lyrics-empty-slot">
          <div className="instrumental-dots" aria-hidden="true">
            <span className="instrumental-dot" />
            <span className="instrumental-dot" />
            <span className="instrumental-dot" />
          </div>
        </div>
      );
    }

    const edgePadPx = Math.max(72, Math.round(vpHeight * 0.45));

    if (lyricsResult?.status === 'synced' && parsedLines.length > 0) {
      return (
        <div className="lyrics-focus-wrap">
          <div
            ref={viewportRef}
            className={`lyrics-focus-viewport ${isUserScrolled ? 'is-browsing' : ''}`}
            onWheel={handleViewportWheel}
            onTouchStart={handleViewportTouchStart}
            onTouchMove={handleViewportTouchMove}
            onScroll={handleViewportScroll}
          >
            <div
              className="lyrics-track"
              style={{ paddingTop: `${edgePadPx}px`, paddingBottom: `${edgePadPx}px` }}
            >
              {parsedLines.map((line, index) => {
                const delta = activeIndex < 0 ? index + 1 : index - activeIndex;
                let stateClass = 'is-distant';
                if (index === activeIndex) stateClass = 'is-active';
                else if (delta === 1 || delta === -1) stateClass = delta < 0 ? 'is-past' : 'is-near';
                else if (Math.abs(delta) === 2) stateClass = 'is-far';

                const isActiveLine = index === activeIndex;
                const nextLineTimeMs =
                  index + 1 < parsedLines.length ? parsedLines[index + 1].timeMs : null;

                return (
                  <div
                    key={`${index}-${line.timeMs}`}
                    ref={(el) => {
                      lineRefs.current[index] = el;
                    }}
                    className={`lyric-line ${stateClass} ${isActiveLine && letterSweep ? 'is-sweep' : ''}`}
                  >
                    {line.text === '' ? (
                      <span className="instrumental-dots" aria-hidden="true">
                        <span className="instrumental-dot" />
                        <span className="instrumental-dot" />
                        <span className="instrumental-dot" />
                      </span>
                    ) : isActiveLine ? (
                      renderActiveLineContent(
                        line,
                        nextLineTimeMs,
                        track.durationMs,
                        currentMs,
                        letterSweep
                      )
                    ) : (
                      line.text
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {isUserScrolled && (
            <button
              type="button"
              className="lyrics-resync-btn"
              onClick={handleResync}
              title="Jump back to the currently playing lyric line"
            >
              <LocateFixed size={14} />
              <span>Sync</span>
            </button>
          )}
        </div>
      );
    }

    if (lyricsResult?.status === 'plain' && lyricsResult.plainLyrics) {
      const plainLines = lyricsResult.plainLyrics
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      return (
        <div className="lyrics-plain-column">
          <span className="plain-lyrics-badge">Unsynced Lyrics</span>
          <div className="lyrics-focus-wrap">
            <div
              ref={viewportRef}
              className={`lyrics-focus-viewport ${isUserScrolled ? 'is-browsing' : ''}`}
              onWheel={handleViewportWheel}
              onTouchStart={handleViewportTouchStart}
              onTouchMove={handleViewportTouchMove}
              onScroll={handleViewportScroll}
            >
              <div
                className="lyrics-track"
                style={{
                  paddingTop: `${Math.round(edgePadPx * 0.6)}px`,
                  paddingBottom: `${Math.round(edgePadPx * 0.6)}px`,
                  gap: '18px',
                }}
              >
                {plainLines.map((text, idx) => (
                  <div key={idx} className="plain-lyrics-line">
                    {text}
                  </div>
                ))}
              </div>
            </div>

            {isUserScrolled && (
              <button
                type="button"
                className="lyrics-resync-btn"
                onClick={handleResync}
                title="Resume auto-scroll"
              >
                <LocateFixed size={14} />
                <span>Sync</span>
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="lyrics-empty-slot">
        <div className="stage-status-card">
          <span className="stage-status-pill">
            {lyricsResult?.status === 'instrumental' ? 'Instrumental' : 'Pure Visualizer'}
          </span>
          <div className="instrumental-dots" aria-hidden="true">
            <span className="instrumental-dot" />
            <span className="instrumental-dot" />
            <span className="instrumental-dot" />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`lyrics-stage ${showCover ? 'has-cover-focus' : ''}`}>
      {showCover && (
        <AlbumCoverCard track={track} albumArtDataUrl={albumArtDataUrl} />
      )}
      {renderFocusLyricsContent()}
    </div>
  );
}
