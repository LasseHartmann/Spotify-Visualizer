import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  NativeAudioPacket,
  NativeAudioStatus,
  PlaybackControlAction,
} from '@shared/types';

const MAGIC = Buffer.from('SVA1', 'ascii');
const HALF_FFT = 1024;
const FFT_SIZE = 2048;
const PACKET_SIZE = 8 + HALF_FFT + FFT_SIZE;

export class NativeAudioTapService {
  private proc: ChildProcess | null = null;
  private activeDeviceId: string | null = null;
  private isStopping = false;

  private getHelperPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'wasapi-tap.exe');
    }
    return path.join(__dirname, '..', '..', 'build', 'wasapi-tap.exe');
  }

  public start(
    deviceId: string,
    onFrame: (packet: NativeAudioPacket) => void,
    onStatus?: (status: NativeAudioStatus) => void
  ): boolean {
    const helperPath = this.getHelperPath();
    if (!fs.existsSync(helperPath)) {
      const msg = 'Audio helper missing (may have been blocked by antivirus)';
      console.error('[audioTap] Missing helper binary at:', helperPath);
      onStatus?.({ state: 'error', backend: 'wasapi', message: msg });
      return false;
    }

    const normalizedId = deviceId || 'default';
    if (this.proc && !this.proc.killed && this.activeDeviceId === normalizedId) {
      return true;
    }

    this.stop();
    this.isStopping = false;

    let child: ChildProcess;
    try {
      child = spawn(helperPath, ['--device', normalizedId], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[audioTap] Synchronous spawn failure:', detail);
      onStatus?.({
        state: 'error',
        backend: 'wasapi',
        message: `Could not launch audio helper (${detail})`,
      });
      return false;
    }

    this.proc = child;
    this.activeDeviceId = normalizedId;
    onStatus?.({ state: 'starting', backend: 'wasapi' });

    let pending: Buffer = Buffer.alloc(0);
    let stderrPending = '';

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

    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.proc !== child) return;
      stderrPending += chunk.toString('utf8');
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('WASAPI_OPEN:')) {
          const payload = line.slice('WASAPI_OPEN:'.length);
          const sepIdx = payload.indexOf('|');
          const deviceName = (sepIdx >= 0 ? payload.slice(0, sepIdx) : payload).trim();
          const detail = sepIdx >= 0 ? payload.slice(sepIdx + 1).trim() : undefined;
          onStatus?.({
            state: 'active',
            backend: 'wasapi',
            deviceName: deviceName || 'Windows Audio',
            message: detail,
          });
        } else if (line.startsWith('WASAPI_SWITCH:')) {
          const deviceName = line.slice('WASAPI_SWITCH:'.length).trim();
          onStatus?.({
            state: 'active',
            backend: 'wasapi',
            deviceName: deviceName || 'Windows Audio',
          });
        } else if (line.startsWith('WASAPI_SILENT_APO:')) {
          const deviceName = line.slice('WASAPI_SILENT_APO:'.length).trim();
          console.warn('[audioTap] Silent APO detected on:', deviceName);
          onStatus?.({
            state: 'silent_apo',
            backend: 'wasapi',
            deviceName: deviceName || 'Windows Audio',
            message:
              'Windows audio driver/enhancements returned silence — trying built-in fallback',
          });
        } else if (line.startsWith('WASAPI_ERR:')) {
          const message = line.slice('WASAPI_ERR:'.length).trim();
          console.warn('[audioTap] Helper warning:', message);
          onStatus?.({
            state: 'error',
            backend: 'wasapi',
            message: message || 'WASAPI loopback error',
          });
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (this.proc === child) {
        this.proc = null;
        this.activeDeviceId = null;
        if (!this.isStopping) {
          console.warn(`[audioTap] wasapi-tap.exe exited unexpectedly (code=${code}, signal=${signal})`);
          onStatus?.({
            state: 'error',
            backend: 'wasapi',
            message: `Audio helper stopped (exit ${code ?? signal ?? 'unknown'})`,
          });
        }
      }
    });

    child.on('error', (err) => {
      console.error('[audioTap] Failed to spawn wasapi-tap.exe:', err);
      if (this.proc === child) {
        this.proc = null;
        this.activeDeviceId = null;
        if (!this.isStopping) {
          onStatus?.({
            state: 'error',
            backend: 'wasapi',
            message: `Audio helper blocked or failed to launch (${err.message})`,
          });
        }
      }
    });

    return true;
  }

  public stop(): void {
    const child = this.proc;
    this.isStopping = true;
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
