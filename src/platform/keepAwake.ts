/**
 * Keeps mobile browsers and Amazon Silk (Echo Show 5 / Fire OS) from sleeping
 * or returning to the home screen while the visualizer is open.
 *
 * Uses two complementary layers (web-only):
 * 1. Standard Screen Wake Lock API (navigator.wakeLock) for modern mobile/desktop browsers.
 * 2. A looping inaudible 1-second silent PCM WAV <audio> stream (unmuted, digital silence)
 *    which signals active media playback so Amazon Silk on Echo Show stays open past its
 *    inactivity timeout once armed by the first screen tap.
 */

export type KeepAwakeStatus = 'off' | 'waiting' | 'active';

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
}

/**
 * Builds a valid 1-second 8kHz 8-bit mono PCM WAV buffer filled with pure digital silence (0x80).
 */
export function buildSilentWavBytes(durationSec = 1, sampleRate = 8000): Uint8Array {
  const numSamples = Math.max(800, Math.round(durationSec * sampleRate));
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // Byte rate (sampleRate * 1 channel * 1 byte)
  view.setUint16(32, 1, true); // Block align
  view.setUint16(34, 8, true); // Bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);

  const bytes = new Uint8Array(buffer);
  // Unsigned 8-bit PCM zero-amplitude midpoint is 128 (pure digital silence)
  bytes.fill(128, 44);
  return bytes;
}

export class KeepAwakeManager {
  private enabled = false;
  private status: KeepAwakeStatus = 'off';
  private wakeLock: WakeLockSentinelLike | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioBlobUrl: string | null = null;
  private audioPlaying = false;
  private onStatusChange?: (status: KeepAwakeStatus) => void;

  private boundVisibility = () => {
    if (this.enabled && document.visibilityState === 'visible') {
      void this.engage();
    }
  };

  private boundGesture = () => {
    if (this.enabled) {
      void this.engage();
    }
  };

  constructor(onStatusChange?: (status: KeepAwakeStatus) => void) {
    this.onStatusChange = onStatusChange;
  }

  public getStatus(): KeepAwakeStatus {
    return this.status;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (enabled) {
      this.attachListeners();
      this.setStatus('waiting');
      void this.engage();
    } else {
      this.detachListeners();
      this.releaseAll();
      this.setStatus('off');
    }
  }

  public async engage(): Promise<boolean> {
    if (!this.enabled) return false;

    let wakeLockOk = false;
    let audioOk = false;

    // Layer 1: Native Screen Wake Lock API
    const wakeLockApi = 'wakeLock' in navigator ? navigator.wakeLock : undefined;
    if (wakeLockApi && (!this.wakeLock || this.wakeLock.released)) {
      try {
        const sentinel = await wakeLockApi.request('screen');
        this.wakeLock = sentinel;
        sentinel.addEventListener?.('release', () => {
          if (this.wakeLock === sentinel) {
            this.wakeLock = null;
          }
          if (this.enabled && !this.audioPlaying) {
            this.setStatus('waiting');
          }
        });
        wakeLockOk = true;
      } catch {
        // Ignore — e.g. Silk or battery saver may reject wakeLock; silent audio handles it
      }
    } else if (this.wakeLock && !this.wakeLock.released) {
      wakeLockOk = true;
    }

    // Layer 2: Unmuted silent-WAV HTML5 <audio> loop (keeps Amazon Silk / Echo Show awake)
    if (!this.audioPlaying) {
      audioOk = await this.startSilentAudio();
    } else {
      audioOk = true;
    }

    if (wakeLockOk || audioOk) {
      this.setStatus('active');
      if (audioOk) {
        this.removeGestureListeners();
      }
      return true;
    }

    this.setStatus('waiting');
    return false;
  }

  public dispose(): void {
    this.enabled = false;
    this.detachListeners();
    this.releaseAll();
    this.setStatus('off');
  }

  private async startSilentAudio(): Promise<boolean> {
    try {
      if (!this.audioEl) {
        const wav = buildSilentWavBytes(1, 8000);
        const copy = new Uint8Array(wav.byteLength);
        copy.set(wav);
        const blob = new Blob([copy.buffer], { type: 'audio/wav' });
        this.audioBlobUrl = URL.createObjectURL(blob);

        const audio = document.createElement('audio');
        audio.src = this.audioBlobUrl;
        audio.loop = true;
        audio.preload = 'auto';
        audio.volume = 0.01; // Must remain unmuted for Silk; waveform itself is pure 0-amplitude silence
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        audio.addEventListener('pause', () => {
          this.audioPlaying = false;
          if (this.enabled && !this.wakeLock) {
            this.setStatus('waiting');
            this.addGestureListeners();
          }
        });
        this.audioEl = audio;
      }

      const playPromise = this.audioEl.play();
      if (playPromise) {
        await playPromise;
      }
      this.audioPlaying = true;
      return true;
    } catch {
      // Autoplay blocked until the user's first tap — gesture listener will retry immediately
      this.audioPlaying = false;
      return false;
    }
  }

  private releaseAll(): void {
    if (this.wakeLock) {
      const sentinel = this.wakeLock;
      this.wakeLock = null;
      void sentinel.release().catch(() => {});
    }
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.removeAttribute('src');
        this.audioEl.load();
      } catch {
        // ignore
      }
      this.audioEl = null;
    }
    if (this.audioBlobUrl) {
      URL.revokeObjectURL(this.audioBlobUrl);
      this.audioBlobUrl = null;
    }
    this.audioPlaying = false;
  }

  private attachListeners(): void {
    document.addEventListener('visibilitychange', this.boundVisibility);
    this.addGestureListeners();
  }

  private detachListeners(): void {
    document.removeEventListener('visibilitychange', this.boundVisibility);
    this.removeGestureListeners();
  }

  private addGestureListeners(): void {
    window.addEventListener('pointerdown', this.boundGesture, { passive: true });
    window.addEventListener('touchstart', this.boundGesture, { passive: true });
    window.addEventListener('keydown', this.boundGesture, { passive: true });
  }

  private removeGestureListeners(): void {
    window.removeEventListener('pointerdown', this.boundGesture);
    window.removeEventListener('touchstart', this.boundGesture);
    window.removeEventListener('keydown', this.boundGesture);
  }

  private setStatus(next: KeepAwakeStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatusChange?.(next);
  }
}
