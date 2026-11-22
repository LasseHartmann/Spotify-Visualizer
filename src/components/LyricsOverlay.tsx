import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Music2 } from 'lucide-react';
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
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [translateY, setTranslateY] = useState(0);

  const activeIndex = useMemo(
    () => findActiveLineIndex(parsedLines, currentMs),
    [parsedLines, currentMs]
  );

  // Smoothly center the active lyric line vertically in Focus mode (re-measures if cover toggles width)
  useLayoutEffect(() => {
    if (layoutMode !== 'focus' || parsedLines.length === 0) {
      setTranslateY(0);
      return;
    }

    const measure = () => {
      const targetIndex = activeIndex < 0 ? 0 : activeIndex;
      const el = lineRefs.current[targetIndex];
      if (!el) return;
      const centerOffset = el.offsetTop + el.offsetHeight / 2;
      setTranslateY(-centerOffset);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeIndex, layoutMode, parsedLines, showCover]);

  useEffect(() => {
    lineRefs.current = lineRefs.current.slice(0, parsedLines.length);
  }, [parsedLines.length]);

  const track = playback?.track ?? null;

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

    if (lyricsResult?.status === 'synced' && parsedLines.length > 0) {
      return (
        <div className="lyrics-focus-viewport">
          <div
            className="lyrics-track"
            style={{ transform: `translate3d(0, ${translateY}px, 0)` }}
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
      );
    }

    if (lyricsResult?.status === 'plain' && lyricsResult.plainLyrics) {
      const plainLines = lyricsResult.plainLyrics
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const ratio =
        track.durationMs > 0
          ? Math.max(0, Math.min(1, currentMs / track.durationMs))
          : 0;
      const approxLineHeight = 56;
      const driftY = -ratio * Math.max(0, (plainLines.length - 1) * approxLineHeight);

      return (
        <div className="lyrics-plain-column">
          <span className="plain-lyrics-badge">Unsynced Lyrics</span>
          <div className="lyrics-focus-viewport">
            <div
              className="lyrics-track"
              style={{
                transform: `translate3d(0, ${driftY}px, 0)`,
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
