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
 * Keeps a genuine chromatic album color true to its real hue & character
 * (warm gold stays metallic gold, crimson stays bold red — never artificially neon-shifted).
 */
function toTrueCoverChromatic(h: number, s: number, l: number): RGB {
  const cleanS = clamp(s * 1.15, Math.min(0.62, s), 0.96);
  const cleanL = clamp(l * 0.45 + 0.30, 0.44, 0.60);
  return hslToRgb(h, cleanS, cleanL);
}

interface ChromaticCluster {
  pixelCount: number;
  weight: number;
  h: number;
  s: number;
  l: number;
}

/**
 * Perceptual surface + accent palette extractor:
 * - Recognizes TRUE BLACK backgrounds (preserving real black negative space on covers like
 *   Daft Punk's Random Access Memories, Ren's Sick Boi, or pure B&W covers).
 * - Recognizes TRUE WHITE / SILVER neutral highlights without tinting them blue or green.
 * - Rejects tiny <2.2% JPEG/shadow chroma smudges so B&W covers stay purely Black & White/Silver.
 * - Extracts the actual individual colors present on the cover (e.g. Black + Gold + Silver, or Black + Red).
 */
export function extractPaletteFromRgba(data: Uint8ClampedArray): ThemePalette {
  const NUM_BUCKETS = 36;
  const buckets = Array.from({ length: NUM_BUCKETS }, () => ({
    pixelCount: 0,
    weight: 0,
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

    // 3. Genuine chromatic pixel (unmistakable visual color: chroma >= 0.12 AND s >= 0.20)
    const idx = Math.min(NUM_BUCKETS - 1, Math.floor(h * NUM_BUCKETS));
    const bucket = buckets[idx];
    const lightBoost = 1 - Math.abs(l - 0.50) * 0.9;
    const weight = (0.45 + chroma * 1.1) * Math.max(0.3, lightBoost);
    const angle = h * Math.PI * 2;

    bucket.pixelCount += 1;
    bucket.weight += weight;
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

  // Group contiguous chromatic hue buckets into real distinct color peaks
  const mergedClusters: ChromaticCluster[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    const curr = buckets[i];
    if (curr.pixelCount === 0) continue;
    const prev = buckets[(i + NUM_BUCKETS - 1) % NUM_BUCKETS];
    const next = buckets[(i + 1) % NUM_BUCKETS];

    // Local peak check (or merge neighboring bins)
    const totalPx = curr.pixelCount + prev.pixelCount * 0.5 + next.pixelCount * 0.5;
    const totalW = curr.weight + prev.weight * 0.5 + next.weight * 0.5;
    const cosSum = curr.hSumCos + prev.hSumCos * 0.5 + next.hSumCos * 0.5;
    const sinSum = curr.hSumSin + prev.hSumSin * 0.5 + next.hSumSin * 0.5;
    const angle = Math.atan2(sinSum, cosSum);

    mergedClusters.push({
      pixelCount: totalPx,
      weight: totalW,
      h: ((angle / (Math.PI * 2)) + 1) % 1,
      s: curr.sSum / curr.weight,
      l: curr.lSum / curr.weight,
    });
  }

  mergedClusters.sort((a, b) => b.weight - a.weight);

  // Deduplicate peaks within 28 degrees and enforce a real >= 2.2% area threshold
  // (keeps intentional accents like RAM's gold helmet & Sick Boi's red, rejects 0.5% B&W JPEG tint!)
  const MIN_CHROMATIC_AREA = 0.022;
  const realChromatics: ChromaticCluster[] = [];
  for (const c of mergedClusters) {
    if (c.pixelCount / validPixels < MIN_CHROMATIC_AREA) continue;
    if (realChromatics.some((existing) => hueDistance(existing.h, c.h) < 0.08)) continue;
    realChromatics.push(c);
    if (realChromatics.length >= 3) break;
  }

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
  const colorA = toTrueCoverChromatic(c0.h, c0.s, c0.l);
  const hasSignificantWhiteSilver = whiteSilverRatio >= 0.065;

  // Determine backdrop: true jet black if dark cover, else ultra-deep cover tint
  const backdrop: RGB =
    darkStage >= 0.65
      ? jetBlack
      : hslToRgb(c0.h, clamp(c0.s * 0.7, 0.25, 0.75), 0.045);

  // CASE 2: 1 real chromatic color (e.g., Black + Gold + Silver on RAM, or Black + Red on Sick Boi!)
  if (realChromatics.length === 1) {
    if (hasSignificantWhiteSilver) {
      // E.g. Random Access Memories (Black + Gold + Silver) or Black + Red + White
      const warmLuminous = hslToRgb(c0.h, clamp(c0.s * 0.85, 0.45, 0.92), clamp(c0.l * 0.4 + 0.44, 0.56, 0.72));
      return {
        backdrop,
        color1: colorA,
        color2: metallicSilver,
        color3: warmLuminous,
        darkStage,
      };
    }

    // Pure Black + Single Bold Color (e.g., Black + Crimson Red)
    const richDeepAccent = hslToRgb(c0.h, clamp(c0.s * 1.15, 0.65, 0.98), 0.38);
    const brightAccent = hslToRgb(c0.h, clamp(c0.s * 0.95, 0.60, 0.95), 0.62);
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
  const colorB = toTrueCoverChromatic(c1.h, c1.s, c1.l);

  let colorC: RGB;
  if (realChromatics.length >= 3) {
    const c2 = realChromatics[2];
    colorC = toTrueCoverChromatic(c2.h, c2.s, c2.l);
  } else if (hasSignificantWhiteSilver) {
    colorC = metallicSilver;
  } else {
    colorC = hslToRgb(c0.h, clamp(c0.s * 0.95, 0.55, 0.95), 0.62);
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
