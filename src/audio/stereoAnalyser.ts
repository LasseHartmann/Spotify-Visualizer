import type { NativeAudioPacket } from '@shared/types';

const STEREO_BINS = 256;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Wraps a Web Audio MediaStream into a full-detail stereo NativeAudioPacket reader
 * (shared by both the browser PWA audio bridge and Electron's Chromium loopback fallback).
 */
export class StereoStreamAnalyser {
  private ctx: AudioContext;
  private combined: AnalyserNode;
  private left: AnalyserNode | null = null;
  private right: AnalyserNode | null = null;

  private freqBins: Uint8Array<ArrayBuffer>;
  private timeBins: Uint8Array<ArrayBuffer>;
  private rawLeftFreq: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  private rawRightFreq: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  private rawLeftTime: Uint8Array<ArrayBuffer> = new Uint8Array(2048);
  private rawRightTime: Uint8Array<ArrayBuffer> = new Uint8Array(2048);

  private leftFreqBins = new Uint8Array(STEREO_BINS);
  private rightFreqBins = new Uint8Array(STEREO_BINS);
  private leftTimeBins = new Uint8Array(STEREO_BINS).fill(128);
  private rightTimeBins = new Uint8Array(STEREO_BINS).fill(128);

  private smoothWidth = 0;
  private smoothBalance = 0;

  constructor(ctx: AudioContext, audioOnlyStream: MediaStream) {
    this.ctx = ctx;
    const sourceNode = ctx.createMediaStreamSource(audioOnlyStream);

    const combined = ctx.createAnalyser();
    combined.fftSize = 2048;
    combined.smoothingTimeConstant = 0;
    sourceNode.connect(combined);
    this.combined = combined;
    this.freqBins = new Uint8Array(combined.frequencyBinCount);
    this.timeBins = new Uint8Array(combined.fftSize);

    const track = audioOnlyStream.getAudioTracks()[0];
    const reportedChannels = track?.getSettings?.().channelCount;
    const isDefinitelyMono = reportedChannels === 1;

    if (!isDefinitelyMono && typeof ctx.createChannelSplitter === 'function') {
      const splitter = ctx.createChannelSplitter(2);
      const analyserL = ctx.createAnalyser();
      const analyserR = ctx.createAnalyser();
      analyserL.fftSize = 2048;
      analyserL.smoothingTimeConstant = 0;
      analyserR.fftSize = 2048;
      analyserR.smoothingTimeConstant = 0;

      sourceNode.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      this.left = analyserL;
      this.right = analyserR;
      this.rawLeftFreq = new Uint8Array(analyserL.frequencyBinCount);
      this.rawRightFreq = new Uint8Array(analyserR.frequencyBinCount);
      this.rawLeftTime = new Uint8Array(analyserL.fftSize);
      this.rawRightTime = new Uint8Array(analyserR.fftSize);
    }
  }

  public readPacket(): NativeAudioPacket {
    this.combined.getByteFrequencyData(this.freqBins);
    this.combined.getByteTimeDomainData(this.timeBins);

    const sampleRate = this.ctx.sampleRate || 48000;
    const binHz = sampleRate / this.combined.fftSize;
    const maxBin = Math.min(
      this.freqBins.length - 1,
      Math.max(8, Math.floor(16000 / Math.max(1, binHz)))
    );

    if (this.left && this.right) {
      this.left.getByteFrequencyData(this.rawLeftFreq);
      this.right.getByteFrequencyData(this.rawRightFreq);
      this.left.getByteTimeDomainData(this.rawLeftTime);
      this.right.getByteTimeDomainData(this.rawRightTime);

      let sumL2 = 0;
      let sumR2 = 0;
      let sumMid2 = 0;
      let sumSide2 = 0;
      const len = Math.min(this.rawLeftTime.length, this.rawRightTime.length);
      for (let i = 0; i < len; i += 2) {
        const sL = (this.rawLeftTime[i] - 128) / 128;
        const sR = (this.rawRightTime[i] - 128) / 128;
        const mid = 0.5 * (sL + sR);
        const side = 0.5 * (sL - sR);
        sumL2 += sL * sL;
        sumR2 += sR * sR;
        sumMid2 += mid * mid;
        sumSide2 += side * side;
      }

      const n = Math.max(1, len / 2);
      const rmsL = Math.sqrt(sumL2 / n);
      const rmsR = Math.sqrt(sumR2 / n);
      const rmsMid = Math.sqrt(sumMid2 / n);
      const rmsSide = Math.sqrt(sumSide2 / n);

      // Guard against mono streams fed into a 2ch splitter where right channel is completely silent
      const rightDeadMono = rmsL > 0.002 && rmsR < 1e-5;
      if (rightDeadMono) {
        this.fillMonoMirror(maxBin);
      } else {
        const targetWidth =
          rmsMid + rmsSide > 0.0005
            ? clamp((rmsSide / (rmsMid + rmsSide * 0.45 + 1e-6)) * 1.45, 0, 1)
            : 0;
        const targetBalance =
          rmsL + rmsR > 0.0005
            ? clamp((rmsR - rmsL) / (rmsL + rmsR + 1e-6), -1, 1)
            : 0;
        this.smoothWidth = this.smoothWidth * 0.72 + targetWidth * 0.28;
        this.smoothBalance = this.smoothBalance * 0.72 + targetBalance * 0.28;

        for (let x = 0; x < STEREO_BINS; x++) {
          const u = x / (STEREO_BINS - 1);
          const logIdx = clamp(Math.floor(Math.pow(Math.max(2, maxBin), u)), 1, maxBin);
          this.leftFreqBins[x] = this.rawLeftFreq[logIdx];
          this.rightFreqBins[x] = this.rawRightFreq[logIdx];

          const tIdx = Math.min(len - 1, Math.floor(u * 1024));
          this.leftTimeBins[x] = this.rawLeftTime[tIdx];
          this.rightTimeBins[x] = this.rawRightTime[tIdx];
        }
      }
    } else {
      this.fillMonoMirror(maxBin);
    }

    return {
      sampleRate,
      freqBins: this.freqBins,
      timeBins: this.timeBins,
      leftFreqBins: this.leftFreqBins,
      rightFreqBins: this.rightFreqBins,
      leftTimeBins: this.leftTimeBins,
      rightTimeBins: this.rightTimeBins,
      stereoWidth: this.smoothWidth,
      stereoBalance: this.smoothBalance,
    };
  }

  private fillMonoMirror(maxBin: number): void {
    this.smoothWidth *= 0.8;
    this.smoothBalance *= 0.8;
    for (let x = 0; x < STEREO_BINS; x++) {
      const u = x / (STEREO_BINS - 1);
      const logIdx = clamp(Math.floor(Math.pow(Math.max(2, maxBin), u)), 1, maxBin);
      const f = this.freqBins[logIdx];
      this.leftFreqBins[x] = f;
      this.rightFreqBins[x] = f;
      const tIdx = Math.min(this.timeBins.length - 1, Math.floor(u * 1024));
      const w = this.timeBins[tIdx];
      this.leftTimeBins[x] = w;
      this.rightTimeBins[x] = w;
    }
  }
}
