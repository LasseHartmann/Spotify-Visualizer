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

  it('phase-locks the packed oscilloscope waveform on a center-origin rising zero-crossing', () => {
    const dsp = new AudioDsp();
    const freq = new Uint8Array(1024);
    freq[3] = 140;
    freq[4] = 120;

    // Shifted sine wave starting out of phase (cos wave) so trigger must center the rising zero-crossing at x=128
    const time = new Uint8Array(2048);
    for (let i = 0; i < time.length; i++) {
      const val = Math.cos((i / 256) * Math.PI * 2) * 0.65;
      time[i] = Math.max(0, Math.min(255, Math.round(128 + val * 127)));
    }

    let frame = dsp.frame;
    for (let i = 0; i < 15; i++) {
      frame = dsp.processLive(freq, time, 48000, 2048, 1 / 60, i * 16.67);
    }

    // Center midpoint (u=0.5, Y-axis origin) crosses 0V (128) going upward from negative to positive
    const wBefore = frame.textureData[256 + 112];
    const wCenter = frame.textureData[256 + 128];
    const wAfter = frame.textureData[256 + 144];
    expect(wBefore).toBeLessThan(115);
    expect(wCenter).toBeGreaterThanOrEqual(115);
    expect(wCenter).toBeLessThanOrEqual(145);
    expect(wAfter).toBeGreaterThan(155);
  });

  it('tracks gravity-falling peak-hold caps in row 2 for Bars mode', () => {
    const dsp = new AudioDsp();
    const loud = makeToneBuffers(210, 140, 0.5);
    const silent = makeSilentBuffers();

    let frame = dsp.frame;
    for (let i = 0; i < 20; i++) {
      frame = dsp.processLive(loud.freq, loud.time, 48000, 2048, 1 / 60, i * 16.67);
    }
    const peakAtHit = frame.textureData[512 + 50];
    expect(peakAtHit).toBeGreaterThan(120);

    // Immediately after audio drops to silence, peak cap holds above the falling bar
    for (let i = 20; i < 26; i++) {
      frame = dsp.processLive(silent.freq, silent.time, 48000, 2048, 1 / 60, i * 16.67);
    }
    expect(frame.textureData[512 + 50]).toBeGreaterThan(frame.textureData[50]);

    // After gravity fall (~1.5s), peak cap decays cleanly toward zero
    for (let i = 26; i < 120; i++) {
      frame = dsp.processLive(silent.freq, silent.time, 48000, 2048, 1 / 60, i * 16.67);
    }
    expect(frame.textureData[512 + 50]).toBeLessThan(20);
  });
});
