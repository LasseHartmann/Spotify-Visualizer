import { describe, expect, it } from 'vitest';
import { AUDIO_TEX_WIDTH, AudioDsp } from '../src/audio/dsp';

function makeSilentBuffers() {
  const freq = new Uint8Array(1024);
  const time = new Uint8Array(2048).fill(128);
  return { freq, time };
}

function makeToneBuffers(
  bassBinLevel: number,
  midBinLevel: number,
  waveAmp: number
) {
  const freq = new Uint8Array(1024);
  const time = new Uint8Array(2048);

  for (let i = 2; i <= 7; i++) freq[i] = bassBinLevel;
  for (let i = 25; i <= 90; i++) freq[i] = midBinLevel;

  for (let i = 0; i < time.length; i++) {
    const val = Math.sin((i / time.length) * Math.PI * 12) * waveAmp;
    time[i] = Math.max(0, Math.min(255, Math.round(128 + val * 127)));
  }

  return { freq, time };
}

describe('AudioDsp', () => {
  it('stays cleanly silent below the noise floor', () => {
    const dsp = new AudioDsp();
    const { freq, time } = makeSilentBuffers();

    let frame = dsp.frame;
    for (let i = 0; i < 20; i++) {
      frame = dsp.processLive(freq, time, 48000, 2048, 1 / 60, i * 16.67);
    }

    expect(frame.bass).toBe(0);
    expect(frame.kick).toBe(0);
    expect(frame.audioActive).toBeLessThan(0.01);
  });

  it('auto-gains quiet headphone volume so bass and waveform reach strong visual range', () => {
    const dsp = new AudioDsp();
    const { freq, time } = makeToneBuffers(34, 24, 0.045);

    let frame = dsp.frame;
    for (let i = 0; i < 120; i++) {
      frame = dsp.processLive(freq, time, 48000, 2048, 1 / 60, i * 16.67);
    }

    expect(frame.audioActive).toBeGreaterThan(0.9);
    expect(frame.bass).toBeGreaterThan(0.6);
    expect(frame.vocal).toBeGreaterThan(0.45);
  });

  it('locks onto very quiet laptop speaker volume while staying silent at zero', () => {
    const dsp = new AudioDsp();
    const { freq, time } = makeToneBuffers(12, 10, 0.012);

    let frame = dsp.frame;
    for (let i = 0; i < 140; i++) {
      frame = dsp.processLive(freq, time, 48000, 2048, 1 / 60, i * 16.67);
    }

    expect(frame.audioActive).toBeGreaterThan(0.85);
    expect(frame.bass).toBeGreaterThan(0.45);
  });

  it('fires a crisp kick transient and decays cleanly', () => {
    const dsp = new AudioDsp();
    const quiet = makeToneBuffers(20, 22, 0.06);
    const kickHit = makeToneBuffers(180, 30, 0.45);

    for (let i = 0; i < 45; i++) {
      dsp.processLive(quiet.freq, quiet.time, 48000, 2048, 1 / 60, i * 16.67);
    }

    const peakKick = dsp.processLive(
      kickHit.freq,
      kickHit.time,
      48000,
      2048,
      1 / 60,
      46 * 16.67
    ).kick;
    expect(peakKick).toBeGreaterThan(0.6);

    let decayedKick = peakKick;
    for (let i = 47; i < 67; i++) {
      decayedKick = dsp.processLive(
        quiet.freq,
        quiet.time,
        48000,
        2048,
        1 / 60,
        i * 16.67
      ).kick;
    }
    expect(decayedKick).toBeLessThan(peakKick * 0.35);
  });

  it('detects a chorus/drop surge, advances color mood, and auto-boosts pulse intensity', () => {
    const dsp = new AudioDsp();
    const verse = makeToneBuffers(28, 25, 0.07);
    const chorus = makeToneBuffers(195, 160, 0.55);

    for (let i = 0; i < 180; i++) {
      dsp.processLive(verse.freq, verse.time, 48000, 2048, 1 / 60, i * 16.67);
    }
    const startColor = dsp.frame.colorIndex;
    const versePulse = dsp.frame.autoPulse;

    let dropPeak = 0;
    let maxPulse = versePulse;
    for (let i = 180; i < 270; i++) {
      const f = dsp.processLive(chorus.freq, chorus.time, 48000, 2048, 1 / 60, i * 16.67);
      if (f.drop > dropPeak) dropPeak = f.drop;
      if (f.autoPulse > maxPulse) maxPulse = f.autoPulse;
    }

    expect(dropPeak).toBeGreaterThan(0.5);
    expect(maxPulse).toBeGreaterThan(versePulse + 0.12);
    expect(Math.abs(dsp.frame.colorIndex - startColor)).toBeGreaterThan(0.25);
  });

  it('maps a 440 Hz tone to Chroma pitch-class A (index 9) with high tonality vs broadband noise', () => {
    const dsp = new AudioDsp();
    const sampleRate = 48000;
    const fftSize = 2048;
    const binHz = sampleRate / fftSize;
    const a4Bin = Math.round(440 / binHz); // bin 19 (~445 Hz -> MIDI 69 = A4)

    const tonalFreq = new Uint8Array(1024);
    tonalFreq[a4Bin] = 220;
    const time = new Uint8Array(2048);
    for (let i = 0; i < time.length; i++) {
      time[i] = Math.round(128 + Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 80);
    }

    let frame = dsp.frame;
    for (let i = 0; i < 45; i++) {
      frame = dsp.processLive(tonalFreq, time, sampleRate, fftSize, 1 / 60, i * 16.67);
    }

    let maxChromaIdx = 0;
    for (let c = 1; c < 12; c++) {
      if (frame.chroma[c] > frame.chroma[maxChromaIdx]) maxChromaIdx = c;
    }
    expect(maxChromaIdx).toBe(9); // A
    expect(frame.chroma[9]).toBeGreaterThan(0.5);
    expect(frame.tonality).toBeGreaterThan(0.7);

    // Broadband flat noise -> low tonality
    const noiseFreq = new Uint8Array(1024).fill(120);
    const dspNoise = new AudioDsp();
    for (let i = 0; i < 45; i++) {
      frame = dspNoise.processLive(noiseFreq, time, sampleRate, fftSize, 1 / 60, i * 16.67);
    }
    expect(frame.tonality).toBeLessThan(0.35);
  });

  it('tracks stereo balance, stereo width, floating peak-hold, and kick shockwave rings', () => {
    const dsp = new AudioDsp();
    const { freq, time } = makeToneBuffers(160, 80, 0.35);
    const leftFreq = new Uint8Array(AUDIO_TEX_WIDTH).fill(180);
    const rightFreq = new Uint8Array(AUDIO_TEX_WIDTH).fill(20);
    const leftTime = new Uint8Array(AUDIO_TEX_WIDTH);
    const rightTime = new Uint8Array(AUDIO_TEX_WIDTH).fill(128);
    for (let i = 0; i < AUDIO_TEX_WIDTH; i++) {
      leftTime[i] = Math.round(128 + Math.sin(i * 0.3) * 90);
    }

    // Feed quiet baseline then strong left-panned kick
    const quiet = makeToneBuffers(16, 16, 0.04);
    for (let i = 0; i < 40; i++) {
      dsp.processLive(quiet.freq, quiet.time, 48000, 2048, 1 / 60, i * 16.67);
    }

    let frame = dsp.frame;
    for (let i = 40; i < 65; i++) {
      frame = dsp.processLive(freq, time, 48000, 2048, 1 / 60, i * 16.67, {
        leftFreqBins: leftFreq,
        rightFreqBins: rightFreq,
        leftTimeBins: leftTime,
        rightTimeBins: rightTime,
        stereoWidth: 0.75,
        stereoBalance: -0.8,
      });
    }

    expect(frame.stereoBalance).toBeLessThan(-0.4);
    expect(frame.stereoWidth).toBeGreaterThan(0.4);
    // At least one kick shockwave ring was launched and is actively traveling (0..1)
    expect(Array.from(frame.kickWaves).some((age) => age > 0 && age < 1.0)).toBe(true);
    // History row green channel encodes left pan (< 120)
    expect(frame.historyRow[10 * 4 + 1]).toBeLessThan(110);

    // Drop to silence for a few frames: gravity peak-hold row (row 1) should stay above live FFT (row 0)
    const silent = makeSilentBuffers();
    for (let i = 65; i < 72; i++) {
      frame = dsp.processLive(silent.freq, silent.time, 48000, 2048, 1 / 60, i * 16.67);
    }
    const liveBin = frame.textureData[40];
    const peakBin = frame.textureData[AUDIO_TEX_WIDTH * 1 + 40];
    expect(peakBin).toBeGreaterThan(liveBin);
  });
});
