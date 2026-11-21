import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { NativeAudioPacket, PlaybackControlAction } from '@shared/types';

const MAGIC = Buffer.from('SVA1', 'ascii');
const HALF_FFT = 1024;
const FFT_SIZE = 2048;
const PACKET_SIZE = 8 + HALF_FFT + FFT_SIZE;

export class NativeAudioTapService {
  private proc: ChildProcess | null = null;
  private activeDeviceId: string | null = null;

  private getHelperPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'wasapi-tap.exe');
    }
    return path.join(__dirname, '..', '..', 'build', 'wasapi-tap.exe');
  }

  public start(
    deviceId: string,
    onFrame: (packet: NativeAudioPacket) => void
  ): boolean {
    const helperPath = this.getHelperPath();
    if (!fs.existsSync(helperPath)) {
      console.error('[audioTap] Missing helper binary at:', helperPath);
      return false;
    }

    const normalizedId = deviceId || 'default';
    if (this.proc && !this.proc.killed && this.activeDeviceId === normalizedId) {
      return true;
    }

    this.stop();

    const child = spawn(helperPath, ['--device', normalizedId], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.proc = child;
    this.activeDeviceId = normalizedId;

    let pending: Buffer = Buffer.alloc(0);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.proc !== child) return;

      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      let latestPacket: NativeAudioPacket | null = null;

      while (pending.length >= PACKET_SIZE) {
        const magicIdx = pending.indexOf(MAGIC);
        if (magicIdx === -1) {
          // Keep last 3 bytes in case magic header splits across chunks
          pending = pending.subarray(Math.max(0, pending.length - 3));
          break;
        }
        if (magicIdx > 0) {
          pending = pending.subarray(magicIdx);
        }
        if (pending.length < PACKET_SIZE) {
          break;
        }

        const sampleRate = pending.readUInt32LE(4);
        const freqBins = new Uint8Array(HALF_FFT);
        const timeBins = new Uint8Array(FFT_SIZE);
        pending.copy(freqBins, 0, 8, 8 + HALF_FFT);
        pending.copy(timeBins, 0, 8 + HALF_FFT, PACKET_SIZE);

        latestPacket = { sampleRate, freqBins, timeBins };
        pending = pending.subarray(PACKET_SIZE);
      }

      if (latestPacket) {
        onFrame(latestPacket);
      }
    });

    child.on('exit', () => {
      if (this.proc === child) {
        this.proc = null;
        this.activeDeviceId = null;
      }
    });

    child.on('error', (err) => {
      console.error('[audioTap] Failed to spawn wasapi-tap.exe:', err);
      if (this.proc === child) {
        this.proc = null;
        this.activeDeviceId = null;
      }
    });

    return true;
  }

  public stop(): void {
    const child = this.proc;
    this.proc = null;
    this.activeDeviceId = null;
    if (!child) return;

    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      if (!child.killed) child.kill();
    } catch {
      // ignore
    }
  }

  public sendMediaKey(action: PlaybackControlAction): Promise<boolean> {
    const helperPath = this.getHelperPath();
    if (!fs.existsSync(helperPath)) return Promise.resolve(false);

    const arg =
      action === 'playPause' ? 'playpause' : action === 'next' ? 'next' : 'prev';

    return new Promise((resolve) => {
      execFile(
        helperPath,
        ['--media', arg],
        { windowsHide: true, timeout: 2000 },
        (err) => resolve(!err)
      );
    });
  }
}
