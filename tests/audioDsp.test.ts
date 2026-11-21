import { describe, expect, it } from 'vitest';
import { AudioDsp } from '../src/audio/dsp';

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
});
