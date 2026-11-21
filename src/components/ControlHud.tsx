import { useEffect, useRef, useState } from 'react';
import {
  Disc3,
  EyeOff,
  HelpCircle,
  Lock,
  LogOut,
  Maximize2,
  Mic,
  Minimize2,
  Minus,
  Monitor,
  Music2,
  Palette,
  Pause,
  Pipette,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Sparkles,
  Subtitles,
  Type,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  AuthState,
  ColorMode,
  LyricsLayoutMode,
  PlaybackControlAction,
  PlaybackState,
  ShaderPresetId,
} from '@shared/types';
import type { AudioCaptureStatus } from '@/audio/audioEngine';
import { SHADER_PRESETS } from '@/shaders/presets';

interface ColorSwatch {
  name: string;
  hex: string;
}

const COLOR_SWATCHES: ColorSwatch[] = [
  { name: 'Pure Black', hex: '#000000' },
  { name: 'Obsidian', hex: '#0a0d14' },
  { name: 'Deep Navy', hex: '#0f1d40' },
  { name: 'Dark Wine', hex: '#2b0a12' },
  { name: 'Crimson', hex: '#c81e32' },
  { name: 'Warm Gold', hex: '#d99b26' },
  { name: 'Emerald Teal', hex: '#0f766e' },
  { name: 'Violet', hex: '#6d28d9' },
  { name: 'Light Paper', hex: '#f4f4f6' },
];

interface ControlHudProps {
  visible: boolean;
  trackPeekVisible: boolean;
  isWeb: boolean;
  auth: AuthState;
  playback: PlaybackState | null;
  albumArtDataUrl: string | null;
  currentMs: number;
  preset: ShaderPresetId;
  layoutMode: LyricsLayoutMode;
  showCover: boolean;
  letterSweep: boolean;
  audioEnabled: boolean;
  audioStatus: AudioCaptureStatus;
  showAudioMenu: boolean;
  colorMode: ColorMode;
  customColor: string;
  showColorMenu: boolean;
  offsetMs: number;
  offsetToast: string | null;
  isFullscreen: boolean;
  showShortcuts: boolean;
  onSelectPreset: (preset: ShaderPresetId) => void;
  onCycleLayout: () => void;
  onToggleCover: () => void;
  onToggleLetterSweep: () => void;
  onToggleAudio: () => void;
  onCloseAudioMenu: () => void;
  onSelectWebAudioSource: (source: 'display' | 'mic' | 'off') => void;
  onToggleColorMenu: () => void;
  onCloseColorMenu: () => void;
  onSelectColorMode: (mode: ColorMode) => void;
  onChangeCustomColor: (hex: string) => void;
  onPlaybackControl: (action: PlaybackControlAction) => void;
  onNudgeOffset: (deltaMs: number) => void;
  onResetOffset: () => void;
  onToggleFullscreen: () => void;
  onToggleShortcuts: () => void;
  onLogout: () => void;
  onClose: () => void;
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ControlHud({
  visible,
  trackPeekVisible,
  isWeb,
  auth,
  playback,
  albumArtDataUrl,
  currentMs,
  preset,
  layoutMode,
  showCover,
  letterSweep,
  audioEnabled,
  audioStatus,
  showAudioMenu,
  colorMode,
  customColor,
  showColorMenu,
  offsetMs,
  offsetToast,
  isFullscreen,
  showShortcuts,
  onSelectPreset,
  onCycleLayout,
  onToggleCover,
  onToggleLetterSweep,
  onToggleAudio,
  onCloseAudioMenu,
  onSelectWebAudioSource,
  onToggleColorMenu,
  onCloseColorMenu,
  onSelectColorMode,
  onChangeCustomColor,
  onPlaybackControl,
  onNudgeOffset,
  onResetOffset,
  onToggleFullscreen,
  onToggleShortcuts,
  onLogout,
  onClose,
}: ControlHudProps) {
  const colorPopoverRef = useRef<HTMLDivElement | null>(null);
  const audioPopoverRef = useRef<HTMLDivElement | null>(null);
  const [hexDraft, setHexDraft] = useState(customColor);

  useEffect(() => {
    setHexDraft(customColor);
  }, [customColor]);

  // Close color popover when clicking anywhere outside of it
  useEffect(() => {
    if (!showColorMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (colorPopoverRef.current && target && !colorPopoverRef.current.contains(target)) {
        const el = target instanceof Element ? target.closest('[data-color-trigger="true"]') : null;
        if (!el) {
          onCloseColorMenu();
        }
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showColorMenu, onCloseColorMenu]);

  // Close web audio source popover when clicking anywhere outside of it
  useEffect(() => {
    if (!showAudioMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (audioPopoverRef.current && target && !audioPopoverRef.current.contains(target)) {
        onCloseAudioMenu();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showAudioMenu, onCloseAudioMenu]);

  const track = playback?.track ?? null;
  const progressPct =
    track && track.durationMs > 0
      ? Math.max(0, Math.min(100, (currentMs / track.durationMs) * 100))
      : 0;

  const layoutLabel =
    layoutMode === 'focus'
      ? 'Focus'
      : layoutMode === 'cinema'
        ? 'Cinema'
        : 'Off';

  const colorButtonLabel =
    colorMode === 'custom'
      ? 'Custom'
      : colorMode === 'album-lock'
        ? 'Locked'
        : 'Color';

  const backlightLabel =
    colorMode === 'custom'
      ? `Custom ${customColor.toUpperCase()}`
      : colorMode === 'album-lock'
        ? 'Locked Album'
        : 'Album Backlight';

  const isLiveRunning = audioEnabled && audioStatus === 'active';
  const formattedOffset = `${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(1)}s`;

  // Hide bottom track card peek when large album cover showcase is already showing on stage
  const showTrackCard = Boolean(track) && (visible || (trackPeekVisible && !showCover));

  const handleHexInputChange = (raw: string) => {
    setHexDraft(raw);
    const cleaned = raw.trim().replace(/^#/, '');
    if (/^[a-f0-9]{6}$/i.test(cleaned)) {
      const normalized = `#${cleaned.toLowerCase()}`;
      onChangeCustomColor(normalized);
      if (colorMode !== 'custom') onSelectColorMode('custom');
    }
  };

  const handleHexInputBlur = () => {
    const cleaned = hexDraft.trim().replace(/^#/, '');
    if (/^[a-f0-9]{6}$/i.test(cleaned)) {
      const normalized = `#${cleaned.toLowerCase()}`;
      setHexDraft(normalized);
      onChangeCustomColor(normalized);
      if (colorMode !== 'custom') onSelectColorMode('custom');
    } else {
      setHexDraft(customColor);
    }
  };

  return (
    <>
      {offsetToast && <div className="offset-toast">{offsetToast}</div>}

      <div className="hud-layer">
        {/* TOP BAR */}
        <div className={`hud-top ${visible ? 'is-visible' : 'is-hidden'}`}>
          <div className="hud-group">
            <div className="glass-pill">
              <div className="audio-picker-wrap" ref={audioPopoverRef}>
                <button
                  className={`hud-btn ${isLiveRunning || showAudioMenu || (!isWeb && audioEnabled) ? 'active' : ''}`}
                  onClick={onToggleAudio}
                  title={
                    isWeb
                      ? 'Choose browser live audio source (A)'
                      : 'Toggle live Windows audio reactivity (A)'
                  }
                >
                  {isLiveRunning ? (
                    <span className="mini-eq" aria-hidden="true">
                      <span className="mini-eq-bar b0" />
                      <span className="mini-eq-bar b1" />
                      <span className="mini-eq-bar b2" />
                      <span className="mini-eq-bar b3" />
                      <span className="mini-eq-bar b4" />
                    </span>
                  ) : (
                    <VolumeX size={14} />
                  )}
                  <span>
                    {isLiveRunning
                      ? 'Live Audio'
                      : isWeb
                        ? 'Ambient'
                        : !audioEnabled
                          ? 'Audio Off'
                          : 'Ambient'}
                  </span>
                </button>

                {isWeb && showAudioMenu && (
                  <div className="audio-popover" onClick={(e) => e.stopPropagation()}>
                    <div className="color-popover-header">
                      <span>Browser Live Audio</span>
                      <button
                        className="hud-btn icon-only"
                        style={{ width: 24, height: 24 }}
                        onClick={onCloseAudioMenu}
                        title="Close audio menu"
                      >
                        <X size={13} />
                      </button>
                    </div>

                    <button
                      className="audio-source-btn"
                      onClick={() => onSelectWebAudioSource('display')}
                    >
                      <Monitor size={15} />
                      <div className="audio-source-copy">
                        <span className="audio-source-title">Tab / Screen Audio</span>
                        <span className="audio-source-sub">
                          Best with a Spotify Web Player tab
                        </span>
                      </div>
                    </button>

                    <button
                      className="audio-source-btn"
                      onClick={() => onSelectWebAudioSource('mic')}
                    >
                      <Mic size={15} />
                      <div className="audio-source-copy">
                        <span className="audio-source-title">Microphone / Line-In</span>
                        <span className="audio-source-sub">
                          Works with speakers or virtual audio cables
                        </span>
                      </div>
                    </button>

                    <button
                      className={`audio-source-btn ${!isLiveRunning ? 'is-active' : ''}`}
                      onClick={() => onSelectWebAudioSource('off')}
                    >
                      <VolumeX size={15} />
                      <div className="audio-source-copy">
                        <span className="audio-source-title">Ambient Only</span>
                        <span className="audio-source-sub">
                          Smooth automatic breathing motion
                        </span>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="glass-pill">
              {SHADER_PRESETS.map((item) => (
                <button
                  key={item.id}
                  className={`hud-btn ${preset === item.id ? 'active' : ''}`}
                  onClick={() => onSelectPreset(item.id)}
                  title={`${item.name} — ${item.tagline} (${item.key})`}
                >
                  <span className="preset-key">{item.key}</span>
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="hud-group">
            <div className="glass-pill">
              <button
                className="hud-btn"
                onClick={onCycleLayout}
                title="Cycle lyrics layout: Focus / Cinema / Off (M)"
              >
                {layoutMode === 'hidden' ? (
                  <EyeOff size={14} />
                ) : layoutMode === 'cinema' ? (
                  <Subtitles size={14} />
                ) : (
                  <Sparkles size={14} />
                )}
                <span>{layoutLabel}</span>
              </button>

              <button
                className={`hud-btn ${letterSweep ? 'active' : ''}`}
                onClick={onToggleLetterSweep}
                title="Toggle smooth letter-by-letter lyric progression & jump (L)"
              >
                <Type size={14} />
                <span>Sweep</span>
              </button>

              <button
                className={`hud-btn ${showCover ? 'active' : ''}`}
                onClick={onToggleCover}
                title="Show / hide album cover alongside lyrics (V)"
              >
                <Disc3 size={14} />
                <span>Cover</span>
              </button>

              <div className="color-picker-wrap" ref={colorPopoverRef}>
                <button
                  className={`hud-btn ${showColorMenu || colorMode !== 'album-cycle' ? 'active' : ''}`}
                  onClick={onToggleColorMenu}
                  title="Choose background color or album color mode (C to cycle)"
                  data-color-trigger="true"
                >
                  <span
                    className="hud-color-dot"
                    style={
                      colorMode === 'custom'
                        ? { background: customColor }
                        : undefined
                    }
                  />
                  <span>{colorButtonLabel}</span>
                </button>

                {showColorMenu && (
                  <div
                    className="color-popover"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="color-popover-header">
                      <span>Background Color</span>
                      <button
                        className="hud-btn icon-only"
                        style={{ width: 24, height: 24 }}
                        onClick={onCloseColorMenu}
                        title="Close color picker"
                      >
                        <X size={13} />
                      </button>
                    </div>

                    <div className="color-mode-row">
                      <button
                        className={`color-mode-btn ${colorMode === 'album-cycle' ? 'active' : ''}`}
                        onClick={() => onSelectColorMode('album-cycle')}
                      >
                        <Palette size={13} />
                        <span>Album Cycle</span>
                      </button>
                      <button
                        className={`color-mode-btn ${colorMode === 'album-lock' ? 'active' : ''}`}
                        onClick={() => onSelectColorMode('album-lock')}
                      >
                        <Lock size={13} />
                        <span>Album Lock</span>
                      </button>
                      <button
                        className={`color-mode-btn ${colorMode === 'custom' ? 'active' : ''}`}
                        onClick={() => onSelectColorMode('custom')}
                      >
                        <Pipette size={13} />
                        <span>Custom</span>
                      </button>
                    </div>

                    <div className="color-section-label">Quick Swatches</div>
                    <div className="swatch-grid">
                      {COLOR_SWATCHES.map((swatch) => {
                        const isSelected =
                          colorMode === 'custom' &&
                          customColor.toLowerCase() === swatch.hex.toLowerCase();
                        return (
                          <button
                            key={swatch.hex}
                            className={`swatch-btn ${isSelected ? 'is-selected' : ''}`}
                            style={{ background: swatch.hex }}
                            title={`${swatch.name} (${swatch.hex.toUpperCase()})`}
                            onClick={() => {
                              onChangeCustomColor(swatch.hex);
                              onSelectColorMode('custom');
                            }}
                          />
                        );
                      })}
                    </div>

                    <div className="hex-input-row">
                      <label
                        className="native-color-wrap"
                        title="Pick any custom background color"
                      >
                        <input
                          type="color"
                          className="native-color-input"
                          value={customColor}
                          onChange={(e) => {
                            onChangeCustomColor(e.target.value.toLowerCase());
                            if (colorMode !== 'custom') onSelectColorMode('custom');
                          }}
                        />
                        <span
                          className="native-color-preview"
                          style={{ background: customColor }}
                        />
                      </label>
                      <input
                        type="text"
                        className="hex-text-input"
                        value={hexDraft}
                        onChange={(e) => handleHexInputChange(e.target.value)}
                        onBlur={handleHexInputBlur}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.currentTarget as HTMLInputElement).blur();
                          }
                        }}
                        spellCheck={false}
                        maxLength={7}
                        placeholder="#0a0d14"
                        aria-label="Custom background hex color"
                      />
                    </div>
                  </div>
                )}
              </div>

              <button
                className="hud-btn icon-only"
                onClick={onToggleShortcuts}
                title="Keyboard Shortcuts (?)"
              >
                <HelpCircle size={15} />
              </button>

              <button
                className="hud-btn icon-only"
                onClick={onToggleFullscreen}
                title={isFullscreen ? 'Exit Full-Screen (F11 / F)' : 'Full-Screen (F11 / F)'}
              >
                {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </div>

            <div className="glass-pill">
              {auth.user && (
                <div className="hud-btn" style={{ cursor: 'default' }}>
                  {auth.user.avatarUrl && (
                    <img src={auth.user.avatarUrl} alt="" className="user-avatar" />
                  )}
                  <span>{auth.user.displayName}</span>
                </div>
              )}
              <button
                className="hud-btn icon-only"
                onClick={onLogout}
                title="Sign out of Spotify"
              >
                <LogOut size={14} />
              </button>
              {!isWeb && (
                <button
                  className="hud-btn icon-only danger"
                  onClick={onClose}
                  title="Close Spotify Visualizer"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* BOTTOM BAR */}
        <div className="hud-bottom">
          {track ? (
            <div
              className={`track-card ${showTrackCard ? 'peek-visible' : 'peek-hidden'}`}
            >
              {albumArtDataUrl || track.albumArtUrl ? (
                <img
                  src={albumArtDataUrl ?? track.albumArtUrl ?? ''}
                  alt={track.album}
                  className="album-cover"
                />
              ) : (
                <div
                  className="album-cover"
                  style={{ display: 'grid', placeItems: 'center' }}
                >
                  <Music2 size={22} opacity={0.5} />
                </div>
              )}
              <div className="track-meta">
                <div className="track-name">{track.name}</div>
                <div className="track-artist">
                  {track.artists.join(', ')}
                  {track.album ? ` · ${track.album}` : ''}
                </div>
                <div className="track-progress-row">
                  <span className="track-time">{formatTime(currentMs)}</span>
                  <div className="progress-rail">
                    <div
                      className="progress-fill"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <span className="track-time">{formatTime(track.durationMs)}</span>
                </div>
              </div>
            </div>
          ) : (
            <div />
          )}

          {/* CENTER TRANSPORT CONTROLS */}
          <div className={`transport-pill ${visible ? '' : 'is-hidden'}`}>
            <button
              className="hud-btn icon-only transport-btn"
              onClick={() => onPlaybackControl('previous')}
              title="Previous track (←)"
            >
              <SkipBack size={17} />
            </button>
            <button
              className="transport-play-btn"
              onClick={() => onPlaybackControl('playPause')}
              title={playback?.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {playback?.isPlaying ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" style={{ marginLeft: '2px' }} />
              )}
            </button>
            <button
              className="hud-btn icon-only transport-btn"
              onClick={() => onPlaybackControl('next')}
              title="Next track (→)"
            >
              <SkipForward size={17} />
            </button>
          </div>

          <div className={`tuning-panel ${visible ? '' : 'is-hidden'}`}>
            <button
              className="backlight-swatch-btn"
              onClick={onToggleColorMenu}
              title="Open background color picker"
              data-color-trigger="true"
            >
              <span
                className="backlight-swatch"
                style={
                  colorMode === 'custom'
                    ? { background: customColor }
                    : undefined
                }
              />
              <span className="backlight-label">{backlightLabel}</span>
            </button>

            <div className="divider-v" />

            <div
              style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}
              title="Adjust lyric timing sync ([ and ] keys, click readout to reset)"
            >
              <button
                className="hud-btn icon-only"
                onClick={() => onNudgeOffset(-100)}
                title="Lyrics 100ms earlier ([)"
              >
                <Minus size={13} />
              </button>
              <button
                className="hud-btn"
                onClick={onResetOffset}
                style={{ padding: '4px 6px' }}
                title="Reset lyric sync offset (\)"
              >
                <span className="offset-readout">{formattedOffset}</span>
              </button>
              <button
                className="hud-btn icon-only"
                onClick={() => onNudgeOffset(100)}
                title="Lyrics 100ms later (])"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* SHORTCUTS MODAL */}
      {showShortcuts && (
        <div className="shortcuts-backdrop" onClick={onToggleShortcuts}>
          <div className="shortcuts-card" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-header">
              <h2>Keyboard Shortcuts</h2>
              <button className="hud-btn icon-only" onClick={onToggleShortcuts}>
                <X size={16} />
              </button>
            </div>
            <div className="shortcuts-list">
              <div className="shortcut-row">
                <span>Play / Pause Music</span>
                <kbd className="kbd">Space</kbd>
              </div>
              <div className="shortcut-row">
                <span>Previous / Next Track</span>
                <span className="kbd-group">
                  <kbd className="kbd">←</kbd>
                  <kbd className="kbd">→</kbd>
                </span>
              </div>
              <div className="shortcut-row">
                <span>Switch Background Style (5 = Blank)</span>
                <span className="kbd-group">
                  <kbd className="kbd">1</kbd>
                  <kbd className="kbd">2</kbd>
                  <kbd className="kbd">3</kbd>
                  <kbd className="kbd">4</kbd>
                  <kbd className="kbd">5</kbd>
                </span>
              </div>
              <div className="shortcut-row">
                <span>Toggle Letter-by-Letter Sweep</span>
                <kbd className="kbd">L</kbd>
              </div>
              <div className="shortcut-row">
                <span>Show / Hide Album Cover</span>
                <kbd className="kbd">V</kbd>
              </div>
              <div className="shortcut-row">
                <span>Cycle Color Mode (Album / Lock / Custom)</span>
                <kbd className="kbd">C</kbd>
              </div>
              <div className="shortcut-row">
                <span>Cycle Lyrics Mode (Focus / Cinema / Off)</span>
                <kbd className="kbd">M</kbd>
              </div>
              <div className="shortcut-row">
                <span>Toggle Live Audio Reactivity</span>
                <kbd className="kbd">A</kbd>
              </div>
              <div className="shortcut-row">
                <span>Nudge Lyric Timing (±100ms)</span>
                <span className="kbd-group">
                  <kbd className="kbd">[</kbd>
                  <kbd className="kbd">]</kbd>
                </span>
              </div>
              <div className="shortcut-row">
                <span>Reset Lyric Timing Offset</span>
                <kbd className="kbd">\</kbd>
              </div>
              <div className="shortcut-row">
                <span>Toggle Full-Screen</span>
                <span className="kbd-group">
                  <kbd className="kbd">F</kbd>
                  <kbd className="kbd">F11</kbd>
                </span>
              </div>
              <div className="shortcut-row">
                <span>Exit Full-Screen</span>
                <kbd className="kbd">Esc</kbd>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
