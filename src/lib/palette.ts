import type { RGB, ThemePalette } from '@shared/types';

/**
 * Fallback palette before a Spotify track with album art is playing.
 */
export const DEFAULT_PALETTE: ThemePalette = {
  backdrop: { r: 0.015, g: 0.025, b: 0.045 },
  color1: { r: 0.08, g: 0.88, b: 0.48 },
  color2: { r: 0.14, g: 0.72, b: 0.94 },
  color3: { r: 0.46, g: 0.28, b: 0.94 },
  darkStage: 0.55,
};

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
      break;
  }
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const hue = ((h % 1) + 1) % 1;
  if (s <= 0.001) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: hue2rgb(hue + 1 / 3),
    g: hue2rgb(hue),
    b: hue2rgb(hue - 1 / 3),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2);
  return Math.min(d, 1 - d);
}

/**
 * Estimates how strongly a color visually "glows" and jumps into the human eye (0..1).
 * Vivid reds, magentas, electric cyans, and bright golds score high; dull browns, tans,
 * and dark muted earth tones score low so a small glowing accent naturally outshines a
 * large dull brown background.
 */
export function computePerceptualGlow(
  r: number,
  g: number,
  b: number,
  h: number,
  s: number,
  chroma: number
): number {
  const maxC = Math.max(r, g, b);
  const baseGlow =
    Math.pow(clamp(chroma, 0, 1), 2.2) * (0.28 + 0.72 * maxC) * (0.35 + 0.65 * s);

  // Dull earth tones (brown / tan / muddy olive) sit in orange-yellow hues with low brightness or saturation
  const inEarthHue = h >= 0.032 && h <= 0.22;
  const lowBrightness = clamp((0.72 - maxC) / 0.34, 0, 1);
  const lowSat = clamp((0.58 - s) / 0.28, 0, 1);
  const brownDamp = inEarthHue
    ? 1 - 0.68 * Math.max(lowBrightness * 0.85, lowSat * 0.75)
    : 1;

  // Helmholtz–Kohlrausch visual salience boost for vivid eye-catching hues (red, magenta, electric cyan)
  const redPop = Math.max(0, 1 - hueDistance(h, 0.0) / 0.065);
  const magentaPop = Math.max(0, 1 - hueDistance(h, 0.9) / 0.08);
  const cyanPop = Math.max(0, 1 - hueDistance(h, 0.52) / 0.07);
  const huePop = Math.max(redPop * 0.42, magentaPop * 0.28, cyanPop * 0.2);
  const popBoost =
    1 +
    huePop *
      clamp((chroma - 0.45) / 0.35, 0, 1) *
      clamp((maxC - 0.55) / 0.35, 0, 1);

  return clamp(baseGlow * brownDamp * popBoost, 0, 1);
}

/**
 * Keeps a genuine chromatic album color faithful to its real hue AND its natural "glow":
 * glowing reds/golds/blues stay vibrant and luminous, while genuinely dull earth tones
 * (like brown on an all-brown cover) stay calm and understated instead of turning neon orange.
 */
function toTrueCoverChromatic(h: number, s: number, l: number, avgGlow: number): RGB {
  const glowFactor = clamp(avgGlow / 0.42, 0, 1);
  const targetS =
    (1 - glowFactor) * clamp(s * 0.96, 0.18, 0.56) +
    glowFactor * clamp(s * 1.12, Math.min(0.66, s), 0.98);
  const targetL =
    (1 - glowFactor) * clamp(l * 0.62 + 0.14, 0.28, 0.44) +
    glowFactor * clamp(l * 0.46 + 0.29, 0.45, 0.60);
  return hslToRgb(h, targetS, targetL);
}

interface ChromaticCluster {
  pixelCount: number;
  weight: number;
  avgGlow: number;
  h: number;
  s: number;
  l: number;
}

/**
 * Perceptual surface + glow-weighted accent palette extractor:
 * - Recognizes TRUE BLACK backgrounds (preserving real black negative space on covers like
 *   Daft Punk's Random Access Memories, Ren's Sick Boi, or pure B&W covers).
 * - Recognizes TRUE WHITE / SILVER neutral highlights without tinting them blue or green.
 * - Weights colors by perceptual "glow" (visual salience), so eye-catching glowing accents
 *   like vivid red jump to the foreground even over a much larger dull brown background.
 * - Rejects tiny JPEG/shadow chroma smudges so B&W covers stay purely Black & White/Silver.
 */
export function extractPaletteFromRgba(data: Uint8ClampedArray): ThemePalette {
  const NUM_BUCKETS = 36;
  const buckets = Array.from({ length: NUM_BUCKETS }, () => ({
    pixelCount: 0,
    weight: 0,
    glowSum: 0,
    hSumCos: 0,
    hSumSin: 0,
    sSum: 0,
    lSum: 0,
  }));

  let validPixels = 0;
  let blackPixels = 0;
  let whiteSilverPixels = 0;
  let whiteSilverLumSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    validPixels++;

    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    const [h, s, l] = rgbToHsl(r, g, b);

    // 1. Dark / Jet Black surface
    if (l < 0.16 || (l < 0.23 && chroma < 0.08)) {
      blackPixels++;
      continue;
    }

    // 2. Neutral White / Silver / Light Gray surface (low chroma — NEVER treat as blue/green!)
    if (chroma < 0.12 || s < 0.20) {
      if (l >= 0.28) {
        whiteSilverPixels++;
        whiteSilverLumSum += l;
      } else {
        blackPixels++;
      }
      continue;
    }

    // 3. Genuine chromatic pixel weighted by perceptual "glow" (vivid red pops far above dull brown)
    const idx = Math.min(NUM_BUCKETS - 1, Math.floor(h * NUM_BUCKETS));
    const bucket = buckets[idx];
    const glow = computePerceptualGlow(r, g, b, h, s, chroma);
    const weight = 0.035 + glow * 4.2;
    const angle = h * Math.PI * 2;

    bucket.pixelCount += 1;
    bucket.weight += weight;
    bucket.glowSum += glow;
    bucket.hSumCos += Math.cos(angle) * weight;
    bucket.hSumSin += Math.sin(angle) * weight;
    bucket.sSum += s * weight;
    bucket.lSum += l * weight;
  }

  if (validPixels === 0) return DEFAULT_PALETTE;

  const blackRatio = blackPixels / validPixels;
  const whiteSilverRatio = whiteSilverPixels / validPixels;
  const avgSilverLum =
    whiteSilverPixels > 0 ? clamp(whiteSilverLumSum / whiteSilverPixels, 0.58, 0.96) : 0.88;

  // Group contiguous chromatic hue buckets into distinct color peaks
  const mergedClusters: ChromaticCluster[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    const curr = buckets[i];
    if (curr.pixelCount === 0) continue;
    const prev = buckets[(i + NUM_BUCKETS - 1) % NUM_BUCKETS];
    const next = buckets[(i + 1) % NUM_BUCKETS];

    const totalPx = curr.pixelCount + prev.pixelCount * 0.5 + next.pixelCount * 0.5;
    const totalW = curr.weight + prev.weight * 0.5 + next.weight * 0.5;
    const totalGlow = curr.glowSum + prev.glowSum * 0.5 + next.glowSum * 0.5;
    const cosSum = curr.hSumCos + prev.hSumCos * 0.5 + next.hSumCos * 0.5;
    const sinSum = curr.hSumSin + prev.hSumSin * 0.5 + next.hSumSin * 0.5;
    const angle = Math.atan2(sinSum, cosSum);

    mergedClusters.push({
      pixelCount: totalPx,
      weight: totalW,
      avgGlow: totalPx > 0 ? totalGlow / totalPx : 0,
      h: ((angle / (Math.PI * 2)) + 1) % 1,
      s: curr.sSum / curr.weight,
      l: curr.lSum / curr.weight,
    });
  }

  mergedClusters.sort((a, b) => b.weight - a.weight);

  // Deduplicate peaks within 28 degrees and apply glow-aware area threshold:
  // blazing glowing accents (red/neon) register down to 1.4%, dull tones need >= 2.4%,
  // while <= 1% B&W JPEG artifacts are always rejected!
  const candidateChromatics: ChromaticCluster[] = [];
  for (const c of mergedClusters) {
    const area = c.pixelCount / validPixels;
    const minArea = c.avgGlow >= 0.35 ? 0.014 : 0.024;
    if (area < minArea) continue;
    if (candidateChromatics.some((existing) => hueDistance(existing.h, c.h) < 0.08)) continue;
    candidateChromatics.push(c);
    if (candidateChromatics.length >= 4) break;
  }

  // If the cover has a strong glowing focal color (e.g. vivid red), keep ultra-dull background
  // earth tones (e.g. brown walls/skin) in the subtle backdrop instead of muddying the foreground cycle!
  let dullBackdropCluster: ChromaticCluster | null = null;
  let realChromatics = candidateChromatics;
  if (candidateChromatics.length >= 2) {
    const topGlow = candidateChromatics[0].avgGlow;
    if (topGlow >= 0.28) {
      const vividOnes: ChromaticCluster[] = [];
      for (const c of candidateChromatics) {
        if (c.avgGlow < 0.08 && c.avgGlow < topGlow * 0.22) {
          if (!dullBackdropCluster || c.pixelCount > dullBackdropCluster.pixelCount) {
            dullBackdropCluster = c;
          }
        } else {
          vividOnes.push(c);
        }
      }
      if (vividOnes.length > 0) {
        realChromatics = vividOnes;
      }
    }
  }
  realChromatics = realChromatics.slice(0, 3);

  // Neutral pure white & brushed metallic silver swatches (0% saturation — NEVER blue or green!)
  const crispWhite: RGB = { r: 0.95, g: 0.95, b: 0.96 };
  const metallicSilver: RGB = {
    r: clamp(avgSilverLum * 0.95, 0.72, 0.94),
    g: clamp(avgSilverLum * 0.95, 0.72, 0.94),
    b: clamp(avgSilverLum * 0.96, 0.73, 0.95),
  };
  const softCharcoalSilver: RGB = { r: 0.70, g: 0.71, b: 0.73 };
  const jetBlack: RGB = { r: 0.008, g: 0.008, b: 0.01 };

  // How strongly black negative space defines this cover
  let darkStage = 0.14;
  if (blackRatio >= 0.40) {
    darkStage = clamp(0.76 + (blackRatio - 0.40) * 0.65, 0.76, 1.0);
  } else if (blackRatio >= 0.24) {
    darkStage = clamp(0.38 + (blackRatio - 0.24) * 2.3, 0.38, 0.75);
  }

  // CASE 1: Pure Black & White / Silver album cover (zero genuine chromatic accents!)
  if (realChromatics.length === 0) {
    return {
      backdrop: jetBlack,
      color1: crispWhite,
      color2: metallicSilver,
      color3: softCharcoalSilver,
      darkStage: Math.max(0.86, darkStage),
    };
  }

  // Build ordered list of the cover's genuine individual accent colors
  const c0 = realChromatics[0];
  const colorA = toTrueCoverChromatic(c0.h, c0.s, c0.l, c0.avgGlow);
  const hasSignificantWhiteSilver = whiteSilverRatio >= 0.065;

  // Adapt background prominence to how much the dominant cover color naturally "glows":
  // dull earthy covers (low avgGlow) sit calmer & deeper; glowing reds/golds shine vividly!
  if (c0.avgGlow < 0.14) {
    darkStage = Math.max(darkStage, clamp(0.46 - c0.avgGlow * 1.8, 0.22, 0.46));
  } else if (dullBackdropCluster && dullBackdropCluster.pixelCount / validPixels > 0.35) {
    // Large dull background with a sharp glowing accent (e.g. brown scene + glowing red focal point):
    // deepen the stage slightly so the glowing red pops cleanly!
    darkStage = Math.max(darkStage, 0.44);
  }

  // Determine backdrop: true jet black if dark cover, deep dull-surface tint if present, else deep cover tint
  const backdropSource = dullBackdropCluster ?? c0;
  const backdrop: RGB =
    darkStage >= 0.65
      ? jetBlack
      : hslToRgb(
          backdropSource.h,
          clamp(backdropSource.s * 0.65, 0.18, 0.65),
          dullBackdropCluster ? 0.04 : 0.045
        );

  // CASE 2: 1 real chromatic color (e.g., Black + Gold + Silver on RAM, Black + Red on Sick Boi, or Brown + Glowing Red)
  if (realChromatics.length === 1) {
    if (hasSignificantWhiteSilver) {
      const warmLuminous = hslToRgb(
        c0.h,
        clamp(c0.s * 0.85, 0.40, 0.92),
        clamp(c0.l * 0.4 + 0.44, 0.54, 0.72)
      );
      return {
        backdrop,
        color1: colorA,
        color2: metallicSilver,
        color3: warmLuminous,
        darkStage,
      };
    }

    const glowFactor = clamp(c0.avgGlow / 0.42, 0, 1);
    const richDeepAccent = hslToRgb(
      c0.h,
      clamp(c0.s * (0.95 + glowFactor * 0.2), 0.22, 0.98),
      0.26 + glowFactor * 0.13
    );
    const brightAccent = hslToRgb(
      c0.h,
      clamp(c0.s * 0.92, 0.22, 0.95),
      0.42 + glowFactor * 0.20
    );
    return {
      backdrop,
      color1: colorA,
      color2: brightAccent,
      color3: richDeepAccent,
      darkStage,
    };
  }

  // CASE 3: 2+ genuine chromatic colors (plus optional White/Silver!)
  const c1 = realChromatics[1];
  const colorB = toTrueCoverChromatic(c1.h, c1.s, c1.l, c1.avgGlow);

  let colorC: RGB;
  if (realChromatics.length >= 3) {
    const c2 = realChromatics[2];
    colorC = toTrueCoverChromatic(c2.h, c2.s, c2.l, c2.avgGlow);
  } else if (hasSignificantWhiteSilver) {
    colorC = metallicSilver;
  } else {
    const glowFactor = clamp(c0.avgGlow / 0.42, 0, 1);
    colorC = hslToRgb(c0.h, clamp(c0.s * 0.92, 0.25, 0.95), 0.44 + glowFactor * 0.18);
  }

  return {
    backdrop,
    color1: colorA,
    color2: colorB,
    color3: colorC,
    darkStage,
  };
}

export async function extractPaletteFromDataUrl(dataUrl: string): Promise<ThemePalette> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(DEFAULT_PALETTE);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        resolve(extractPaletteFromRgba(data));
      } catch {
        resolve(DEFAULT_PALETTE);
      }
    };
    img.onerror = () => resolve(DEFAULT_PALETTE);
    img.src = dataUrl;
  });
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: lerpNum(a.r, b.r, t),
    g: lerpNum(a.g, b.g, t),
    b: lerpNum(a.b, b.b, t),
  };
}

export function lerpPalette(a: ThemePalette, b: ThemePalette, t: number): ThemePalette {
  return {
    backdrop: lerpRgb(a.backdrop, b.backdrop, t),
    color1: lerpRgb(a.color1, b.color1, t),
    color2: lerpRgb(a.color2, b.color2, t),
    color3: lerpRgb(a.color3, b.color3, t),
    darkStage: lerpNum(a.darkStage, b.darkStage, t),
  };
}

function mixCoverColorJs(a: RGB, b: RGB, t: number): RGB {
  const [ha, sa, la] = rgbToHsl(a.r, a.g, a.b);
  const [hb, sb, lb] = rgbToHsl(b.r, b.g, b.b);
  // Neutral white/silver transitions smoothly in RGB without inventing fake rainbow hues
  if (sa < 0.22 || sb < 0.22) {
    return lerpRgb(a, b, t);
  }
  let dh = hb - ha;
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  const h = (ha + dh * t + 1) % 1;
  return hslToRgb(h, lerpNum(sa, sb, t), lerpNum(la, lb, t));
}

export function sampleMoodColor(
  palette: ThemePalette,
  colorIndex: number,
  colorCycle: boolean
): RGB {
  if (!colorCycle) return palette.color1;
  const wrapped = ((colorIndex % 3) + 3) % 3;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  if (wrapped < 1) {
    return mixCoverColorJs(palette.color1, palette.color2, smooth(wrapped));
  }
  if (wrapped < 2) {
    return mixCoverColorJs(palette.color2, palette.color3, smooth(wrapped - 1));
  }
  return mixCoverColorJs(palette.color3, palette.color1, smooth(wrapped - 2));
}

export function rgbToCss(rgb: RGB, alpha = 1): string {
  const r = Math.round(clamp(rgb.r, 0, 1) * 255);
  const g = Math.round(clamp(rgb.g, 0, 1) * 255);
  const b = Math.round(clamp(rgb.b, 0, 1) * 255);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function parseHexColor(hex: string): RGB {
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[a-f0-9]{6}$/i.test(cleaned)) {
    return { r: 0.04, g: 0.05, b: 0.08 };
  }
  return {
    r: parseInt(cleaned.slice(0, 2), 16) / 255,
    g: parseInt(cleaned.slice(2, 4), 16) / 255,
    b: parseInt(cleaned.slice(4, 6), 16) / 255,
  };
}

export function isLightColor(rgb: RGB): boolean {
  const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return lum > 0.62;
}

/**
 * Builds a clean, faithful shader & blank-background palette from a user-selected hex color.
 * Keeps the exact chosen hue/shade intact (including pure black, neutral charcoal/white, or vivid colors).
 */
export function paletteFromCustomHex(hex: string): ThemePalette {
  const rgb = parseHexColor(hex);
  const [h, s, l] = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // Near-black custom color: pure dark backdrop with understated neutral silver accents
  if (l < 0.09) {
    return {
      backdrop: rgb,
      color1: { r: 0.78, g: 0.80, b: 0.84 },
      color2: { r: 0.56, g: 0.59, b: 0.64 },
      color3: { r: 0.90, g: 0.91, b: 0.94 },
      darkStage: 0.96,
    };
  }

  // Neutral gray / white custom color: pure monochrome (zero fake tint!)
  if (s < 0.12) {
    const brighter = clamp(l + 0.14, 0.35, 0.96);
    const deeper = clamp(l - 0.16, 0.12, 0.78);
    return {
      backdrop: { r: rgb.r * 0.18, g: rgb.g * 0.18, b: rgb.b * 0.18 },
      color1: rgb,
      color2: { r: brighter, g: brighter, b: brighter },
      color3: { r: deeper, g: deeper, b: deeper },
      darkStage: l < 0.35 ? 0.8 : 0.45,
    };
  }

  // Colored custom hex: preserve exact chosen hue; lift dark swatches for luminous shader glow & UI highlights
  const darkStage = l < 0.28 ? 0.72 : 0.38;
  const accentL = clamp(l < 0.36 ? l * 0.55 + 0.32 : l, 0.38, 0.66);
  return {
    backdrop: l < 0.26 ? rgb : hslToRgb(h, clamp(s * 0.8, 0.2, 0.85), clamp(l * 0.22, 0.02, 0.14)),
    color1: hslToRgb(h, clamp(s * 1.05, 0.3, 0.96), accentL),
    color2: hslToRgb(h, clamp(s * 0.88, 0.25, 0.95), clamp(accentL + 0.14, 0.44, 0.78)),
    color3: hslToRgb(h, clamp(s * 1.05, 0.3, 1.0), clamp(accentL - 0.14, 0.24, 0.56)),
    darkStage,
  };
}
