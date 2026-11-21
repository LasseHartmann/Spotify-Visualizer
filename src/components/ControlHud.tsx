import {
  Disc3,
  EyeOff,
  HelpCircle,
  Lock,
  LogOut,
  Maximize2,
  Minimize2,
  Minus,
  Music2,
  Palette,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Sparkles,
  Subtitles,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  AuthState,
  LyricsLayoutMode,
  PlaybackControlAction,
  PlaybackState,
  ShaderPresetId,
} from '@shared/types';
import type { AudioCaptureStatus } from '@/audio/audioEngine';
import { SHADER_PRESETS } from '@/shaders/presets';

interface ControlHudProps {
  visible: boolean;
  trackPeekVisible: boolean;
  auth: AuthState;
  playback: PlaybackState | null;
  albumArtDataUrl: string | null;
  currentMs: number;
  preset: ShaderPresetId;
  layoutMode: LyricsLayoutMode;
  showCover: boolean;
  audioEnabled: boolean;
  audioStatus: AudioCaptureStatus;
  colorCycle: boolean;
  offsetMs: number;
  offsetToast: string | null;
  isFullscreen: boolean;
  showShortcuts: boolean;
  onSelectPreset: (preset: ShaderPresetId) => void;
  onCycleLayout: () => void;
  onToggleCover: () => void;
  onToggleAudio: () => void;
  onToggleColorCycle: () => void;
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
  auth,
  playback,
  albumArtDataUrl,
  currentMs,
  preset,
  layoutMode,
  showCover,
  audioEnabled,
  audioStatus,
  colorCycle,
  offsetMs,
  offsetToast,
  isFullscreen,
  showShortcuts,
  onSelectPreset,
  onCycleLayout,
  onToggleCover,
  onToggleAudio,
  onToggleColorCycle,
  onPlaybackControl,
  onNudgeOffset,
  onResetOffset,
  onToggleFullscreen,
  onToggleShortcuts,
  onLogout,
  onClose,
}: ControlHudProps) {
  const track = playback?.track ?? null;
  const progressPct =
    track && track.durationMs > 0
      ? Math.max(0, Math.min(100, (currentMs / track.durationMs) * 100))
      : 0;

  const layoutLabel =
    layoutMode === 'focus'
      ? 'Lyrics: Focus'
      : layoutMode === 'cinema'
        ? 'Lyrics: Cinema'
        : 'Lyrics: Off';

  const isLiveRunning = audioEnabled && audioStatus === 'active';
  const formattedOffset = `${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(1)}s`;

  // Hide bottom track card peek when large album cover showcase is already showing on stage
  const showTrackCard = Boolean(track) && (visible || (trackPeekVisible && !showCover));

  return (
    <>
      {offsetToast && <div className="offset-toast">{offsetToast}</div>}

      <div className="hud-layer">
        {/* TOP BAR */}
        <div className={`hud-top ${visible ? 'is-visible' : 'is-hidden'}`}>
          <div className="hud-group">
            <div className="glass-pill">
              <button
                className={`hud-btn ${audioEnabled ? 'active' : ''}`}
                onClick={onToggleAudio}
                title="Toggle live Windows audio reactivity (A)"
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
                  {!audioEnabled ? 'Audio Off' : isLiveRunning ? 'Live Audio' : 'Ambient'}
                </span>
              </button>
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
                title="Cycle lyrics layout (M)"
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
                className={`hud-btn ${showCover ? 'active' : ''}`}
                onClick={onToggleCover}
                title="Show / hide album cover alongside lyrics (V)"
              >
                <Disc3 size={14} />
                <span>Cover</span>
              </button>

              <button
                className={`hud-btn ${!colorCycle ? 'active' : ''}`}
                onClick={onToggleColorCycle}
                title={
                  colorCycle
                    ? 'Cycling through album cover colors — click to lock primary album color (C)'
                    : 'Locked to primary album cover color — click to cycle album colors (C)'
                }
              >
                {colorCycle ? <Palette size={14} /> : <Lock size={14} />}
                <span>{colorCycle ? 'Album Cycle' : 'Color Lock'}</span>
              </button>

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
              <button
                className="hud-btn icon-only danger"
                onClick={onClose}
                title="Close Spotify Visualizer"
              >
                <X size={15} />
              </button>
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
            <div
              className="backlight-swatch-wrap"
              title="Live album color driving your backlight (auto-regulated pulse)"
            >
              <span className="backlight-swatch" />
              <span className="backlight-label">
                {colorCycle ? 'Album Backlight' : 'Locked Album Color'}
              </span>
            </div>

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
                <span>Switch Shader Style</span>
                <span className="kbd-group">
                  <kbd className="kbd">1</kbd>
                  <kbd className="kbd">2</kbd>
                  <kbd className="kbd">3</kbd>
                  <kbd className="kbd">4</kbd>
                </span>
              </div>
              <div className="shortcut-row">
                <span>Show / Hide Album Cover</span>
                <kbd className="kbd">V</kbd>
              </div>
              <div className="shortcut-row">
                <span>Toggle Album Color Cycle vs Color Lock</span>
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
