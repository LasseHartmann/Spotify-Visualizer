export const AUDIO_TEX_WIDTH = 256;
export const AUDIO_TEX_HEIGHT = 10;
export const HISTORY_FRAMES = 64;
export const CHROMA_BINS = 12;
export const KICK_WAVE_SLOTS = 6;
export const SNARE_WAVE_SLOTS = 4;

export interface StereoPacketExtras {
  leftFreqBins?: Uint8Array;
  rightFreqBins?: Uint8Array;
  leftTimeBins?: Uint8Array;
  rightTimeBins?: Uint8Array;
  stereoWidth?: number;
  stereoBalance?: number;
}

export interface AudioFrame {
  // 7 precision frequency bands + combined treble
  subBass: number;
  bass: number;
  lowMid: number;
  vocal: number;
  presence: number;
  brilliance: number;
  air: number;
  treble: number;
  energy: number;

  // 4 independent percussion / onset detectors
  kick: number;
  snare: number;
  hiHat: number;
  transient: number;

  // Song dynamics, timbre, and stereo field
  drop: number;
  autoPulse: number;
  colorIndex: number;
  audioActive: number;
  rms: number;
  crest: number;
  centroid: number;
  tonality: number;
  stereoWidth: number;
  stereoBalance: number;

  // Structured harmonic & shockwave buffers
  chroma: Float32Array; // 12 pitch classes (C, C#, D, ..., B), 0..1
  kickWaves: Float32Array; // 6 traveling ring ages (0..1 active, >= 1 inactive)
  snareWaves: Float32Array; // 4 traveling snare ring ages (0..1 active, >= 1 inactive)

  eqBars: [number, number, number, number, number];
  /**
   * 256 x 10 R8 audio data texture:
   * Row 0: AGC log FFT
   * Row 1: Gravity peak-hold FFT
   * Row 2: Per-bin positive spectral flux
   * Row 3: Combined PCM waveform
   * Row 4: Stereo Left FFT
   * Row 5: Stereo Right FFT
   * Row 6: Stereo Left waveform
   * Row 7: Stereo Right waveform
   * Row 8: Low-passed bass waveform
   * Row 9: High-passed treble/air waveform
   */
  textureData: Uint8Array;
  /** 256 x 4 RGBA8 single frame row for the 256x64 rolling GPU history ring buffer */
  historyRow: Uint8Array;
}

const FLUX_HISTORY = 38;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function expSmooth(
  current: number,
  target: number,
  dt: number,
  attackRate: number,
  releaseRate: number
): number {
  const rate = target > current ? attackRate : releaseRate;
  const k = 1 - Math.exp(-dt * rate);
  return current + (target - current) * k;
}

/**
 * Full-detail real-time music DSP engine:
 * - Adaptive Auto-Gain Control (AGC) across laptop, headphone, and desktop volume levels
 * - 7 precision frequency bands (Sub-Bass -> Air) + 4 independent onset detectors
 * - 12-note Chromagram (pitch-class harmony), Spectral Centroid, Tonality & Crest
 * - True Stereo L/R spectrum, waveforms, width & balance
 * - Per-bin gravity peak-hold, per-bin attack flux, band-split waveforms, and shockwave rings
 */
export class AudioDsp {
  private prevFreq = new Float32Array(512);
  private prevLogSpec = new Float32Array(AUDIO_TEX_WIDTH);
  private peakHold = new Float32Array(AUDIO_TEX_WIDTH);
  private peakVel = new Float32Array(AUDIO_TEX_WIDTH);
  private binFluxSmooth = new Float32Array(AUDIO_TEX_WIDTH);
  private chromaRaw = new Float32Array(CHROMA_BINS);

  private kickFluxHist = new Float32Array(FLUX_HISTORY);
  private snareFluxHist = new Float32Array(FLUX_HISTORY);
  private hiHatFluxHist = new Float32Array(FLUX_HISTORY);
  private broadbandFluxHist = new Float32Array(FLUX_HISTORY);
  private histCursor = 0;

  // Cached bin -> pitch-class mapping for the current sampleRate/fftSize
  private cachedChromaRate = 0;
  private cachedChromaFft = 0;
  private chromaBinStart = 1;
  private chromaBinEnd = 1;
  private chromaBinPitchClass = new Int8Array(1024);

  // Adaptive auto-gain envelopes
  private agcBandPeak = 0.16;
  private agcWavePeak = 0.12;

  // Short-term vs long-term raw energy envelopes for volume-invariant drop detection
  private shortEnergy = 0;
  private longEnergy = 0.08;

  // Rolling beat density tracker for automatic pulse self-regulation
  private kickActivity = 0.14;

  // Onset refractory timestamps & shockwave cursors
  private lastKickMs = -1000;
  private lastSnareMs = -1000;
  private lastHiHatMs = -1000;
  private lastTransientMs = -1000;
  private lastColorStepMs = -10000;
  private lastAmbientKickMs = -1000;
  private kickWaveCursor = 0;
  private snareWaveCursor = 0;
  private kicksSinceStep = 0;
  private targetColorIndex = 0;
  private currentColorIndex = 0;

  // Reusable scratch buffers for zero-GC waveform band splitting
  private waveCentered = new Float32Array(AUDIO_TEX_WIDTH);
  private waveLowPass = new Float32Array(AUDIO_TEX_WIDTH);

  public readonly frame: AudioFrame = {
    subBass: 0,
    bass: 0,
    lowMid: 0,
    vocal: 0,
    presence: 0,
    brilliance: 0,
    air: 0,
    treble: 0,
    energy: 0,
    kick: 0,
    snare: 0,
    hiHat: 0,
    transient: 0,
    drop: 0,
    autoPulse: 1.0,
    colorIndex: 0,
    audioActive: 0,
    rms: 0,
    crest: 0,
    centroid: 0.35,
    tonality: 0.5,
    stereoWidth: 0,
    stereoBalance: 0,
    chroma: new Float32Array(CHROMA_BINS),
    kickWaves: new Float32Array(KICK_WAVE_SLOTS).fill(2),
    snareWaves: new Float32Array(SNARE_WAVE_SLOTS).fill(2),
    eqBars: [0, 0, 0, 0, 0],
    textureData: new Uint8Array(AUDIO_TEX_WIDTH * AUDIO_TEX_HEIGHT),
    historyRow: new Uint8Array(AUDIO_TEX_WIDTH * 4),
  };

  constructor() {
    this.initNeutralRows();
  }

  private initNeutralRows(): void {
    const tex = this.frame.textureData;
    tex.fill(0);
    // Wave rows (3: sum, 6: L, 7: R, 8: bass, 9: treble) sit at neutral 128
    const waveRows = [3, 6, 7, 8, 9];
    for (const r of waveRows) {
      tex.fill(128, r * AUDIO_TEX_WIDTH, (r + 1) * AUDIO_TEX_WIDTH);
    }
    const hist = this.frame.historyRow;
    for (let x = 0; x < AUDIO_TEX_WIDTH; x++) {
      hist[x * 4 + 0] = 0;
      hist[x * 4 + 1] = 128;
      hist[x * 4 + 2] = 0;
      hist[x * 4 + 3] = 128;
    }
  }

  public reset(): void {
    this.prevFreq.fill(0);
    this.prevLogSpec.fill(0);
    this.peakHold.fill(0);
    this.peakVel.fill(0);
    this.binFluxSmooth.fill(0);
    this.kickFluxHist.fill(0);
    this.snareFluxHist.fill(0);
    this.hiHatFluxHist.fill(0);
    this.broadbandFluxHist.fill(0);
    this.histCursor = 0;
    this.agcBandPeak = 0.16;
    this.agcWavePeak = 0.12;
    this.shortEnergy = 0;
    this.longEnergy = 0.08;
    this.kickActivity = 0.14;
    this.kicksSinceStep = 0;
    this.frame.chroma.fill(0);
    this.frame.kickWaves.fill(2);
    this.frame.snareWaves.fill(2);
    this.initNeutralRows();
  }

  private ensureChromaTable(sampleRate: number, fftSize: number, maxBins: number): void {
    if (this.cachedChromaRate === sampleRate && this.cachedChromaFft === fftSize) return;
    this.cachedChromaRate = sampleRate;
    this.cachedChromaFft = fftSize;
    if (this.chromaBinPitchClass.length < maxBins) {
      this.chromaBinPitchClass = new Int8Array(maxBins);
    }
    const binHz = sampleRate / fftSize;
    this.chromaBinStart = Math.max(1, Math.floor(65.41 / binHz)); // C2
    this.chromaBinEnd = Math.min(maxBins - 1, Math.ceil(4186.0 / binHz)); // C8
    for (let i = this.chromaBinStart; i <= this.chromaBinEnd; i++) {
      const freq = i * binHz;
      const midi = 69 + 12 * Math.log2(freq / 440);
      this.chromaBinPitchClass[i] = ((Math.round(midi) % 12) + 12) % 12;
    }
  }

  private advanceShockwaves(dt: number): void {
    const f = this.frame;
    for (let i = 0; i < KICK_WAVE_SLOTS; i++) {
      if (f.kickWaves[i] < 1.5) {
        f.kickWaves[i] = Math.min(2.0, f.kickWaves[i] + dt * 0.78);
      }
    }
    for (let i = 0; i < SNARE_WAVE_SLOTS; i++) {
      if (f.snareWaves[i] < 1.5) {
        f.snareWaves[i] = Math.min(2.0, f.snareWaves[i] + dt * 1.35);
      }
    }
  }

  private emitKickWave(): void {
    this.frame.kickWaves[this.kickWaveCursor] = 0.001;
    this.kickWaveCursor = (this.kickWaveCursor + 1) % KICK_WAVE_SLOTS;
  }

  private emitSnareWave(): void {
    this.frame.snareWaves[this.snareWaveCursor] = 0.001;
    this.snareWaveCursor = (this.snareWaveCursor + 1) % SNARE_WAVE_SLOTS;
  }

  public processLive(
    freqBins: Uint8Array,
    timeBins: Uint8Array,
    sampleRate: number,
    fftSize: number,
    dtSec: number,
    nowMs: number,
    stereo?: StereoPacketExtras
  ): AudioFrame {
    const dt = clamp(dtSec, 0.001, 0.05);
    const f = this.frame;
    const binHz = sampleRate / fftSize;

    this.advanceShockwaves(dt);

    // 1. Measure real PCM RMS, peak amplitude & crest factor
    let sumSq = 0;
    let wavePeak = 0;
    const waveLen = timeBins.length;
    for (let i = 0; i < waveLen; i++) {
      const s = (timeBins[i] - 128) / 128;
      sumSq += s * s;
      const absS = Math.abs(s);
      if (absS > wavePeak) wavePeak = absS;
    }
    const rms = waveLen > 0 ? Math.sqrt(sumSq / waveLen) : 0;
    f.rms = rms;

    // Raw frequency band averages (0..1) across 7 precision bands
    const rawBand = (minHz: number, maxHz: number): number => {
      const start = Math.max(1, Math.floor(minHz / binHz));
      const end = Math.min(freqBins.length - 1, Math.ceil(maxHz / binHz));
      if (end < start) return 0;
      let sum = 0;
      for (let i = start; i <= end; i++) {
        sum += freqBins[i] / 255;
      }
      return sum / (end - start + 1);
    };

    const rawSub = rawBand(24, 65);
    const rawBass = rawBand(60, 200);
    const rawLowMid = rawBand(200, 520);
    const rawVocal = rawBand(520, 2400);
    const rawPresence = rawBand(2400, 6000);
    const rawBrilliance = rawBand(6000, 11000);
    const rawAir = rawBand(11000, 17500);
    const rawTreble = rawPresence * 0.44 + rawBrilliance * 0.36 + rawAir * 0.2;

    const rawComposite =
      rawSub * 0.20 +
      rawBass * 0.28 +
      rawLowMid * 0.16 +
      rawVocal * 0.18 +
      rawPresence * 0.09 +
      rawBrilliance * 0.06 +
      rawAir * 0.03;

    const hasSignal = rms > 0.0006 || rawComposite > 0.006;

    // 2. Adaptive Auto-Gain Control (AGC)
    if (hasSignal) {
      const peakSample = Math.max(
        rawBass,
        rawSub * 0.95,
        rawVocal * 0.9,
        rawPresence * 0.85,
        rawComposite * 1.15
      );
      this.agcBandPeak = expSmooth(
        this.agcBandPeak,
        Math.max(0.025, peakSample),
        dt,
        9.0,
        0.72
      );
      this.agcWavePeak = expSmooth(
        this.agcWavePeak,
        Math.max(0.008, wavePeak),
        dt,
        10.0,
        0.75
      );
    } else {
      this.agcBandPeak = expSmooth(this.agcBandPeak, 0.14, dt, 0.6, 0.6);
      this.agcWavePeak = expSmooth(this.agcWavePeak, 0.08, dt, 0.6, 0.6);
    }

    const gain = clamp(0.92 / Math.max(0.025, this.agcBandPeak), 0.75, 16.0);
    const sens = 1.05;

    const normSub = hasSignal ? clamp(Math.pow(rawSub * gain, 1.1) * sens, 0, 1) : 0;
    const normBass = hasSignal ? clamp(Math.pow(rawBass * gain, 1.06) * sens, 0, 1) : 0;
    const normLowMid = hasSignal ? clamp(rawLowMid * gain * 1.1 * sens, 0, 1) : 0;
    const normVocal = hasSignal ? clamp(rawVocal * gain * 1.18 * sens, 0, 1) : 0;
    const normPresence = hasSignal ? clamp(rawPresence * gain * 1.32 * sens, 0, 1) : 0;
    const normBrilliance = hasSignal ? clamp(rawBrilliance * gain * 1.55 * sens, 0, 1) : 0;
    const normAir = hasSignal ? clamp(rawAir * gain * 1.85 * sens, 0, 1) : 0;
    const normTreble = hasSignal ? clamp(rawTreble * gain * 1.42 * sens, 0, 1) : 0;

    // 3. Per-instrument positive spectral flux (kick, snare, hi-hat, broadband transient)
    const fluxInRange = (minHz: number, maxHz: number): number => {
      const start = Math.max(1, Math.floor(minHz / binHz));
      const end = Math.min(this.prevFreq.length - 1, freqBins.length - 1, Math.ceil(maxHz / binHz));
      if (end < start) return 0;
      let sum = 0;
      for (let i = start; i <= end; i++) {
        const cur = clamp((freqBins[i] / 255) * gain, 0, 1.5);
        const diff = cur - this.prevFreq[i];
        if (diff > 0) sum += diff;
      }
      return sum / (end - start + 1);
    };

    const kickFlux = hasSignal ? fluxInRange(30, 118) : 0;
    const snareFlux = hasSignal
      ? fluxInRange(175, 520) * 0.52 + fluxInRange(1800, 5200) * 0.48
      : 0;
    const hiHatFlux = hasSignal ? fluxInRange(6000, 15000) : 0;
    const broadbandFlux = hasSignal ? fluxInRange(140, 12000) : 0;

    const prevCount = Math.min(this.prevFreq.length, freqBins.length);
    for (let i = 0; i < prevCount; i++) {
      this.prevFreq[i] = clamp((freqBins[i] / 255) * gain, 0, 1.5);
    }

    const histStats = (arr: Float32Array): { mean: number; std: number } => {
      let mean = 0;
      for (let i = 0; i < arr.length; i++) mean += arr[i];
      mean /= arr.length;
      let variance = 0;
      for (let i = 0; i < arr.length; i++) {
        const d = arr[i] - mean;
        variance += d * d;
      }
      return { mean, std: Math.sqrt(variance / arr.length) };
    };

    const kickStats = histStats(this.kickFluxHist);
    const snareStats = histStats(this.snareFluxHist);
    const hiHatStats = histStats(this.hiHatFluxHist);
    const broadStats = histStats(this.broadbandFluxHist);

    this.kickFluxHist[this.histCursor] = kickFlux;
    this.snareFluxHist[this.histCursor] = snareFlux;
    this.hiHatFluxHist[this.histCursor] = hiHatFlux;
    this.broadbandFluxHist[this.histCursor] = broadbandFlux;
    this.histCursor = (this.histCursor + 1) % FLUX_HISTORY;

    // Kick transient + shockwave emitter
    const kickThresh = Math.max(0.045, kickStats.mean + kickStats.std * 1.35);
    let kickFired = false;
    if (
      hasSignal &&
      kickFlux > kickThresh &&
      normBass > 0.24 &&
      nowMs - this.lastKickMs > 155
    ) {
      const ratio = (kickFlux - kickThresh) / Math.max(0.05, kickStats.mean + 0.04);
      const strength = clamp((0.64 + ratio * 0.28) * clamp(sens, 0.7, 1.25), 0.62, 0.98);
      f.kick = Math.max(f.kick, strength);
      this.lastKickMs = nowMs;
      kickFired = true;
      this.emitKickWave();
    } else {
      f.kick *= Math.exp(-dt * 5.2);
    }

    // Snare / clap transient + shockwave emitter
    const snareThresh = Math.max(0.038, snareStats.mean + snareStats.std * 1.45);
    if (
      hasSignal &&
      snareFlux > snareThresh &&
      (normLowMid > 0.18 || normVocal > 0.2 || normPresence > 0.2) &&
      nowMs - this.lastSnareMs > 160
    ) {
      const ratio = (snareFlux - snareThresh) / Math.max(0.04, snareStats.mean + 0.035);
      const strength = clamp((0.52 + ratio * 0.3) * clamp(sens, 0.7, 1.2), 0.48, 0.92);
      f.snare = Math.max(f.snare, strength);
      this.lastSnareMs = nowMs;
      this.emitSnareWave();
    } else {
      f.snare *= Math.exp(-dt * 6.8);
    }

    // Hi-hat / cymbal shimmer transient
    const hiHatThresh = Math.max(0.026, hiHatStats.mean + hiHatStats.std * 1.35);
    if (hasSignal && hiHatFlux > hiHatThresh && nowMs - this.lastHiHatMs > 95) {
      f.hiHat = Math.max(f.hiHat, clamp(0.48 + hiHatFlux * 2.1, 0.42, 0.92));
      this.lastHiHatMs = nowMs;
    } else {
      f.hiHat *= Math.exp(-dt * 10.5);
    }

    // Broadband sharp attack (guitar plucks, piano strikes, rimshots, claps)
    const broadThresh = Math.max(0.028, broadStats.mean + broadStats.std * 1.3);
    if (hasSignal && broadbandFlux > broadThresh && nowMs - this.lastTransientMs > 85) {
      f.transient = Math.max(f.transient, clamp(0.45 + broadbandFlux * 2.4, 0.4, 0.95));
      this.lastTransientMs = nowMs;
    } else {
      f.transient *= Math.exp(-dt * 11.5);
    }

    // 4. Smooth band envelopes
    f.subBass = expSmooth(f.subBass, normSub, dt, 22, 5.5);
    f.bass = expSmooth(f.bass, normBass, dt, 24, 6.0);
    f.lowMid = expSmooth(f.lowMid, normLowMid, dt, 18, 5.5);
    f.vocal = expSmooth(f.vocal, normVocal, dt, 18, 5.2);
    f.presence = expSmooth(f.presence, normPresence, dt, 22, 6.5);
    f.brilliance = expSmooth(f.brilliance, normBrilliance, dt, 26, 8.0);
    f.air = expSmooth(f.air, normAir, dt, 28, 9.0);
    f.treble = expSmooth(f.treble, normTreble, dt, 22, 7.0);

    const instantEnergy =
      normSub * 0.20 +
      normBass * 0.28 +
      normLowMid * 0.15 +
      normVocal * 0.19 +
      normPresence * 0.10 +
      normBrilliance * 0.05 +
      normAir * 0.03;
    f.energy = expSmooth(f.energy, instantEnergy, dt, 14, 4.2);

    // 5. Real-time 12-note Chromagram (C..B)
    this.ensureChromaTable(sampleRate, fftSize, freqBins.length);
    this.chromaRaw.fill(0);
    if (hasSignal) {
      let maxChroma = 0;
      for (let i = this.chromaBinStart; i <= this.chromaBinEnd; i++) {
        const mag = freqBins[i] / 255;
        if (mag <= 0.004) continue;
        const pc = this.chromaBinPitchClass[i];
        const power = mag * mag;
        this.chromaRaw[pc] += power;
        if (this.chromaRaw[pc] > maxChroma) maxChroma = this.chromaRaw[pc];
      }
      const normDiv = Math.max(0.002, maxChroma);
      const energyGate = clamp(Math.max(f.energy * 1.45, Math.sqrt(maxChroma) * 1.15), 0, 1);
      for (let c = 0; c < CHROMA_BINS; c++) {
        const target = clamp(Math.pow(this.chromaRaw[c] / normDiv, 0.72) * energyGate, 0, 1);
        f.chroma[c] = expSmooth(f.chroma[c], target, dt, 15, 4.2);
      }
    } else {
      for (let c = 0; c < CHROMA_BINS; c++) {
        f.chroma[c] = expSmooth(f.chroma[c], 0, dt, 15, 4.5);
      }
    }

    // 6. Spectral Centroid (brightness), Tonality (1 - flatness), Crest & Stereo metrics
    if (hasSignal) {
      const startBin = Math.max(1, Math.floor(120 / binHz));
      const endBin = Math.min(freqBins.length - 1, Math.ceil(10000 / binHz));
      let magSum = 0;
      let weightedFreqSum = 0;
      let logSum = 0;
      let count = 0;
      for (let i = startBin; i <= endBin; i++) {
        const m = freqBins[i] / 255;
        magSum += m;
        weightedFreqSum += m * (i * binHz);
        logSum += Math.log(m + 1e-4);
        count++;
      }

      if (count > 0 && magSum > 1e-4) {
        const centroidHz = weightedFreqSum / magSum;
        const logNorm = clamp(
          (Math.log2(Math.max(120, centroidHz)) - Math.log2(200)) /
            (Math.log2(7500) - Math.log2(200)),
          0,
          1
        );
        f.centroid = expSmooth(f.centroid, logNorm, dt, 10, 4.5);

        const geoMean = Math.exp(logSum / count);
        const arithMean = magSum / count + 1e-4;
        const flatness = clamp(geoMean / arithMean, 0, 1);
        const tonalityTarget = clamp(1.0 - flatness * 1.15, 0, 1);
        f.tonality = expSmooth(f.tonality, tonalityTarget, dt, 9, 4.5);
      }

      const crestTarget = clamp((wavePeak / Math.max(0.005, rms) - 1.2) / 3.5, 0, 1);
      f.crest = expSmooth(f.crest, crestTarget, dt, 10, 4.0);
    } else {
      f.centroid = expSmooth(f.centroid, 0.3, dt, 3, 2);
      f.tonality = expSmooth(f.tonality, 0.5, dt, 3, 2);
      f.crest = expSmooth(f.crest, 0, dt, 4, 4);
    }

    // Stereo width & balance (from native SVA2 / WebAudio splitter or derived from stereo buffers)
    let targetWidth = stereo?.stereoWidth ?? 0;
    let targetBalance = stereo?.stereoBalance ?? 0;
    if (
      stereo &&
      stereo.stereoWidth === undefined &&
      stereo.leftTimeBins &&
      stereo.rightTimeBins
    ) {
      const n = Math.min(stereo.leftTimeBins.length, stereo.rightTimeBins.length);
      let sL2 = 0;
      let sR2 = 0;
      let sMid2 = 0;
      let sSide2 = 0;
      for (let i = 0; i < n; i++) {
        const l = (stereo.leftTimeBins[i] - 128) / 128;
        const r = (stereo.rightTimeBins[i] - 128) / 128;
        const m = 0.5 * (l + r);
        const sd = 0.5 * (l - r);
        sL2 += l * l;
        sR2 += r * r;
        sMid2 += m * m;
        sSide2 += sd * sd;
      }
      if (n > 0) {
        const rL = Math.sqrt(sL2 / n);
        const rR = Math.sqrt(sR2 / n);
        const rM = Math.sqrt(sMid2 / n);
        const rS = Math.sqrt(sSide2 / n);
        targetWidth =
          rM + rS > 0.0005 ? clamp((rS / (rM + rS * 0.45 + 1e-6)) * 1.45, 0, 1) : 0;
        targetBalance =
          rL + rR > 0.0005 ? clamp((rR - rL) / (rL + rR + 1e-6), -1, 1) : 0;
      }
    }
    f.stereoWidth = expSmooth(f.stereoWidth, hasSignal ? clamp(targetWidth, 0, 1) : 0, dt, 10, 4.5);
    f.stereoBalance = expSmooth(
      f.stereoBalance,
      hasSignal ? clamp(targetBalance, -1, 1) : 0,
      dt,
      10,
      4.5
    );

    // 7. Musical Drop / Chorus surge detector (pre-AGC volume-invariant ratio)
    this.shortEnergy = expSmooth(this.shortEnergy, rawComposite, dt, 4.8, 2.2);
    this.longEnergy = expSmooth(
      this.longEnergy,
      hasSignal ? Math.max(0.015, rawComposite) : this.longEnergy,
      dt,
      0.24,
      0.20
    );

    const surgeRatio = this.shortEnergy / Math.max(0.015, this.longEnergy);
    const dropTarget =
      hasSignal && surgeRatio > 1.28 && this.shortEnergy > 0.025
        ? clamp((surgeRatio - 1.22) * 1.45, 0, 1)
        : 0;
    const prevDrop = f.drop;
    f.drop = expSmooth(f.drop, dropTarget, dt, 5.0, 1.2);

    // Self-regulating musical pulse
    this.kickActivity = expSmooth(this.kickActivity, f.kick, dt, 1.4, 0.45);
    const chillToGroove = 0.72 + clamp(f.energy * 0.24, 0, 0.24);
    const dropBoost = f.drop * 0.30;
    const rapidGovernor = Math.max(0, this.kickActivity - 0.28) * 0.8;
    const targetAutoPulse = hasSignal
      ? clamp(chillToGroove + dropBoost - rapidGovernor, 0.68, 1.22)
      : 0.75;
    f.autoPulse = expSmooth(f.autoPulse, targetAutoPulse, dt, 2.8, 1.4);

    // 8. Musical color stepping on drops & phrases
    if (hasSignal) {
      if (kickFired) this.kicksSinceStep++;
      const dropTriggered = f.drop > 0.5 && prevDrop <= 0.5;
      const phraseComplete = this.kicksSinceStep >= 10 && nowMs - this.lastColorStepMs > 4200;

      if ((dropTriggered && nowMs - this.lastColorStepMs > 2200) || phraseComplete) {
        this.targetColorIndex += 1.0;
        this.kicksSinceStep = 0;
        this.lastColorStepMs = nowMs;
      } else {
        this.targetColorIndex += dt * 0.025;
      }
    }
    this.currentColorIndex +=
      (this.targetColorIndex - this.currentColorIndex) * (1 - Math.exp(-dt * 2.4));
    f.colorIndex = ((this.currentColorIndex % 3) + 3) % 3;

    // 9. Audio active blend & 5-bar HUD EQ
    f.audioActive = expSmooth(f.audioActive, hasSignal ? 1 : 0, dt, 6.0, 1.6);
    f.eqBars[0] = f.subBass;
    f.eqBars[1] = f.bass;
    f.eqBars[2] = f.lowMid;
    f.eqBars[3] = f.vocal;
    f.eqBars[4] = Math.max(f.presence, f.brilliance);

    // 10. Pack 256 x 10 R8 audio data texture & 256 x 4 RGBA8 rolling history row
    const tex = f.textureData;
    const hist = f.historyRow;
    const maxBin = Math.min(freqBins.length - 1, Math.max(8, Math.floor(16000 / Math.max(1, binHz))));
    const waveGain = clamp(0.88 / Math.max(0.008, this.agcWavePeak), 1.0, 28.0);

    const hasStereoFreq =
      Boolean(stereo?.leftFreqBins && stereo?.rightFreqBins) &&
      stereo!.leftFreqBins!.length >= AUDIO_TEX_WIDTH &&
      stereo!.rightFreqBins!.length >= AUDIO_TEX_WIDTH;
    const hasStereoTime =
      Boolean(stereo?.leftTimeBins && stereo?.rightTimeBins) &&
      stereo!.leftTimeBins!.length >= AUDIO_TEX_WIDTH &&
      stereo!.rightTimeBins!.length >= AUDIO_TEX_WIDTH;

    // First pass: extract combined waveform & compute low-pass bass wave / high-pass air wave
    let lp1 = 0;
    let lp2 = 0;
    const lpAlpha = 0.14; // Smooth low-pass cut around sub/bass frequencies
    for (let x = 0; x < AUDIO_TEX_WIDTH; x++) {
      const u = x / (AUDIO_TEX_WIDTH - 1);
      const waveIdx = Math.min(waveLen - 1, Math.floor(u * waveLen));
      const centered = hasSignal && waveLen > 0 ? ((timeBins[waveIdx] - 128) / 128) * waveGain : 0;
      this.waveCentered[x] = clamp(centered, -1.2, 1.2);
      lp1 += (this.waveCentered[x] - lp1) * lpAlpha;
      lp2 += (lp1 - lp2) * lpAlpha;
      this.waveLowPass[x] = lp2;
    }

    for (let x = 0; x < AUDIO_TEX_WIDTH; x++) {
      const u = x / (AUDIO_TEX_WIDTH - 1);
      const logIdx = clamp(Math.floor(Math.pow(Math.max(2, maxBin), u)), 1, maxBin);

      // Row 0: Instantaneous AGC log-mapped FFT
      const instantFft = hasSignal
        ? clamp((freqBins[logIdx] / 255) * gain * sens, 0, 1)
        : 0;
      const prevSmoothByte = tex[x];
      const nextFftByte = Math.round(prevSmoothByte * 0.52 + instantFft * 255 * 0.48);
      tex[x] = nextFftByte;
      const specVal = nextFftByte / 255;

      // Row 1: Gravity Peak-Hold FFT (jumps instantly up, hovers briefly, then falls smoothly)
      if (specVal >= this.peakHold[x]) {
        this.peakHold[x] = specVal;
        this.peakVel[x] = -0.06; // Tiny hover grace before gravity pulls down
      } else {
        this.peakVel[x] = Math.min(1.6, this.peakVel[x] + dt * 1.15);
        if (this.peakVel[x] > 0) {
          this.peakHold[x] = Math.max(specVal, this.peakHold[x] - this.peakVel[x] * dt);
        }
      }
      tex[AUDIO_TEX_WIDTH * 1 + x] = clamp(Math.round(this.peakHold[x] * 255), 0, 255);

      // Row 2: Per-bin positive Spectral Flux (exact frequency-localized note/drum attacks!)
      const binDiff = Math.max(0, instantFft - this.prevLogSpec[x]);
      this.prevLogSpec[x] = this.prevLogSpec[x] * 0.65 + instantFft * 0.35;
      const targetFlux = hasSignal ? clamp(binDiff * 3.8, 0, 1) : 0;
      this.binFluxSmooth[x] = Math.max(targetFlux, this.binFluxSmooth[x] * Math.exp(-dt * 11.0));
      const fluxByte = clamp(Math.round(this.binFluxSmooth[x] * 255), 0, 255);
      tex[AUDIO_TEX_WIDTH * 2 + x] = fluxByte;

      // Row 3: Combined PCM waveform
      const targetWave = hasSignal
        ? clamp(Math.round(128 + this.waveCentered[x] * 114), 0, 255)
        : 128;
      const waveByte = Math.round(tex[AUDIO_TEX_WIDTH * 3 + x] * 0.4 + targetWave * 0.6);
      tex[AUDIO_TEX_WIDTH * 3 + x] = waveByte;

      // Row 4 & Row 5: Stereo Left & Right AGC FFT
      let leftFftByte = nextFftByte;
      let rightFftByte = nextFftByte;
      if (hasStereoFreq) {
        const lVal = hasSignal
          ? clamp((stereo!.leftFreqBins![x] / 255) * gain * sens * 255, 0, 255)
          : 0;
        const rVal = hasSignal
          ? clamp((stereo!.rightFreqBins![x] / 255) * gain * sens * 255, 0, 255)
          : 0;
        leftFftByte = Math.round(tex[AUDIO_TEX_WIDTH * 4 + x] * 0.52 + lVal * 0.48);
        rightFftByte = Math.round(tex[AUDIO_TEX_WIDTH * 5 + x] * 0.52 + rVal * 0.48);
      }
      tex[AUDIO_TEX_WIDTH * 4 + x] = leftFftByte;
      tex[AUDIO_TEX_WIDTH * 5 + x] = rightFftByte;

      // Row 6 & Row 7: Stereo Left & Right PCM waveforms
      let leftWaveByte = waveByte;
      let rightWaveByte = waveByte;
      if (hasStereoTime) {
        const cL = hasSignal ? ((stereo!.leftTimeBins![x] - 128) / 128) * waveGain : 0;
        const cR = hasSignal ? ((stereo!.rightTimeBins![x] - 128) / 128) * waveGain : 0;
        const tL = hasSignal ? clamp(Math.round(128 + cL * 112), 0, 255) : 128;
        const tR = hasSignal ? clamp(Math.round(128 + cR * 112), 0, 255) : 128;
        leftWaveByte = Math.round(tex[AUDIO_TEX_WIDTH * 6 + x] * 0.35 + tL * 0.65);
        rightWaveByte = Math.round(tex[AUDIO_TEX_WIDTH * 7 + x] * 0.35 + tR * 0.65);
      }
      tex[AUDIO_TEX_WIDTH * 6 + x] = leftWaveByte;
      tex[AUDIO_TEX_WIDTH * 7 + x] = rightWaveByte;

      // Row 8: Low-passed Bass waveform
      const targetBassWave = hasSignal
        ? clamp(Math.round(128 + this.waveLowPass[x] * 124), 0, 255)
        : 128;
      tex[AUDIO_TEX_WIDTH * 8 + x] = Math.round(
        tex[AUDIO_TEX_WIDTH * 8 + x] * 0.45 + targetBassWave * 0.55
      );

      // Row 9: High-passed Treble / Air micro-detail waveform
      const hpSample = (this.waveCentered[x] - this.waveLowPass[x]) * 1.45;
      const targetTrebleWave = hasSignal
        ? clamp(Math.round(128 + clamp(hpSample, -1.0, 1.0) * 114), 0, 255)
        : 128;
      tex[AUDIO_TEX_WIDTH * 9 + x] = Math.round(
        tex[AUDIO_TEX_WIDTH * 9 + x] * 0.35 + targetTrebleWave * 0.65
      );

      // Pack RGBA8 row for the rolling 64-frame GPU history ring buffer
      const hIdx = x * 4;
      hist[hIdx + 0] = nextFftByte;
      hist[hIdx + 1] = clamp(Math.round(128 + (rightFftByte - leftFftByte) * 0.95), 0, 255);
      hist[hIdx + 2] = fluxByte;
      hist[hIdx + 3] = waveByte;
    }

    return f;
  }

  public processAmbient(dtSec: number, nowMs: number, isSpotifyPlaying: boolean): AudioFrame {
    const dt = clamp(dtSec, 0.001, 0.05);
    const f = this.frame;
    const t = nowMs * 0.001;
    const amp = isSpotifyPlaying ? 0.44 : 0.18;

    this.advanceShockwaves(dt);

    // Gentle organic rhythmic breath when Spotify is playing without live audio tap (e.g. Echo Show / Web)
    if (isSpotifyPlaying && nowMs - this.lastAmbientKickMs > 1350) {
      this.lastAmbientKickMs = nowMs;
      f.kick = 0.48;
      this.emitKickWave();
    } else {
      f.kick *= Math.exp(-dt * 4.5);
    }

    const synthBass = (0.5 + 0.5 * Math.sin(t * 2.3)) * amp;
    const synthVocal = (0.5 + 0.5 * Math.sin(t * 1.45 + 1.2)) * amp * 0.85;
    const synthPresence = (0.5 + 0.5 * Math.sin(t * 2.9 + 2.1)) * amp * 0.65;
    const synthAir = (0.5 + 0.5 * Math.sin(t * 4.2 + 0.7)) * amp * 0.48;

    f.subBass = expSmooth(f.subBass, synthBass * 0.9, dt, 4, 4);
    f.bass = expSmooth(f.bass, synthBass, dt, 4, 4);
    f.lowMid = expSmooth(f.lowMid, synthVocal * 0.82, dt, 4, 4);
    f.vocal = expSmooth(f.vocal, synthVocal, dt, 4, 4);
    f.presence = expSmooth(f.presence, synthPresence, dt, 4, 4);
    f.brilliance = expSmooth(f.brilliance, synthAir * 0.9, dt, 4, 4);
    f.air = expSmooth(f.air, synthAir * 0.75, dt, 4, 4);
    f.treble = expSmooth(f.treble, (synthPresence + synthAir) * 0.5, dt, 4, 4);
    f.energy = expSmooth(f.energy, (synthBass + synthVocal) * 0.46, dt, 4, 4);
    f.snare *= Math.exp(-dt * 7.5);
    f.hiHat = expSmooth(f.hiHat, isSpotifyPlaying ? synthAir * 0.45 : 0, dt, 6, 6);
    f.transient *= Math.exp(-dt * 9.0);
    f.drop *= Math.exp(-dt * 2.5);
    f.autoPulse = expSmooth(f.autoPulse, 0.95, dt, 2.0, 2.0);
    f.rms = 0;
    f.crest = 0.25;
    f.centroid = 0.38 + 0.12 * Math.sin(t * 0.65);
    f.tonality = 0.72;
    f.stereoWidth = isSpotifyPlaying ? 0.34 + 0.14 * Math.sin(t * 0.9) : 0.12;
    f.stereoBalance = isSpotifyPlaying ? 0.14 * Math.sin(t * 0.55) : 0;
    f.audioActive = expSmooth(f.audioActive, 0, dt, 3, 3);

    // Gentle synthetic triad chroma chord slowly rotating
    const rootNote = Math.floor(t * 0.22) % 12;
    const triadA = rootNote;
    const triadB = (rootNote + 4) % 12;
    const triadC = (rootNote + 7) % 12;
    for (let c = 0; c < CHROMA_BINS; c++) {
      const target =
        c === triadA
          ? amp * 1.45
          : c === triadB || c === triadC
            ? amp * 1.05
            : amp * 0.15;
      f.chroma[c] = expSmooth(f.chroma[c], clamp(target, 0, 1), dt, 3.5, 2.5);
    }

    this.targetColorIndex += dt * 0.06;
    this.currentColorIndex +=
      (this.targetColorIndex - this.currentColorIndex) * (1 - Math.exp(-dt * 2));
    f.colorIndex = ((this.currentColorIndex % 3) + 3) % 3;

    f.eqBars[0] = f.subBass * 0.5;
    f.eqBars[1] = f.bass * 0.5;
    f.eqBars[2] = f.lowMid * 0.5;
    f.eqBars[3] = f.vocal * 0.5;
    f.eqBars[4] = f.treble * 0.5;

    const tex = f.textureData;
    const hist = f.historyRow;
    const playScale = isSpotifyPlaying ? 1 : 0.42;

    for (let x = 0; x < AUDIO_TEX_WIDTH; x++) {
      const u = x / (AUDIO_TEX_WIDTH - 1);
      const spec =
        Math.exp(-u * 2.2) *
        (0.24 + 0.16 * Math.sin(u * 11 - t * 2.3) + 0.08 * Math.cos(u * 23 + t * 3.1)) *
        playScale;
      const specByte = clamp(Math.round(spec * 255), 0, 255);
      const panShift = Math.sin(u * 7.5 + t * 1.1) * 26 * playScale;
      const leftSpec = clamp(Math.round(specByte - panShift), 0, 255);
      const rightSpec = clamp(Math.round(specByte + panShift), 0, 255);
      const peakByte = clamp(specByte + Math.round(14 * playScale), 0, 255);
      const fluxByte = clamp(
        Math.round(Math.max(0, Math.sin(u * 19 - t * 5.0)) * 55 * playScale),
        0,
        255
      );

      const bassW = Math.sin(u * Math.PI * 3 + t * 2.1) * 26 * playScale;
      const trebleW = Math.sin(u * Math.PI * 17 - t * 6.2) * 12 * playScale;
      const sumW = clamp(Math.round(128 + bassW + trebleW * 0.5), 0, 255);
      const wL = clamp(Math.round(128 + Math.sin(u * Math.PI * 5 + t * 2.6) * 24 * playScale), 0, 255);
      const wR = clamp(Math.round(128 + Math.sin(u * Math.PI * 5 + t * 2.6 + 0.65) * 24 * playScale), 0, 255);

      tex[x] = specByte;
      tex[AUDIO_TEX_WIDTH * 1 + x] = peakByte;
      tex[AUDIO_TEX_WIDTH * 2 + x] = fluxByte;
      tex[AUDIO_TEX_WIDTH * 3 + x] = sumW;
      tex[AUDIO_TEX_WIDTH * 4 + x] = leftSpec;
      tex[AUDIO_TEX_WIDTH * 5 + x] = rightSpec;
      tex[AUDIO_TEX_WIDTH * 6 + x] = wL;
      tex[AUDIO_TEX_WIDTH * 7 + x] = wR;
      tex[AUDIO_TEX_WIDTH * 8 + x] = clamp(Math.round(128 + bassW), 0, 255);
      tex[AUDIO_TEX_WIDTH * 9 + x] = clamp(Math.round(128 + trebleW), 0, 255);

      const hIdx = x * 4;
      hist[hIdx + 0] = specByte;
      hist[hIdx + 1] = clamp(Math.round(128 + (rightSpec - leftSpec) * 0.9), 0, 255);
      hist[hIdx + 2] = fluxByte;
      hist[hIdx + 3] = sumW;
    }

    return f;
  }
}
