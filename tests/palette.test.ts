import { describe, expect, it } from 'vitest';
import { extractPaletteFromRgba, sampleMoodColor } from '../src/lib/palette';

function makeImageFromRegions(
  regions: Array<{ ratio: number; rgb: [number, number, number] }>,
  size = 40
): Uint8ClampedArray {
  const total = size * size;
  const buf = new Uint8ClampedArray(total * 4);
  let px = 0;
  for (let rIdx = 0; rIdx < regions.length; rIdx++) {
    const count =
      rIdx === regions.length - 1
        ? total - px
        : Math.round(regions[rIdx].ratio * total);
    const [r, g, b] = regions[rIdx].rgb;
    for (let k = 0; k < count && px < total; k++, px++) {
      buf[px * 4] = r;
      buf[px * 4 + 1] = g;
      buf[px * 4 + 2] = b;
      buf[px * 4 + 3] = 255;
    }
  }
  return buf;
}

describe('extractPaletteFromRgba', () => {
  it('keeps black & white covers purely black and neutral white/silver even with a tiny 1% blue/green tint', () => {
    const bwWithTinyTint = makeImageFromRegions([
      { ratio: 0.62, rgb: [10, 10, 11] },       // Black
      { ratio: 0.25, rgb: [232, 232, 234] },    // White
      { ratio: 0.12, rgb: [148, 152, 158] },    // Slightly cool silver/gray shadow
      { ratio: 0.01, rgb: [20, 160, 210] },     // 1% stray cyan/blue artifact
    ]);

    const pal = extractPaletteFromRgba(bwWithTinyTint);
    expect(pal.darkStage).toBeGreaterThan(0.8);
    expect(pal.backdrop.r).toBeLessThan(0.03);
    expect(pal.backdrop.b).toBeLessThan(0.03);

    // color1 & color2 must be neutral white/silver (R, G, B nearly equal — NO blue/green!)
    expect(Math.abs(pal.color1.r - pal.color1.b)).toBeLessThan(0.05);
    expect(Math.abs(pal.color1.r - pal.color1.g)).toBeLessThan(0.05);
    expect(pal.color1.r).toBeGreaterThan(0.85);
    expect(Math.abs(pal.color2.r - pal.color2.b)).toBeLessThan(0.05);
  });

  it('extracts Black + Gold + Silver for a Random Access Memories style cover', () => {
    const ramCover = makeImageFromRegions([
      { ratio: 0.72, rgb: [8, 8, 9] },          // Jet Black backdrop
      { ratio: 0.14, rgb: [215, 218, 222] },    // Silver chrome helmet
      { ratio: 0.14, rgb: [218, 168, 48] },     // Warm Gold helmet
    ]);

    const pal = extractPaletteFromRgba(ramCover);
    // True black stage
    expect(pal.darkStage).toBeGreaterThan(0.8);
    expect(pal.backdrop.r).toBeLessThan(0.03);
    // Primary = Warm Gold (high R, medium-high G, low B)
    expect(pal.color1.r).toBeGreaterThan(0.75);
    expect(pal.color1.g).toBeGreaterThan(0.50);
    expect(pal.color1.b).toBeLessThan(0.35);
    // Secondary = Neutral Silver/White (R ≈ G ≈ B, bright)
    expect(Math.abs(pal.color2.r - pal.color2.b)).toBeLessThan(0.05);
    expect(pal.color2.r).toBeGreaterThan(0.72);
  });

  it('extracts Black + Bold Red for a Sick Boi style cover instead of flooding everything red', () => {
    const sickBoiCover = makeImageFromRegions([
      { ratio: 0.78, rgb: [12, 10, 10] },       // Black background
      { ratio: 0.22, rgb: [212, 22, 28] },      // Stark Crimson Red
    ]);

    const pal = extractPaletteFromRgba(sickBoiCover);
    expect(pal.darkStage).toBeGreaterThan(0.85);
    expect(pal.backdrop.r).toBeLessThan(0.03);
    expect(pal.color1.r).toBeGreaterThan(0.80);
    expect(pal.color1.g).toBeLessThan(0.25);
    expect(pal.color1.b).toBeLessThan(0.25);
  });

  it('extracts both real colors from a dual-color blue & gold cover and locks cleanly in Color Lock', () => {
    const dualCover = makeImageFromRegions([
      { ratio: 0.60, rgb: [20, 75, 220] },
      { ratio: 0.40, rgb: [240, 185, 20] },
    ]);

    const pal = extractPaletteFromRgba(dualCover);
    expect(pal.color1.b).toBeGreaterThan(0.75);
    expect(pal.color2.r).toBeGreaterThan(0.75);
    expect(pal.color2.g).toBeGreaterThan(0.55);

    expect(sampleMoodColor(pal, 0.0, false)).toEqual(pal.color1);
    expect(sampleMoodColor(pal, 1.5, false)).toEqual(pal.color1);
  });
});
