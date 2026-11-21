import type { NativeAudioPacket } from '@shared/types';
import { isWebPlatform } from '@/platform/webBridge';
import { AudioDsp, type AudioFrame } from './dsp';

export type { AudioFrame } from './dsp';

export type AudioCaptureStatus = 'idle' | 'starting' | 'active' | 'error';

/**
 * Streams real-time audio via either:
 * - Electron: native Windows WASAPI loopback helper (2ch / 5.1 / 7.1 headsets & speakers)
 * - Web: browser Tab/Screen Share (getDisplayMedia) or Microphone (getUserMedia) AnalyserNode
 */
export class AudioEngine {
  private unsubNativeFrame: (() => void) | null = null;
  private unsubNativeStopped: (() => void) | null = null;
  private latestNativePacket: NativeAudioPacket | null = null;
  private lastNativePacketAtMs = 0;

  private dsp = new AudioDsp();
  private status: AudioCaptureStatus = 'idle';
  private enabled = true;
  private onStatusChange?: (status: AudioCaptureStatus) => void;

  constructor(onStatusChange?: (status: AudioCaptureStatus) => void) {
    this.onStatusChange = onStatusChange;
  }

  public getStatus(): AudioCaptureStatus {
    return this.status;
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
    this.setStatus('starting');

    try {
      this.latestNativePacket = null;
      this.lastNativePacketAtMs = 0;
      this.dsp.reset();

      this.unsubNativeFrame = window.visualizer.audio.onFrame((packet) => {
        this.latestNativePacket = packet;
        this.lastNativePacketAtMs = performance.now();
      });

      if (window.visualizer.audio.onStopped) {
        this.unsubNativeStopped = window.visualizer.audio.onStopped(() => {
          this.stopCapture();
        });
      }

      const ok = await window.visualizer.audio.startTap(source);
      if (!ok) {
        this.stopCapture();
        this.setStatus('error');
        return false;
      }

      this.setStatus('active');
      return true;
    } catch {
      this.stopCapture();
      this.setStatus('error');
      return false;
    }
  }

  public stopCapture(): void {
    if (this.unsubNativeFrame) {
      this.unsubNativeFrame();
      this.unsubNativeFrame = null;
    }
    if (this.unsubNativeStopped) {
      this.unsubNativeStopped();
      this.unsubNativeStopped = null;
    }
    this.latestNativePacket = null;
    this.lastNativePacketAtMs = 0;
    void window.visualizer.audio.stopTap().catch(() => {});

    if (this.status !== 'idle') {
      this.setStatus('idle');
    }
  }

  public update(dtSec: number, nowMs: number, isSpotifyPlaying: boolean): AudioFrame {
    if (
      this.enabled &&
      this.latestNativePacket &&
      nowMs - this.lastNativePacketAtMs < 600
    ) {
      const pkt = this.latestNativePacket;
      return this.dsp.processLive(
        pkt.freqBins,
        pkt.timeBins,
        pkt.sampleRate || 48000,
        2048,
        dtSec,
        nowMs
      );
    }

    return this.dsp.processAmbient(dtSec, nowMs, isSpotifyPlaying);
  }

  private setStatus(next: AudioCaptureStatus): void {
    this.status = next;
    this.onStatusChange?.(next);
  }
}
