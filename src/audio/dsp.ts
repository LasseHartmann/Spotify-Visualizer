export const AUDIO_TEX_WIDTH = 256;

export interface AudioFrame {
  subBass: number;
  bass: number;
  lowMid: number;
  vocal: number;
  treble: number;
  energy: number;
  kick: number;
  snare: number;
  hiHat: number;
  drop: number;
  autoPulse: number; // Self-regulating beat & backlight pulse intensity (0.8..1.55)
  colorIndex: number; // Continuous 0..3 phase for backlight-coherent single-hue cycling
  audioActive: number; // 0 = ambient/silent, 1 = real audio driving visuals
  rms: number;
  eqBars: [number, number, number, number, number];
  textureData: Uint8Array; // 256 x 3 single-channel bytes (row 0: AGC FFT, row 1: phase-locked waveform, row 2: gravity peak-hold caps)
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
 * Pure real-time music DSP engine with Adaptive Auto-Gain Control (AGC),
 * per-instrument onset detection (kick / snare / hi-hat), musical drop tracking,
 * and beat-stepped color phase advancement for coherent screen-average backlights.
 */
export class AudioDsp {
  private prevFreq = new Float32Array(512);
  private kickFluxHist = new Float32Array(FLUX_HISTORY);
  private snareFluxHist = new Float32Array(FLUX_HISTORY);
  private hiHatFluxHist = new Float32Array(FLUX_HISTORY);
  private histCursor = 0;

  // Adaptive auto-gain envelopes (keeps reactivity punchy at 15% or 100% system volume)
  private agcBandPeak = 0.16;
  private agcWavePeak = 0.12;

  // Short-term vs long-term raw energy envelopes for volume-invariant drop detection
  private shortEnergy = 0;
  private longEnergy = 0.08;

  // Rolling beat density tracker for automatic pulse self-regulation
  private kickActivity = 0.14;

  // Onset refractory timestamps & rhythmic color-stepping state
  private lastKickMs = -1000;
  private lastSnareMs = -1000;
  private lastHiHatMs = -1000;
  private lastColorStepMs = -10000;
  private kicksSinceStep = 0;
  private targetColorIndex = 0;
  private currentColorIndex = 0;

  // Per-bin gravity peak-hold state for crisp hardware-EQ falling caps in Bars mode
  private peakVals = new Float32Array(AUDIO_TEX_WIDTH);
  private peakHoldTimers = new Float32Array(AUDIO_TEX_WIDTH);
  private peakVel = new Float32Array(AUDIO_TEX_WIDTH);

  public readonly frame: AudioFrame = {
    subBass: 0,
    bass: 0,
    lowMid: 0,
    vocal: 0,
    treble: 0,
    energy: 0,
    kick: 0,
    snare: 0,
    hiHat: 0,
    drop: 0,
    autoPulse: 1.15,
    colorIndex: 0,
    audioActive: 0,
    rms: 0,
    eqBars: [0, 0, 0, 0, 0],
    textureData: new Uint8Array(AUDIO_TEX_WIDTH * 3),
  };

  constructor() {
    this.frame.textureData.fill(128, AUDIO_TEX_WIDTH, AUDIO_TEX_WIDTH * 2);
  }

  public reset(): void {
    this.prevFreq.fill(0);
    this.kickFluxHist.fill(0);
    this.snareFluxHist.fill(0);
    this.hiHatFluxHist.fill(0);
    this.peakVals.fill(0);
    this.peakHoldTimers.fill(0);
    this.peakVel.fill(0);
    this.histCursor = 0;
    this.agcBandPeak = 0.16;
    this.agcWavePeak = 0.12;
    this.shortEnergy = 0;
    this.longEnergy = 0.08;
    this.kickActivity = 0.14;
    this.kicksSinceStep = 0;
  }

  public processLive(
    freqBins: Uint8Array,
    timeBins: Uint8Array,
    sampleRate: number,
    fftSize: number,
    dtSec: number,
    nowMs: number
  ): AudioFrame {
    const dt = clamp(dtSec, 0.001, 0.05);
    const f = this.frame;
    const binHz = sampleRate / fftSize;

    // 1. Measure real PCM RMS & peak amplitude from time-domain waveform
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

    // Raw frequency band averages (0..1)
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
    const rawBass = rawBand(55, 195);
    const rawLowMid = rawBand(195, 560);
    const rawVocal = rawBand(560, 2800);
    const rawTreble = rawBand(2800, 14000);

    const rawComposite =
      rawSub * 0.22 +
      rawBass * 0.30 +
      rawLowMid * 0.18 +
      rawVocal * 0.18 +
      rawTreble * 0.12;

    const hasSignal = rms > 0.0006 || rawComposite > 0.006;

    // 2. Adaptive Auto-Gain Control (AGC)
    if (hasSignal) {
      const peakSample = Math.max(rawBass, rawSub * 0.95, rawVocal * 0.9, rawComposite * 1.15);
      // Fast rise, ~1.5s smooth decay so quiet tracks and low Windows laptop/headphone volume lock in rapidly
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
      // Gently relax AGC toward neutral floor during silence
      this.agcBandPeak = expSmooth(this.agcBandPeak, 0.14, dt, 0.6, 0.6);
      this.agcWavePeak = expSmooth(this.agcWavePeak, 0.08, dt, 0.6, 0.6);
    }

    const gain = clamp(0.92 / Math.max(0.025, this.agcBandPeak), 0.75, 16.0);
    const sens = 1.05;

    const normSub = hasSignal ? clamp(Math.pow(rawSub * gain, 1.12) * sens, 0, 1) : 0;
    const normBass = hasSignal ? clamp(Math.pow(rawBass * gain, 1.08) * sens, 0, 1) : 0;
    const normLowMid = hasSignal ? clamp(rawLowMid * gain * 1.08 * sens, 0, 1) : 0;
    const normVocal = hasSignal ? clamp(rawVocal * gain * 1.18 * sens, 0, 1) : 0;
    const normTreble = hasSignal ? clamp(rawTreble * gain * 1.38 * sens, 0, 1) : 0;

    // 3. Per-instrument positive spectral flux (kick, snare, hi-hat)
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
      ? fluxInRange(175, 520) * 0.55 + fluxInRange(1800, 4800) * 0.45
      : 0;
    const hiHatFlux = hasSignal ? fluxInRange(6000, 14000) : 0;

    // Update previous AGC-normalized spectrum snapshot
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

    this.kickFluxHist[this.histCursor] = kickFlux;
    this.snareFluxHist[this.histCursor] = snareFlux;
    this.hiHatFluxHist[this.histCursor] = hiHatFlux;
    this.histCursor = (this.histCursor + 1) % FLUX_HISTORY;

    // Kick drum transient detector (smooth, musical thump without harsh strobing)
    const kickThresh = Math.max(0.045, kickStats.mean + kickStats.std * 1.35);
    let kickFired = false;
    if (
      hasSignal &&
      kickFlux > kickThresh &&
      normBass > 0.24 &&
      nowMs - this.lastKickMs > 155
    ) {
      const ratio = (kickFlux - kickThresh) / Math.max(0.05, kickStats.mean + 0.04);
      const strength = clamp((0.64 + ratio * 0.28) * clamp(sens, 0.7, 1.25), 0.62, 0.96);
      f.kick = Math.max(f.kick, strength);
      this.lastKickMs = nowMs;
      kickFired = true;
    } else {
      f.kick *= Math.exp(-dt * 5.2);
    }

    // Snare / clap transient detector (gentle secondary accent)
    const snareThresh = Math.max(0.038, snareStats.mean + snareStats.std * 1.5);
    if (
      hasSignal &&
      snareFlux > snareThresh &&
      (normLowMid > 0.2 || normVocal > 0.22) &&
      nowMs - this.lastSnareMs > 165
    ) {
      const ratio = (snareFlux - snareThresh) / Math.max(0.04, snareStats.mean + 0.035);
      const strength = clamp((0.48 + ratio * 0.28) * clamp(sens, 0.7, 1.2), 0.45, 0.85);
      f.snare = Math.max(f.snare, strength);
      this.lastSnareMs = nowMs;
    } else {
      f.snare *= Math.exp(-dt * 6.8);
    }

    // Hi-hat / high-frequency shimmer detector
    const hiHatThresh = Math.max(0.03, hiHatStats.mean + hiHatStats.std * 1.45);
    if (hasSignal && hiHatFlux > hiHatThresh && nowMs - this.lastHiHatMs > 120) {
      f.hiHat = Math.max(f.hiHat, clamp(0.45 + hiHatFlux * 1.8, 0.4, 0.78));
      this.lastHiHatMs = nowMs;
    } else {
      f.hiHat *= Math.exp(-dt * 9.5);
    }

    // 4. Smooth, velvety band envelopes (responsive to the music without frantic jitter)
    f.subBass = expSmooth(f.subBass, normSub, dt, 22, 5.5);
    f.bass = expSmooth(f.bass, normBass, dt, 24, 6.0);
    f.lowMid = expSmooth(f.lowMid, normLowMid, dt, 18, 5.5);
    f.vocal = expSmooth(f.vocal, normVocal, dt, 16, 5.0);
    f.treble = expSmooth(f.treble, normTreble, dt, 20, 6.8);

    const instantEnergy =
      normSub * 0.22 +
      normBass * 0.30 +
      normLowMid * 0.16 +
      normVocal * 0.20 +
      normTreble * 0.12;
    f.energy = expSmooth(f.energy, instantEnergy, dt, 14, 4.2);

    // 5. Musical Drop / Chorus surge detector (volume-invariant pre-AGC short vs long energy ratio!)
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

    // 5b. Calm, self-regulating pulse intensity (0.68 chill -> 1.12 drop, governed on fast kicks)
    this.kickActivity = expSmooth(this.kickActivity, f.kick, dt, 1.4, 0.45);
    const chillToGroove = 0.68 + clamp(f.energy * 0.22, 0, 0.22);
    const dropBoost = f.drop * 0.28;
    const rapidGovernor = Math.max(0, this.kickActivity - 0.26) * 0.85;
    const targetAutoPulse = hasSignal
      ? clamp(chillToGroove + dropBoost - rapidGovernor, 0.65, 1.14)
      : 0.72;
    f.autoPulse = expSmooth(f.autoPulse, targetAutoPulse, dt, 2.6, 1.3);

    // 6. Musical single-hue color stepping (changes cleanly on drops & phrases — never strobes!)
    if (hasSignal) {
      if (kickFired) {
        this.kicksSinceStep++;
      }
      const dropTriggered = f.drop > 0.5 && prevDrop <= 0.5;
      const phraseComplete = this.kicksSinceStep >= 10 && nowMs - this.lastColorStepMs > 4200;

      if ((dropTriggered && nowMs - this.lastColorStepMs > 2200) || phraseComplete) {
        this.targetColorIndex += 1.0;
        this.kicksSinceStep = 0;
        this.lastColorStepMs = nowMs;
      } else {
        // Ultra-gentle organic drift so colors breathe subtly even in drumless ambient tracks
        this.targetColorIndex += dt * 0.022;
      }
    }
    this.currentColorIndex +=
      (this.targetColorIndex - this.currentColorIndex) * (1 - Math.exp(-dt * 2.4));
    f.colorIndex = ((this.currentColorIndex % 3) + 3) % 3;

    // 7. Audio active blend
    const activeTarget = hasSignal ? 1 : 0;
    f.audioActive = expSmooth(f.audioActive, activeTarget, dt, 6.0, 1.6);

    // 8. 5-bar live HUD EQ readout
    f.eqBars[0] = f.subBass;
    f.eqBars[1] = f.bass;
    f.eqBars[2] = f.lowMid;
    f.eqBars[3] = f.vocal;
    f.eqBars[4] = f.treble;

    // 9. Pack AGC-normalized log-mapped FFT (row 0), center-origin triggered waveform (row 1), & peak-hold caps (row 2)
    const maxBin = Math.min(freqBins.length - 1, Math.floor(14000 / binHz));
    // Blend gentle AGC with natural RMS dynamic range so quiet notes draw smaller than loud hits like a real scope
    const dynamicScale = clamp(0.42 + Math.sqrt(Math.min(1, rms * 3.8)) * 0.58, 0.35, 1.0);
    const waveGain = clamp((0.82 * dynamicScale) / Math.max(0.012, this.agcWavePeak), 0.9, 20.0);

    // True center-origin rising-edge trigger: place the rising zero-crossing at the exact midpoint (u = 0.5, Y-axis!)
    const waveWindow = Math.min(512, Math.max(2, Math.floor(waveLen * 0.5)));
    const halfWindow = Math.floor(waveWindow * 0.5);
    let windowStart = 0;
    if (hasSignal && waveLen > waveWindow + 4) {
      const searchStart = Math.max(1, halfWindow);
      const searchEnd = Math.min(waveLen - halfWindow - 1, Math.floor(waveLen * 0.72));
      let bestSlope = 0;
      for (let i = searchStart; i < searchEnd; i++) {
        if (timeBins[i - 1] <= 128 && timeBins[i] > 128) {
          const slope = timeBins[i] - timeBins[i - 1];
          if (slope > bestSlope) bestSlope = slope;
        }
      }
      if (bestSlope > 0) {
        const slopeThreshold = Math.max(1, bestSlope * 0.45);
        for (let i = searchStart; i < searchEnd; i++) {
          if (timeBins[i - 1] <= 128 && timeBins[i] > 128) {
            if (timeBins[i] - timeBins[i - 1] >= slopeThreshold) {
              windowStart = Math.max(0, i - halfWindow);
              break;
            }
          }
        }
      }
    }

    for (let x = 0; x < AUDIO_TEX_WIDTH; x++) {
      const u = x / (AUDIO_TEX_WIDTH - 1);
      const logIdx = clamp(Math.floor(Math.pow(Math.max(2, maxBin), u)), 1, maxBin);
      const fftVal = hasSignal
        ? clamp(Math.round((freqBins[logIdx] / 255) * gain * sens * 255), 0, 255)
        : 0;
      const fftSmooth = Math.round(f.textureData[x] * 0.52 + fftVal * 0.48);
      f.textureData[x] = fftSmooth;

      // Gravity-falling peak-hold cap per bin (row 2)
      if (fftSmooth >= this.peakVals[x]) {
        this.peakVals[x] = fftSmooth;
        this.peakHoldTimers[x] = 0.16;
        this.peakVel[x] = 0;
      } else if (this.peakHoldTimers[x] > 0) {
        this.peakHoldTimers[x] -= dt;
      } else {
        this.peakVel[x] += dt * 360;
        this.peakVals[x] = Math.max(fftSmooth, this.peakVals[x] - this.peakVel[x] * dt);
      }
      f.textureData[AUDIO_TEX_WIDTH * 2 + x] = clamp(Math.round(this.peakVals[x]), 0, 255);

      let centered = 0;
      if (waveLen > 0) {
        const samplePos = windowStart + u * (waveWindow - 1);
        const i0 = Math.min(waveLen - 1, Math.floor(samplePos));
        const i1 = Math.min(waveLen - 1, i0 + 1);
        const frac = samplePos - i0;
        const interp = timeBins[i0] * (1 - frac) + timeBins[i1] * frac;
        centered = ((interp - 128) / 128) * waveGain;
      }
      const targetWave = hasSignal ? clamp(Math.round(128 + centered * 116), 0, 255) : 128;
      // Crisp real-time oscilloscope phosphor tracking (minimal frame smearing)
      f.textureData[AUDIO_TEX_WIDTH + x] = Math.round(
        f.textureData[AUDIO_TEX_WIDTH + x] * 0.12 + targetWave * 0.88
      );
    }

    return f;
  }

  public processAmbient(dtSec: number, nowMs: number, isSpotifyPlaying: boolean): AudioFrame {
    const dt = clamp(dtSec, 0.001, 0.05);
    const f = this.frame;
    const t = nowMs * 0.001;
    const amp = isSpotifyPlaying ? 0.38 : 0.16;

    const synthBass = (0.5 + 0.5 * Math.sin(t * 2.4)) * amp;
    const synthVocal = (0.5 + 0.5 * Math.sin(t * 1.45 + 1.2)) * amp * 0.85;
    const synthTreble = (0.5 + 0.5 * Math.sin(t * 3.3 + 2.5)) * amp * 0.65;

    f.subBass = expSmooth(f.subBass, synthBass * 0.9, dt, 4, 4);
    f.bass = expSmooth(f.bass, synthBass, dt, 4, 4);
    f.lowMid = expSmooth(f.lowMid, synthVocal * 0.8, dt, 4, 4);
    f.vocal = expSmooth(f.vocal, synthVocal, dt, 4, 4);
    f.treble = expSmooth(f.treble, synthTreble, dt, 4, 4);
    f.energy = expSmooth(f.energy, (synthBass + synthVocal) * 0.45, dt, 4, 4);
    f.kick *= Math.exp(-dt * 6.0);
    f.snare *= Math.exp(-dt * 8.0);
    f.hiHat *= Math.exp(-dt * 10.0);
    f.drop *= Math.exp(-dt * 2.5);
    f.autoPulse = expSmooth(f.autoPulse, 1.0, dt, 2.0, 2.0);
    f.rms = 0;
    f.audioActive = expSmooth(f.audioActive, 0, dt, 3, 3);

    this.targetColorIndex += dt * 0.06;
    this.currentColorIndex += (this.targetColorIndex - this.currentColorIndex) * (1 - Math.exp(-dt * 2));
    f.colorIndex = ((this.currentColorIndex % 3) + 3) % 3;

    f.eqBars[0] = f.subBass * 0.5;
    f.eqBars[1] = f.bass * 0.5;
    f.eqBars[2] = f.lowMid * 0.5;
    f.eqBars[3] = f.vocal * 0.5;
    f.eqBars[4] = f.treble * 0.5;

    for (let x = 0; x < AUDIO_TEX_WIDTH; x++) {
      const u = x / (AUDIO_TEX_WIDTH - 1);
      const spec =
        Math.exp(-u * 2.4) *
        (0.24 + 0.16 * Math.sin(u * 12 - t * 2.4)) *
        (isSpotifyPlaying ? 1 : 0.45);
      const specByte = clamp(Math.round(spec * 255), 0, 255);
      f.textureData[x] = specByte;
      if (specByte >= this.peakVals[x]) {
        this.peakVals[x] = specByte;
        this.peakHoldTimers[x] = 0.14;
        this.peakVel[x] = 0;
      } else if (this.peakHoldTimers[x] > 0) {
        this.peakHoldTimers[x] -= dt;
      } else {
        this.peakVel[x] += dt * 260;
        this.peakVals[x] = Math.max(specByte, this.peakVals[x] - this.peakVel[x] * dt);
      }
      f.textureData[AUDIO_TEX_WIDTH * 2 + x] = clamp(Math.round(this.peakVals[x]), 0, 255);
      const wave =
        128 + Math.sin(u * Math.PI * 5 + t * 2.8) * 24 * (isSpotifyPlaying ? 1 : 0.35);
      f.textureData[AUDIO_TEX_WIDTH + x] = clamp(Math.round(wave), 0, 255);
    }

    return f;
  }
}
