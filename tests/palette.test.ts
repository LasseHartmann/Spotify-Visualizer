import { describe, expect, it } from 'vitest';
import {
  computePerceptualGlow,
  extractPaletteFromRgba,
  isLightColor,
  paletteFromCustomHex,
  parseHexColor,
  sampleMoodColor,
} from '../src/lib/palette';

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

  it('lets a small glowing red accent dominate over a much larger dull brown background', () => {
    const brownWithGlowingRed = makeImageFromRegions([
      { ratio: 0.72, rgb: [112, 82, 58] },      // Large dull brown surface
      { ratio: 0.22, rgb: [68, 52, 40] },       // Dark brown shadow
      { ratio: 0.06, rgb: [235, 24, 30] },      // Small eye-catching glowing red accent
    ]);

    const pal = extractPaletteFromRgba(brownWithGlowingRed);
    // Glowing red MUST win color1 (vivid high R, low G & B) even at just 6% area!
    expect(pal.color1.r).toBeGreaterThan(0.82);
    expect(pal.color1.g).toBeLessThan(0.24);
    expect(pal.color1.b).toBeLessThan(0.24);
    // Dull brown stays subtly in the deep backdrop instead of turning foreground muddy brown
    expect(pal.color2.r).toBeGreaterThan(0.75);
    expect(pal.color2.g).toBeLessThan(0.35);
  });

  it('keeps an all-brown cover understated and earthy rather than glowing neon orange', () => {
    const allBrownCover = makeImageFromRegions([
      { ratio: 0.70, rgb: [110, 78, 52] },      // Muted brown
      { ratio: 0.30, rgb: [72, 50, 34] },       // Darker wood brown
    ]);

    const pal = extractPaletteFromRgba(allBrownCover);
    // Red > Green > Blue (warm brown), yet restrained luminance & calmer darkStage
    expect(pal.color1.r).toBeGreaterThan(pal.color1.g);
    expect(pal.color1.g).toBeGreaterThan(pal.color1.b);
    expect(pal.color1.r).toBeLessThan(0.62);
    expect(pal.darkStage).toBeGreaterThan(0.35);
  });

  it('scores vivid red far higher in perceptual glow than dull brown', () => {
    const redGlow = computePerceptualGlow(235 / 255, 24 / 255, 30 / 255, 0.997, 0.84, 0.83);
    const brownGlow = computePerceptualGlow(112 / 255, 82 / 255, 58 / 255, 0.074, 0.32, 0.21);
    expect(redGlow).toBeGreaterThan(0.65);
    expect(brownGlow).toBeLessThan(0.03);
    expect(redGlow / brownGlow).toBeGreaterThan(25);
  });
});

describe('custom background colors', () => {
  it('parses hex colors and detects light vs dark backdrops accurately', () => {
    const black = parseHexColor('#000000');
    expect(black).toEqual({ r: 0, g: 0, b: 0 });
    expect(isLightColor(black)).toBe(false);

    const paper = parseHexColor('#f4f4f6');
    expect(paper.r).toBeGreaterThan(0.95);
    expect(isLightColor(paper)).toBe(true);
  });

  it('builds a clean monochrome palette for pure black and white custom hex without fake tints', () => {
    const blackPal = paletteFromCustomHex('#000000');
    expect(blackPal.backdrop).toEqual({ r: 0, g: 0, b: 0 });
    expect(blackPal.darkStage).toBeGreaterThan(0.9);
    expect(Math.abs(blackPal.color1.r - blackPal.color1.b)).toBeLessThan(0.08);

    const navyPal = paletteFromCustomHex('#0f1d40');
    expect(navyPal.color1.b).toBeGreaterThan(navyPal.color1.r);
    expect(navyPal.backdrop.b).toBeGreaterThan(navyPal.backdrop.r);
  });
});
