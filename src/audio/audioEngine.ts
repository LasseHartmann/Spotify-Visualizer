import type { NativeAudioPacket, NativeAudioStatus } from '@shared/types';
import { isWebPlatform } from '@/platform/webBridge';
import { AudioDsp, type AudioFrame } from './dsp';

export type { AudioFrame } from './dsp';

export type AudioCaptureStatus = 'idle' | 'starting' | 'active' | 'error';

export interface AudioDiagnosticInfo {
  status: AudioCaptureStatus;
  deviceName: string | null;
  backend: 'wasapi' | 'chromium' | 'web' | null;
  hasSignal: boolean;
  errorMessage: string | null;
}

export const INITIAL_AUDIO_DIAGNOSTIC: AudioDiagnosticInfo = {
  status: 'idle',
  deviceName: null,
  backend: null,
  hasSignal: false,
  errorMessage: null,
};

const STARTUP_FALLBACK_TIMEOUT_MS = 3000;

/**
 * Streams real-time audio via:
 * - Electron primary: native Windows WASAPI loopback helper (auto-hunts active speakers/Bluetooth/7.1 headsets)
 * - Electron automatic fallback: Chromium built-in Windows loopback via getDisplayMedia (if wasapi-tap.exe is blocked by AV or fails)
 * - Web: browser Tab/Screen Share (getDisplayMedia) or Microphone (getUserMedia) AnalyserNode
 */
export class AudioEngine {
  private unsubNativeFrame: (() => void) | null = null;
  private unsubNativeStatus: (() => void) | null = null;
  private unsubNativeStopped: (() => void) | null = null;
  private latestNativePacket: NativeAudioPacket | null = null;
  private lastNativePacketAtMs = 0;

  // Built-in Electron Chromium loopback fallback resources
  private fallbackStream: MediaStream | null = null;
  private fallbackCtx: AudioContext | null = null;
  private fallbackAnalyser: AnalyserNode | null = null;
  private fallbackRafId = 0;
  private fallbackFreqBins = new Uint8Array(1024);
  private fallbackTimeBins = new Uint8Array(2048);
  private fallbackAttempted = false;
  private startupTimerId: number | null = null;
  private captureGen = 0;

  private dsp = new AudioDsp();
  private status: AudioCaptureStatus = 'idle';
  private deviceName: string | null = null;
  private backend: 'wasapi' | 'chromium' | 'web' | null = null;
  private errorMessage: string | null = null;
  private hasSignal = false;
  private lastSignalAtMs = 0;
  private enabled = true;

  private onStatusChange?: (status: AudioCaptureStatus) => void;
  private onDiagnosticChange?: (info: AudioDiagnosticInfo) => void;
  private lastEmittedDiagKey = '';

  constructor(
    onStatusChange?: (status: AudioCaptureStatus) => void,
    onDiagnosticChange?: (info: AudioDiagnosticInfo) => void
  ) {
    this.onStatusChange = onStatusChange;
    this.onDiagnosticChange = onDiagnosticChange;
  }

  public getStatus(): AudioCaptureStatus {
    return this.status;
  }

  public getDiagnosticInfo(): AudioDiagnosticInfo {
    return {
      status: this.status,
      deviceName: this.deviceName,
      backend: this.backend,
      hasSignal: this.hasSignal,
      errorMessage: this.errorMessage,
    };
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stopCapture();
    } else if (!isWebPlatform() && this.status !== 'active' && this.status !== 'starting') {
      void this.startCapture('default');
    }
  }

  public async startCapture(source = 'default'): Promise<boolean> {
    if (!this.enabled) {
      this.enabled = true;
    }
    if (source === 'default' && (this.status === 'starting' || this.status === 'active')) {
      return true;
    }

    this.stopCapture();
    const gen = ++this.captureGen;
    this.fallbackAttempted = false;
    this.errorMessage = null;
    this.deviceName = null;
    this.backend = isWebPlatform() ? 'web' : 'wasapi';
    this.hasSignal = false;
    this.lastSignalAtMs = 0;
    this.setStatus('starting');

    try {
      this.latestNativePacket = null;
      this.lastNativePacketAtMs = 0;
      this.dsp.reset();

      this.unsubNativeFrame = window.visualizer.audio.onFrame((packet) => {
        if (this.captureGen !== gen) return;
        this.latestNativePacket = packet;
        this.lastNativePacketAtMs = performance.now();
        this.clearStartupTimer();
        if (this.status !== 'active') {
          this.errorMessage = null;
          this.setStatus('active');
        }
      });

      if (window.visualizer.audio.onStatus && !isWebPlatform()) {
        this.unsubNativeStatus = window.visualizer.audio.onStatus((st: NativeAudioStatus) => {
          if (this.captureGen !== gen) return;
          this.handleNativeStatus(st, gen);
        });
      }

      if (window.visualizer.audio.onStopped) {
        this.unsubNativeStopped = window.visualizer.audio.onStopped(() => {
          if (this.captureGen !== gen) return;
          this.stopCapture();
        });
      }

      const ok = await window.visualizer.audio.startTap(source);
      if (this.captureGen !== gen) return false;

      if (!ok) {
        if (!isWebPlatform()) {
          return await this.tryElectronLoopbackFallback(
            gen,
            this.errorMessage ?? 'Native audio helper could not start'
          );
        }
        this.cleanupListeners();
        this.setStatus('error');
        return false;
      }

      if (isWebPlatform()) {
        this.deviceName = source === 'mic' ? 'Microphone / Line-In' : 'Browser Tab / Screen';
        this.setStatus('active');
        return true;
      }

      // On Electron, wait up to 3s for real SVA1 frames from wasapi-tap.exe;
      // if none arrive (e.g. helper silently blocked or stalled), auto-switch to built-in Chromium loopback.
      this.clearStartupTimer();
      this.startupTimerId = window.setTimeout(() => {
        if (this.captureGen !== gen) return;
        if (this.lastNativePacketAtMs === 0) {
          void this.tryElectronLoopbackFallback(
            gen,
            this.errorMessage ?? 'Audio helper did not respond'
          );
        }
      }, STARTUP_FALLBACK_TIMEOUT_MS);

      return true;
    } catch (err) {
      if (this.captureGen !== gen) return false;
      const msg = err instanceof Error ? err.message : 'Audio capture failed';
      if (!isWebPlatform()) {
        return await this.tryElectronLoopbackFallback(gen, msg);
      }
      this.errorMessage = msg;
      this.cleanupListeners();
      this.setStatus('error');
      return false;
    }
  }

  private handleNativeStatus(st: NativeAudioStatus, gen: number): void {
    if (st.state === 'active') {
      if (st.deviceName) this.deviceName = st.deviceName;
      this.backend = 'wasapi';
      this.errorMessage = null;
      this.emitDiagnostics();
      return;
    }

    if (st.state === 'silent_apo') {
      // WASAPI opened the endpoint cleanly, yet Windows driver/APO is outputting pure zeros while audio IS playing!
      void this.tryElectronLoopbackFallback(
        gen,
        st.message ?? 'Windows audio enhancements blocked loopback'
      );
      return;
    }

    if (st.state === 'error') {
      this.errorMessage = st.message ?? 'Windows audio capture error';
      this.emitDiagnostics();
      // If helper crashed, was blocked by antivirus, or couldn't initialize any endpoint, fall back seamlessly
      void this.tryElectronLoopbackFallback(gen, this.errorMessage);
    }
  }

  private async tryElectronLoopbackFallback(
    gen: number,
    wasapiReason: string
  ): Promise<boolean> {
    if (this.captureGen !== gen) return false;
    if (this.fallbackAttempted) {
      this.errorMessage = wasapiReason;
      this.setStatus('error');
      return false;
    }
    this.fallbackAttempted = true;
    this.clearStartupTimer();

    // Stop native helper so only one audio backend owns latestNativePacket
    this.cleanupNativeTap();

    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.errorMessage = wasapiReason;
      this.setStatus('error');
      return false;
    }

    try {
      let mediaStream: MediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1, frameRate: 1 },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      }

      if (this.captureGen !== gen) {
        mediaStream.getTracks().forEach((t) => t.stop());
        return false;
      }

      const audioTracks = mediaStream.getAudioTracks();
      if (audioTracks.length === 0) {
        mediaStream.getTracks().forEach((t) => t.stop());
        this.errorMessage = wasapiReason;
        this.setStatus('error');
        return false;
      }

      // Stop video tracks right away so Windows doesn't show a screen-capture border
      for (const vTrack of mediaStream.getVideoTracks()) {
        try {
          vTrack.stop();
        } catch {
          // ignore
        }
      }

      const audioOnlyStream = new MediaStream(audioTracks);
      const AudioCtxCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtxCtor();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (this.captureGen !== gen) {
        mediaStream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        return false;
      }

      const sourceNode = ctx.createMediaStreamSource(audioOnlyStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      sourceNode.connect(analyser);

      this.fallbackStream = mediaStream;
      this.fallbackCtx = ctx;
      this.fallbackAnalyser = analyser;
      this.fallbackFreqBins = new Uint8Array(analyser.frequencyBinCount);
      this.fallbackTimeBins = new Uint8Array(analyser.fftSize);

      for (const track of audioTracks) {
        track.addEventListener(
          'ended',
          () => {
            if (this.captureGen !== gen) return;
            this.stopFallback();
            this.errorMessage = 'Windows loopback stream ended';
            this.setStatus('error');
          },
          { once: true }
        );
      }

      this.backend = 'chromium';
      this.deviceName = 'Windows System Audio (Built-in Fallback)';
      this.errorMessage = null;
      this.setStatus('active');

      const pump = () => {
        if (this.captureGen !== gen || !this.fallbackAnalyser || !this.fallbackCtx) return;
        this.fallbackRafId = requestAnimationFrame(pump);

        this.fallbackAnalyser.getByteFrequencyData(this.fallbackFreqBins);
        this.fallbackAnalyser.getByteTimeDomainData(this.fallbackTimeBins);

        this.latestNativePacket = {
          sampleRate: this.fallbackCtx.sampleRate || 48000,
          freqBins: this.fallbackFreqBins,
          timeBins: this.fallbackTimeBins,
        };
        this.lastNativePacketAtMs = performance.now();
      };

      this.fallbackRafId = requestAnimationFrame(pump);
      return true;
    } catch {
      if (this.captureGen !== gen) return false;
      this.stopFallback();
      this.errorMessage = wasapiReason;
      this.setStatus('error');
      return false;
    }
  }

  public stopCapture(): void {
    this.captureGen++;
    this.clearStartupTimer();
    this.cleanupNativeTap();
    this.stopFallback();
    this.latestNativePacket = null;
    this.lastNativePacketAtMs = 0;
    this.hasSignal = false;
    this.lastSignalAtMs = 0;

    if (this.status !== 'idle') {
      this.setStatus('idle');
    } else {
      this.emitDiagnostics();
    }
  }

  public update(dtSec: number, nowMs: number, isSpotifyPlaying: boolean): AudioFrame {
    if (
      this.enabled &&
      this.latestNativePacket &&
      nowMs - this.lastNativePacketAtMs < 600
    ) {
      const pkt = this.latestNativePacket;
      const frame = this.dsp.processLive(
        pkt.freqBins,
        pkt.timeBins,
        pkt.sampleRate || 48000,
        2048,
        dtSec,
        nowMs
      );
      if (frame.rms > 0.0006 || frame.audioActive > 0.15) {
        this.lastSignalAtMs = nowMs;
      }
      const nextHasSignal = this.lastSignalAtMs > 0 && nowMs - this.lastSignalAtMs < 1800;
      if (nextHasSignal !== this.hasSignal) {
        this.hasSignal = nextHasSignal;
        this.emitDiagnostics();
      }
      return frame;
    }

    if (this.hasSignal) {
      this.hasSignal = false;
      this.emitDiagnostics();
    }
    return this.dsp.processAmbient(dtSec, nowMs, isSpotifyPlaying);
  }

  private clearStartupTimer(): void {
    if (this.startupTimerId !== null) {
      window.clearTimeout(this.startupTimerId);
      this.startupTimerId = null;
    }
  }

  private cleanupListeners(): void {
    if (this.unsubNativeFrame) {
      this.unsubNativeFrame();
      this.unsubNativeFrame = null;
    }
    if (this.unsubNativeStatus) {
      this.unsubNativeStatus();
      this.unsubNativeStatus = null;
    }
    if (this.unsubNativeStopped) {
      this.unsubNativeStopped();
      this.unsubNativeStopped = null;
    }
  }

  private cleanupNativeTap(): void {
    this.cleanupListeners();
    void window.visualizer.audio.stopTap().catch(() => {});
  }

  private stopFallback(): void {
    if (this.fallbackRafId) {
      cancelAnimationFrame(this.fallbackRafId);
      this.fallbackRafId = 0;
    }
    if (this.fallbackStream) {
      this.fallbackStream.getTracks().forEach((t) => t.stop());
      this.fallbackStream = null;
    }
    if (this.fallbackCtx) {
      void this.fallbackCtx.close().catch(() => {});
      this.fallbackCtx = null;
    }
    this.fallbackAnalyser = null;
  }

  private setStatus(next: AudioCaptureStatus): void {
    this.status = next;
    this.onStatusChange?.(next);
    this.emitDiagnostics();
  }

  private emitDiagnostics(): void {
    if (!this.onDiagnosticChange) return;
    const key = `${this.status}|${this.deviceName ?? ''}|${this.backend ?? ''}|${this.hasSignal ? 1 : 0}|${this.errorMessage ?? ''}`;
    if (key === this.lastEmittedDiagKey) return;
    this.lastEmittedDiagKey = key;
    this.onDiagnosticChange(this.getDiagnosticInfo());
  }
}
