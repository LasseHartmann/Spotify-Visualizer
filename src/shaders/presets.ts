import type { ShaderPresetId } from '@shared/types';

export interface ShaderPresetMeta {
  id: ShaderPresetId;
  name: string;
  key: string;
  tagline: string;
  fragmentSource: string;
}

export const VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 pos = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const COMMON_HEADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uFlowTime;
uniform float uSubBass;
uniform float uBass;
uniform float uLowMid;
uniform float uVocal;
uniform float uTreble;
uniform float uEnergy;
uniform float uKick;
uniform float uSnare;
uniform float uHiHat;
uniform float uDrop;
uniform float uColorIndex;
uniform float uColorCycle;
uniform float uPulse;
uniform float uAudioActive;
uniform float uFade;
uniform float uSpinAngle;
uniform float uKickWave;
uniform float uKickWaveAmp;
uniform float uHasAlbumArt;
uniform vec3 uBackdrop;
uniform float uDarkStage;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform sampler2D uAudioTex;
uniform sampler2D uAlbumArt;

float sampleFFT(float x) {
  return texture(uAudioTex, vec2(clamp(x, 0.0, 1.0), 0.1666667)).r;
}

float sampleWave(float x) {
  return (texture(uAudioTex, vec2(clamp(x, 0.0, 1.0), 0.5)).r - 0.5) * 2.0;
}

float samplePeak(float x) {
  return texture(uAudioTex, vec2(clamp(x, 0.0, 1.0), 0.8333333)).r;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2d(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    value += amp * noise2d(p);
    p = rot * p * 2.02 + vec2(11.3, 7.9);
    amp *= 0.5;
  }
  return value;
}

float fbm5(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    value += amp * noise2d(p);
    p = rot * p * 2.03 + vec2(13.7, 9.1);
    amp *= 0.5;
  }
  return value;
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Neutral-safe color interpolation:
// - Chromatic <-> White/Silver blends cleanly in RGB (never invents fake blue/green/rainbow!)
// - Chromatic <-> Chromatic glides smoothly along HSV without forcing saturation up.
vec3 mixCoverColor(vec3 a, vec3 b, float t) {
  vec3 ha = rgb2hsv(a);
  vec3 hb = rgb2hsv(b);
  if (ha.y < 0.22 || hb.y < 0.22) {
    return mix(a, b, t);
  }
  float dh = hb.x - ha.x;
  if (dh > 0.5) dh -= 1.0;
  if (dh < -0.5) dh += 1.0;
  float h = fract(ha.x + dh * t);
  float s = mix(ha.y, hb.y, t);
  float v = mix(ha.z, hb.z, t);
  return hsv2rgb(vec3(h, s, v));
}

vec3 preserveShade(vec3 col, float hueDelta, float valScale) {
  vec3 hsv = rgb2hsv(col);
  if (hsv.y < 0.22) {
    return clamp(col * valScale, 0.0, 1.0);
  }
  hsv.x = fract(hsv.x + hueDelta);
  hsv.z = clamp(hsv.z * valScale, 0.0, 1.0);
  return hsv2rgb(hsv);
}

vec3 samplePaletteCycle(float offset) {
  float idx = mod(uColorIndex + offset, 3.0);
  if (idx < 1.0) {
    return mixCoverColor(uColor1, uColor2, smoothstep(0.0, 1.0, idx));
  } else if (idx < 2.0) {
    return mixCoverColor(uColor2, uColor3, smoothstep(0.0, 1.0, idx - 1.0));
  }
  return mixCoverColor(uColor3, uColor1, smoothstep(0.0, 1.0, idx - 2.0));
}

vec3 getPrimaryColor() {
  if (uColorCycle < 0.5) {
    return uColor1;
  }
  return samplePaletteCycle(0.0);
}

vec3 getAccentColor() {
  if (uColorCycle < 0.5) {
    return uColor2;
  }
  return samplePaletteCycle(1.0);
}

vec3 getTertiaryColor() {
  if (uColorCycle < 0.5) {
    return uColor3;
  }
  return samplePaletteCycle(2.0);
}

vec3 finalizeLedColor(vec3 col) {
  col = max(col, vec3(0.0));
  float peak = max(col.r, max(col.g, col.b));
  if (peak > 0.88) {
    float compressed = 0.88 + (1.0 - exp(-(peak - 0.88) * 1.6)) * 0.12;
    col *= compressed / peak;
  }
  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 59.0) - 0.5) / 255.0;
  return clamp(col * uFade + dither, 0.0, 1.0);
}
`;

/**
 * 1. LIQUID (Lightweight fallback if GPU lacks float FBOs; primary uses real FluidSimulator)
 */
const LIQUID_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  float t = uTime * 0.16 + uFlowTime * 0.25;
  float n1 = noise2d(p * 2.2 + vec2(t, -t * 0.7));
  float n2 = noise2d(p * 3.1 - vec2(t * 0.8, t) + n1 * 1.6);
  vec3 col = uBackdrop * 0.65 + mixCoverColor(primaryCol, accentCol, n2) * (0.25 + uBass * 0.45 + uKick * 0.30) * smoothstep(0.25, 0.85, n2);
  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. WAVE — Layered Harmonic Ocean & Acoustic Ribbon Waves
 * Five translucent glowing wave layers driven by live FFT spectrum, smoothed
 * audio waveform, expanding outward kick crests, vocal counter-waves, and treble shimmer.
 */
const WAVE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 tertiaryCol = getTertiaryColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.54);
  vec3 foamCol = mix(accentCol, vec3(1.0), 0.30);

  float punch = clamp(uPulse, 0.55, 1.4);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);
  float flow = uFlowTime * 0.95;

  // Smooth multi-tap FFT across horizontal axis (bass center -> highs edges, rounded smoothly at center)
  float symX = smoothstep(0.0, 1.0, abs(uv.x - 0.5) * 2.0);
  float freqX = pow(symX, 0.88) * 0.84 + 0.02;
  float fft = (
    sampleFFT(freqX - 0.032) * 0.16 +
    sampleFFT(freqX - 0.015) * 0.22 +
    sampleFFT(freqX) * 0.28 +
    sampleFFT(freqX + 0.015) * 0.20 +
    sampleFFT(freqX + 0.032) * 0.14
  );

  // Lightly smoothed phase-locked live audio waveform for fluid acoustic crests
  float liveWave = (
    sampleWave(uv.x - 0.012) * 0.18 +
    sampleWave(uv.x - 0.005) * 0.24 +
    sampleWave(uv.x) * 0.32 +
    sampleWave(uv.x + 0.005) * 0.16 +
    sampleWave(uv.x + 0.012) * 0.10
  );

  // Expanding horizontal kick crest sweeping outward from center
  float kickCrestWave = exp(-abs(symX - uKickWave * 1.15) * 7.0) *
                        (1.0 - smoothstep(0.55, 1.15, uKickWave)) * uKickWaveAmp;

  // Atmospheric twilight sky gradient above lowered ocean waves
  float bgScale = mix(1.0, 0.18, uDarkStage);
  vec3 col = uBackdrop + deepTint * (0.06 + (1.0 - uv.y) * 0.15 + uEnergy * 0.10) * bgScale;
  col += primaryCol * exp(-abs(uv.y - 0.36) * 3.8) * (0.08 + bassPower * 0.16 + kickHit * 0.16) * bgScale;

  // LAYER 1 (Back): Sub-Bass Horizon Ocean Swell
  float swell1 = 0.38
    + sin(uv.x * 3.8 + flow * 0.55) * (0.040 + bassPower * 0.048)
    + cos(uv.x * 2.1 - flow * 0.35) * 0.026
    + (fft - 0.25) * (0.16 + bassPower * 0.11)
    + kickHit * 0.048;
  float fill1 = smoothstep(swell1 + 0.02, swell1 - 0.015, uv.y) * exp(-max(swell1 - uv.y, 0.0) * 2.8);
  float rim1 = exp(-abs(uv.y - swell1) * 42.0);
  col += deepTint * fill1 * (0.36 + bassPower * 0.42);
  col += primaryCol * rim1 * (0.26 + fft * 0.48 + kickHit * 0.26);

  // LAYER 2 (Mid-Back): Live FFT Spectrum Translucent Ocean Sheet
  float swell2 = 0.32
    + sin(uv.x * 5.6 - flow * 0.78 + 1.2) * (0.034 + uLowMid * 0.040)
    + fft * (0.18 + uEnergy * 0.10) * (1.0 - symX * 0.25)
    + kickCrestWave * 0.075;
  float fill2 = smoothstep(swell2 + 0.016, swell2 - 0.012, uv.y) * exp(-max(swell2 - uv.y, 0.0) * 3.8);
  float rim2 = exp(-abs(uv.y - swell2) * 58.0);
  vec3 sheet2Col = mixCoverColor(primaryCol, accentCol, 0.35 + fft * 0.35);
  col += sheet2Col * fill2 * (0.28 + fft * 0.48 + kickHit * 0.22);
  col += sheet2Col * rim2 * (0.45 + fft * 0.65 + kickCrestWave * 0.55);

  // LAYER 3 (Mid): Vocal Harmonic Counter-Wave Ribbon
  float vocalAmp = 0.068 + uVocal * 0.082 + snareHit * 0.045;
  float swell3 = 0.35
    - liveWave * (vocalAmp * 0.55)
    + sin(uv.x * 7.4 + flow * 1.15) * (0.022 + uVocal * 0.040)
    + cos(uv.x * 4.0 - flow * 0.6) * 0.018;
  float fill3 = smoothstep(swell3 + 0.012, swell3 - 0.012, uv.y) * exp(-max(swell3 - uv.y, 0.0) * 5.2);
  float rim3 = exp(-abs(uv.y - swell3) * 76.0);
  float glow3 = exp(-abs(uv.y - swell3) * 16.0);
  col += accentCol * fill3 * (0.16 + uVocal * 0.34);
  col += accentCol * (rim3 * (0.58 + uVocal * 0.65 + snareHit * 0.55) + glow3 * (0.16 + uVocal * 0.28));

  // LAYER 4 (Foreground Hero): Crisp Live Acoustic Waveform Crest + Caustic Underwater Glow
  float heroAmp = 0.10 + bassPower * 0.078 + kickHit * 0.055 + uDrop * 0.042;
  float trebleRipple = sin(uv.x * 36.0 - flow * 3.6) * (uTreble * 0.010 + uHiHat * 0.015);
  float heroY = 0.32
    + liveWave * heroAmp
    + sin(uv.x * 4.8 + flow * 0.85) * 0.020
    + kickCrestWave * 0.052
    + trebleRipple;
  float dHero = abs(uv.y - heroY);
  float heroBody = smoothstep(heroY + 0.010, heroY - 0.008, uv.y) * exp(-max(heroY - uv.y, 0.0) * 4.2);
  float heroCore = exp(-dHero * (105.0 - kickHit * 24.0));
  float heroHalo = exp(-dHero * 16.0) * (0.28 + uEnergy * 0.36 + kickHit * 0.34);

  col += mixCoverColor(primaryCol, tertiaryCol, 0.3) * heroBody * (0.24 + bassPower * 0.44 + kickHit * 0.28);
  col += primaryCol * heroHalo;
  col += mix(primaryCol, foamCol, 0.52 + uHiHat * 0.35) * heroCore * (0.85 + kickHit * 0.42 + uHiHat * 0.35);

  // LAYER 5 (Subtle Mirrored Sky Wave Reflection for Balanced Depth)
  float mirrorY = 0.50 + fft * 0.11 - liveWave * (heroAmp * 0.28) + cos(uv.x * 5.2 - flow * 0.7) * 0.016;
  float dMirror = abs(uv.y - mirrorY);
  float mirrorRibbon = exp(-dMirror * 68.0) * (0.22 + uVocal * 0.36 + uTreble * 0.30);
  float mirrorGlow = exp(-dMirror * 15.0) * (0.08 + fft * 0.18);
  col += mixCoverColor(accentCol, primaryCol, 0.4) * (mirrorRibbon + mirrorGlow);

  // Soft bottom reflection shimmer & perimeter kick swell
  float edgeGlow = smoothstep(0.32, 0.50, abs(uv.y - 0.5));
  col += primaryCol * edgeGlow * (kickHit * 0.22 + bassPower * 0.12);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 3. CLOUD — Fast, Clean Sky Filled with Fluffy Cumulus Clouds Only
 * Zero circles, zero rings, zero star dots — pure endlessly-tiled drifting cumulus clouds
 * with bounding-box early-outs for buttery 60 FPS performance on laptops.
 */
const CLOUD_FRAG = `${COMMON_HEADER}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

// Fast 2-octave cloud fluff noise (3x cheaper than 4-octave fbm, silky smooth!)
float cloudNoise2(vec2 p) {
  return noise2d(p) * 0.67 + noise2d(p * 2.05 + vec2(7.3, 4.1)) * 0.33;
}

// Lightweight cumulus cloud SDF with rounded overlapping domes + flat underside
float fastCumulusSdf(vec2 q, float bL, float bC, float bR, float kickPump, float seed) {
  float k = 0.028;
  float lift = kickPump * 0.018;

  float d = length(q - vec2(-0.02, 0.064 + bC * 0.042 + lift)) - (0.095 + bC * 0.024 + kickPump * 0.014);
  d = smin(d, length(q - vec2( 0.086, 0.048 + bR * 0.034 + lift * 0.85)) - (0.080 + bR * 0.020 + kickPump * 0.011), k);
  d = smin(d, length(q - vec2(-0.125, 0.032 + bL * 0.032 + lift * 0.85)) - (0.076 + bL * 0.020 + kickPump * 0.011), k);
  d = smin(d, length(q - vec2(-0.208, -0.002 + bL * 0.016)) - (0.054 + bL * 0.014), k);
  d = smin(d, length(q - vec2( 0.180,  0.002 + bR * 0.016)) - (0.058 + bR * 0.014), k);
  d = smin(d, length(q - vec2( 0.00,  -0.008)) - (0.080 + bC * 0.012), 0.042);

  // Soft flat cloud bottom
  d = smax(d, -0.044 - q.y, 0.024);

  // Fast 2-octave cotton-edge billow detail
  float edgeFluff = (cloudNoise2(q * 8.2 + vec2(seed, -seed * 0.5)) - 0.5) * 0.028;
  return d + edgeFluff;
}

// Renders one infinite horizontal row of evenly-spaced drifting cumulus clouds in O(1) cost!
vec3 renderCloudRow(
  vec3 col,
  vec2 p,
  float rowY,
  float tileW,
  float rowSpeed,
  float baseScale,
  float rowSeed,
  float opacity,
  float fSub,
  float fMid,
  float fVoc,
  float fHi,
  float kickHit,
  float rimEnergy,
  vec3 bellyCol,
  vec3 bodyCol,
  vec3 crownCol,
  vec3 rimCol
) {
  // Fast vertical row culling: skip pixels far outside this cloud row immediately!
  if (abs(p.y - rowY) > 0.30 * baseScale + 0.08) return col;

  float shiftedX = p.x - rowSpeed;
  float cellId = floor(shiftedX / tileW);
  float localX = shiftedX - (cellId + 0.5) * tileW;

  // Per-cloud organic variation (position jitter, scale, fluff seed) so every cloud feels unique
  float r1 = hash21(vec2(cellId, rowSeed));
  float r2 = hash21(vec2(cellId + 19.7, rowSeed + 3.1));
  float r3 = hash21(vec2(cellId + 41.3, rowSeed + 7.7));

  float jitterX = (r1 - 0.5) * (tileW * 0.16);
  float jitterY = (r2 - 0.5) * 0.09;
  float cScale = baseScale * (0.86 + r3 * 0.26);

  vec2 q = vec2(localX - jitterX, p.y - (rowY + jitterY)) / cScale;

  // Fast tight bounding-box early-out before ANY SDF or noise work!
  if (abs(q.x) > 0.45 || q.y < -0.17 || q.y > 0.31) return col;

  // Assign distinct musical frequency sensitivity across neighboring clouds
  float bL = mix(fSub, fMid, r1);
  float bC = mix(fMid, fVoc, r2);
  float bR = mix(fVoc, fHi, r3);

  float d = fastCumulusSdf(q, bL, bC, bR, kickHit, rowSeed * 13.0 + cellId * 5.7);

  // Smoothly taper outer cloud halo to zero well inside the bounding box (zero rectangular seam!)
  float haloFade =
    smoothstep(0.45, 0.33, abs(q.x)) *
    smoothstep(-0.17, -0.07, q.y) *
    smoothstep(0.31, 0.20, q.y);
  float halo = exp(-max(d, 0.0) * 26.0) * (0.09 + kickHit * 0.20 + rimEnergy * 0.14) * opacity * haloFade;
  vec3 outCol = col + rimCol * halo;

  float mask = smoothstep(0.014, -0.010, d);
  if (mask <= 0.001) return outCol;

  // Ultra-fast analytical 3D cloud volume shading (no second SDF pass!)
  float bellyToCrown = smoothstep(-0.048, 0.125, q.y);
  float innerDepth = smoothstep(0.0, -0.068, d);
  float puffTex = cloudNoise2(q * 10.5 + vec2(cellId * 3.1, rowSeed));
  float shadeT = clamp(bellyToCrown * 0.72 + (1.0 - innerDepth) * 0.16 + (puffTex - 0.48) * 0.24, 0.0, 1.0);

  vec3 cCol = mix(bellyCol, bodyCol, smoothstep(0.05, 0.54, shadeT));
  cCol = mix(cCol, crownCol, smoothstep(0.48, 0.94, shadeT));

  // Gentle internal cloud brightening on kicks + backlit silver-lining rim on vocals/snares
  cCol += rimCol * innerDepth * (kickHit * 0.36 + bC * 0.14);
  float rim = exp(-abs(d) * 76.0) * smoothstep(-0.025, 0.065, q.y);
  cCol += rimCol * rim * (0.30 + rimEnergy * 0.55);

  return mix(outCol, cCol, mask * opacity);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.38);
  vec3 highlightCol = mix(accentCol, vec3(1.0), 0.44);

  float punch = clamp(uPulse, 0.55, 1.30);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.90);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.15);

  // Smooth live frequency bands driving organic cloud puff swells
  float fSub = (sampleFFT(0.04) + sampleFFT(0.09)) * 0.5;
  float fMid = (sampleFFT(0.26) + sampleFFT(0.36)) * 0.5;
  float fVoc = (sampleFFT(0.48) + sampleFFT(0.60)) * 0.5;
  float fHi  = (sampleFFT(0.74) + sampleFFT(0.84)) * 0.5;

  // Clean pure twilight sky gradient — zero circles, zero stars, zero rings
  float bgScale = mix(1.0, 0.20, uDarkStage);
  vec3 skyTop = uBackdrop * 0.52 + deepTint * (0.05 + uEnergy * 0.05) * bgScale;
  vec3 skyBottom = uBackdrop * 0.74 + mix(deepTint, primaryCol, 0.28) * (0.14 + bassPower * 0.14) * bgScale;
  vec3 col = mix(skyBottom, skyTop, smoothstep(0.0, 1.0, uv.y));

  // Cloud color tiers faithful to album palette
  vec3 bellyDark = mix(uBackdrop * 0.62, deepTint * 0.58, 0.62);
  vec3 bodyMid = mixCoverColor(deepTint, primaryCol, 0.72) * (0.58 + uEnergy * 0.20);
  vec3 crownLit = mixCoverColor(primaryCol, highlightCol, 0.44) * (0.82 + bassPower * 0.16);
  vec3 rimGlow = mixCoverColor(accentCol, vec3(1.0), 0.40);

  float drift = uTime * 0.030 + uFlowTime * 0.042;
  float rimEnergy = uVocal * 0.65 + snareHit * 0.70 + uDrop * 0.20;

  // 4 staggered infinite tiled rows so the sky ALWAYS has plenty of distinct fluffy clouds!
  // Row 1: Distant high sky clouds
  col = renderCloudRow(
    col, p, 0.33, 0.72, drift * 0.45, 0.54, 1.0, 0.58,
    fSub * 0.7, fMid * 0.8, fVoc * 0.8, fHi * 0.8, kickHit * 0.55, rimEnergy * 0.55,
    bellyDark, bodyMid * 0.82, crownLit * 0.82, rimGlow
  );

  // Row 2: Upper-mid drifting clouds (staggered phase)
  col = renderCloudRow(
    col, p, 0.14, 0.82, drift * 0.75 + 0.41, 0.74, 2.0, 0.82,
    fSub * 0.85, fMid, fVoc, fHi, kickHit * 0.80, rimEnergy * 0.85,
    bellyDark, bodyMid * 0.94, crownLit * 0.95, rimGlow
  );

  // Row 3: Lower-mid hero clouds framing beneath the lyrics
  col = renderCloudRow(
    col, p, -0.14, 0.86, drift * 1.05 + 0.18, 0.84, 3.0, 0.92,
    fSub, fMid, fVoc, fHi, kickHit * 0.95, rimEnergy,
    bellyDark * 0.94, bodyMid, crownLit * 1.04, rimGlow
  );

  // Row 4: Foreground low clouds drifting along the bottom edge
  col = renderCloudRow(
    col, p, -0.35, 0.90, drift * 1.35 + 0.56, 0.92, 4.0, 0.95,
    fSub, fMid, fVoc, fHi, kickHit, rimEnergy * 0.80,
    bellyDark * 0.86, bodyMid * 0.92, crownLit * 0.96, rimGlow
  );

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 3. BARS — Rough, Raw, Edge-to-Edge Bottom-Up Segmented Spectrum Bars
 * Flush from left pixel 0 to right edge and bottom edge, raw un-blurred per-bar FFT spikes,
 * crisp flat-top segmented LED-block texture, and sharp falling peak-hold caps.
 */
const BARS_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.48);
  vec3 capCol = mix(accentCol, vec3(1.0), 0.58);

  float punch = clamp(uPulse, 0.55, 1.35);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Clean raw dark backdrop
  float bgScale = mix(1.0, 0.16, uDarkStage);
  vec3 col = uBackdrop * 0.80 + deepTint * (0.04 + (1.0 - uv.y) * 0.09 + uEnergy * 0.07) * bgScale;

  // Edge-to-edge full-width bars (zero left/right/bottom margins!)
  float numBars = clamp(floor(aspect * 38.0), 24.0, 68.0);
  float barSlot = uv.x * numBars;
  float barIdx = clamp(floor(barSlot), 0.0, numBars - 1.0);
  float barLocalX = fract(barSlot) - 0.5;
  float barNorm = (barIdx + 0.5) / numBars;

  // Raw, direct per-bar FFT sampling (no neighbor blur -> sharp jagged rough frequency spikes!)
  float freqPos = pow(barNorm, 0.92) * 0.90 + 0.012;
  float fft = sampleFFT(freqPos);
  float peakFft = max(fft, samplePeak(freqPos));

  // Punchy bass & snare micro-kick + slight crisp per-bar energy grit
  float kickBoost = kickHit * exp(-barNorm * 4.2) * 0.075;
  float snareBoost = snareHit * exp(-pow((barNorm - 0.62) * 4.0, 2.0)) * 0.055;

  float barH = clamp(0.016 + fft * (0.64 + uEnergy * 0.09) + kickBoost + snareBoost, 0.016, 0.84);
  float peakH = clamp(0.022 + peakFft * (0.64 + uEnergy * 0.09) + kickBoost * 0.65, barH + 0.012, 0.88);

  // Quantize bar height slightly to crisp hardware LED-brick rows for a raw, rough equalizer feel
  float numRows = 54.0;
  float segY = fract(uv.y * numRows);
  float rowIdx = floor(uv.y * numRows);
  float barTopRow = floor(barH * numRows);
  float peakRow = floor(peakH * numRows);

  // Subtle ambient backlight spill directly behind active columns
  float backGlow = exp(-max(uv.y - barH * 0.85, 0.0) * 7.0) * (0.06 + fft * 0.22);
  col += mixCoverColor(primaryCol, accentCol, barNorm * 0.35) * backGlow;

  // Sharp flat-edged bar column mask (wide solid columns with crisp dark vertical cuts)
  float pxX = max(uResolution.x, 1.0);
  float aaX = max(1.0 / (pxX / numBars), 0.015);
  float colMask = smoothstep(0.42 + aaX, 0.42 - aaX, abs(barLocalX));

  // Rough segmented horizontal LED brick mask (sharp notches slicing each bar)
  float segMask = smoothstep(0.14, 0.24, segY) * smoothstep(0.98, 0.90, segY);
  float inBar = step(rowIdx, barTopRow) * colMask * segMask;

  if (inBar > 0.001) {
    float vFrac = clamp(uv.y / max(barH, 0.001), 0.0, 1.0);
    // Subtle raw grain per brick so bars feel tactile and gritty rather than overly glossy
    float brickGrit = 0.90 + 0.20 * hash21(vec2(barIdx * 1.3, rowIdx * 2.1));
    vec3 baseCol = mix(deepTint, primaryCol, smoothstep(0.0, 0.40, vFrac));
    vec3 barCol = mixCoverColor(baseCol, accentCol, pow(vFrac, 1.45) * 0.82);
    float lum = (0.56 + vFrac * 0.46 + fft * 0.34 + kickHit * 0.14) * brickGrit;
    // Extra hot top active brick
    float isTopBrick = step(barTopRow - 0.5, rowIdx);
    barCol = barCol * lum + capCol * isTopBrick * (0.28 + fft * 0.45);
    col = mix(col, barCol, inBar);
  }

  // Sharp flat rectangular gravity peak-hold cap hovering cleanly above each column
  float isPeakBrick = step(abs(rowIdx - peakRow), 0.25) * step(2.0, peakRow);
  float peakMask = isPeakBrick * colMask * segMask;
  float peakGlow = exp(-abs(uv.y - (peakRow + 0.5) / numRows) * 90.0) * colMask * step(2.0, peakRow);
  col += capCol * (peakMask * 0.95 + peakGlow * 0.26);

  // Subtle perimeter kick breath for LED backlights
  col += primaryCol * smoothstep(0.78, 1.0, 1.0 - uv.y) * (kickHit * 0.14 + bassPower * 0.08);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 3. VINYL — Photorealistic Spinning 12" Record with Real Album Cover Label & Live Groove Spectrum
 * Spins at 33 1/3 RPM while playing, physically pumps on kick drums, illuminates concentric
 * micro-grooves by live frequency band, radiates kick shockwaves, and plays under a glowing stylus.
 */
const VINYL_FRAG = `${COMMON_HEADER}
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  // Fit true-circle vinyl nicely on desktop 16:9, Echo Show 2:1, AND mobile portrait
  float fitScale = min(aspect, 1.0);
  vec2 vp = p / max(fitScale, 0.35);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.58);
  vec3 highlightCol = mix(accentCol, vec3(1.0), 0.28);

  float punch = clamp(uPulse, 0.55, 1.4);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Physical platter bass/kick thump
  float discScale = 1.0 + kickHit * 0.038 + uSubBass * 0.024;
  vec2 dp = vp / discScale;
  float r = length(dp);
  float angle = atan(dp.y, dp.x);

  const float discR = 0.415;
  const float labelR = 0.148;
  const float spindleR = 0.014;

  // Stage backdrop with warm concert turntable lighting & expanding kick shockwave halo
  float bgScale = mix(1.0, 0.22, uDarkStage);
  float stageCloud = fbm(p * 1.7 + vec2(uFlowTime * 0.10, -uFlowTime * 0.07));
  vec3 col = uBackdrop + mix(deepTint, primaryCol, stageCloud) * (0.07 + uEnergy * 0.12 + kickHit * 0.18) * bgScale;

  // Expanding outer shockwave pulsing away from the vinyl rim on every kick drum
  float outerShockR = discR + uKickWave * 0.58;
  float outerShock = exp(-abs(r - outerShockR) * 20.0) *
                     (1.0 - smoothstep(0.45, 1.15, uKickWave)) * uKickWaveAmp;
  col += mixCoverColor(primaryCol, accentCol, 0.35) * outerShock * 0.65;

  // Warm drop shadow & luminous platter under-glow behind the vinyl disc
  float platterHalo = exp(-max(r - discR, 0.0) * 9.5) * (0.24 + bassPower * 0.45 + kickHit * 0.42);
  col += primaryCol * platterHalo * smoothstep(discR - 0.02, discR + 0.015, r);

  // 72 Radial Outer Spectrum Ticks + Live Acoustic Waveform Ring hugging the vinyl edge
  float normAng = (angle + 3.14159265) / 6.2831853;
  float symAng = abs(angle) / 3.14159265;
  float outerWave = sampleWave(symAng);
  float spokeCount = 72.0;
  float spokeId = floor(normAng * spokeCount);
  float spokeLocal = fract(normAng * spokeCount) - 0.5;
  float spokeSym = abs((spokeId / spokeCount) * 2.0 - 1.0);
  float spokeFft = sampleFFT(pow(spokeSym, 0.9) * 0.85 + 0.02);
  float spokeMask = smoothstep(0.36, 0.14, abs(spokeLocal));

  float barInner = discR + 0.016;
  float barOuter = barInner + 0.008 + spokeFft * (0.115 + bassPower * 0.055) + kickHit * 0.018;
  float inBar = smoothstep(barInner - 0.005, barInner + 0.004, r) *
                smoothstep(barOuter + 0.010, barOuter - 0.004, r);
  col += mixCoverColor(primaryCol, accentCol, spokeFft * 0.65) * inBar * spokeMask * (0.34 + spokeFft * 0.78);
  col += accentCol * exp(-abs(r - barOuter) * 72.0) * spokeMask * (0.22 + spokeFft * 0.62);

  float waveRingR = discR + 0.024 + outerWave * (0.028 + uVocal * 0.028 + kickHit * 0.016);
  float waveRing = exp(-abs(r - waveRingR) * 85.0) * (0.32 + uEnergy * 0.45 + uVocal * 0.35);
  col += highlightCol * waveRing * smoothstep(discR - 0.005, discR + 0.010, r);

  // VINYL RECORD DISC SURFACE
  float discMask = smoothstep(discR + 0.004, discR - 0.003, r);
  if (discMask > 0.001) {
    // Rotate coordinates by turntable spin angle
    float cs = cos(-uSpinAngle);
    float sn = sin(-uSpinAngle);
    vec2 spinP = mat2(cs, -sn, sn, cs) * dp;
    float spinAng = atan(spinP.y, spinP.x);

    // Base dark glossy vinyl material (rich deep charcoal-tinted obsidian)
    vec3 vinylCol = mix(vec3(0.028, 0.030, 0.038), uBackdrop * 0.42, 0.35);

    // Concentric micro-grooves modulated slightly by live waveform
    float grooveT = clamp((r - labelR) / max(discR - labelR, 0.001), 0.0, 1.0);
    float grooveRegion = smoothstep(labelR - 0.003, labelR + 0.006, r) *
                         smoothstep(discR + 0.002, discR - 0.008, r);
    float grooveWobble = sampleWave(fract(spinAng / 6.2831853 + 0.5)) * (0.0022 + uBass * 0.0030);
    float fineGroove = sin((r + grooveWobble) * 520.0) * 0.5 + 0.5;
    float medGroove = sin((r + grooveWobble * 0.5) * 145.0) * 0.5 + 0.5;
    // Authentic LP track divider bands (darker silent spaces between songs on the LP)
    float trackDiv = 1.0
      - 0.48 * exp(-pow((grooveT - 0.28) * 42.0, 2.0))
      - 0.48 * exp(-pow((grooveT - 0.58) * 42.0, 2.0))
      - 0.48 * exp(-pow((grooveT - 0.84) * 42.0, 2.0));

    // Live FFT spectrum illumination directly across the concentric grooves:
    // outer grooves = bass, mid grooves = vocals/melody, inner grooves = treble/hi-hats!
    float radialFreq = clamp((1.0 - grooveT) * 0.84 + 0.02, 0.0, 1.0);
    float grooveFft = (
      sampleFFT(radialFreq - 0.015) * 0.25 +
      sampleFFT(radialFreq) * 0.50 +
      sampleFFT(radialFreq + 0.015) * 0.25
    );
    float grooveRidge = mix(0.45, 1.15, fineGroove) * mix(0.82, 1.12, medGroove) * trackDiv;
    vec3 grooveHue = mixCoverColor(primaryCol, accentCol, (1.0 - grooveT) * 0.75);

    // Subtle groove sheen + vivid live spectrum groove glow
    vinylCol += vec3(0.042) * fineGroove * trackDiv * grooveRegion;
    vinylCol += grooveHue * pow(grooveFft, 1.05) * grooveRidge * grooveRegion * (0.82 + uEnergy * 0.45 + kickHit * 0.36);

    // Expanding kick shockwave rippling across the vinyl grooves!
    float innerShockR = labelR + uKickWave * (discR - labelR + 0.04);
    float grooveShock = exp(-abs(r - innerShockR) * 28.0) *
                        (1.0 - smoothstep(0.55, 1.05, uKickWave)) * uKickWaveAmp;
    vinylCol += mixCoverColor(primaryCol, highlightCol, 0.45) * grooveShock * grooveRidge * grooveRegion * 1.15;

    // Rotating anisotropic diagonal vinyl light sheen (classic record gleam!)
    float sheenAng = angle - 0.68 + sin(uSpinAngle * 0.5) * 0.05;
    float aniso = pow(abs(cos(sheenAng)), 9.0) * 0.85 + pow(abs(cos(sheenAng + 0.16)), 22.0) * 0.55;
    float sheenBoost = 0.32 + uVocal * 0.42 + snareHit * 0.55 + uHiHat * 0.30;
    vinylCol += mix(vec3(0.88, 0.90, 0.96), highlightCol, 0.52) * aniso * sheenBoost * grooveRidge * grooveRegion;

    // Outer polished bevel rim of the record
    float rimHighlight = exp(-abs(r - (discR - 0.004)) * 180.0);
    vinylCol += mix(primaryCol, highlightCol, 0.5) * rimHighlight * (0.55 + kickHit * 0.55);

    // CENTER RECORD LABEL (spinning real album cover art or sleek palette fallback!)
    float labelMask = smoothstep(labelR + 0.003, labelR - 0.003, r);
    if (labelMask > 0.001) {
      vec2 labelUv = spinP / (labelR * 2.0) + 0.5;
      vec3 labelCol;
      if (uHasAlbumArt > 0.5) {
        labelCol = texture(uAlbumArt, clamp(labelUv, 0.0, 1.0)).rgb;
        // Slight studio warmth & subtle beat brightness lift
        labelCol *= 0.86 + kickHit * 0.14;
      } else {
        // Stylized studio vinyl label with rotating orientation notch
        float radialGrad = smoothstep(0.0, labelR, r);
        labelCol = mixCoverColor(primaryCol, accentCol, radialGrad * 0.75) * 0.72;
        float notch = smoothstep(0.08, 0.01, abs(spinAng)) * smoothstep(0.04, 0.12, r);
        labelCol += highlightCol * notch * 0.45;
      }
      // Subtle paper label ring & embossed press groove
      float pressRing = exp(-abs(r - (labelR * 0.76)) * 220.0) * 0.18;
      float labelBorder = exp(-abs(r - (labelR - 0.003)) * 200.0) * 0.35;
      labelCol = labelCol * (1.0 - pressRing) + highlightCol * labelBorder;
      vinylCol = mix(vinylCol, labelCol, labelMask);
    }

    // Center metallic spindle hole
    float spindleRim = exp(-abs(r - spindleR) * 260.0);
    float spindleHole = smoothstep(spindleR + 0.002, spindleR - 0.002, r);
    vinylCol = mix(vinylCol, vec3(0.03, 0.035, 0.045), spindleHole);
    vinylCol += vec3(0.65, 0.68, 0.74) * spindleRim * 0.45;

    // Gentle center shading so overlaid Focus lyrics stay crisp & effortless to read
    float lyricEase = 1.0 - exp(-r * r * 14.0) * 0.20;
    col = mix(col, vinylCol * lyricEase, discMask);
  }

  // STYLIZED STUDIO TONEARM & REACTIVE DIAMOND STYLUS
  vec2 pivot = vec2(0.455, 0.355);
  vec2 elbow = vec2(0.395, 0.085);
  float stylusJitter = sampleWave(0.25) * (0.0025 + uEnergy * 0.0035);
  vec2 tip = vec2(0.272 + stylusJitter, -0.052 + kickHit * 0.004);

  float dArm1 = sdSegment(vp, pivot, elbow);
  float dArm2 = sdSegment(vp, elbow, tip);
  float dArm = min(dArm1, dArm2);
  float dPivot = length(vp - pivot);
  float dHead = sdSegment(vp, tip + normalize(elbow - tip) * 0.038, tip);

  // Soft shadow under tonearm
  float dArmShadow = min(sdSegment(vp - vec2(0.010, -0.012), pivot, elbow),
                         sdSegment(vp - vec2(0.010, -0.012), elbow, tip));
  col *= 1.0 - smoothstep(0.022, 0.004, dArmShadow) * 0.42;

  // Metallic tonearm shaft & gimbal pivot
  float armMask = smoothstep(0.0085, 0.0045, dArm);
  float armHighlight = smoothstep(0.0045, 0.0010, dArm);
  vec3 metalCol = mix(vec3(0.28, 0.30, 0.35), mix(vec3(0.82, 0.85, 0.90), primaryCol, 0.25), armHighlight);
  col = mix(col, metalCol, armMask * 0.92);

  float headMask = smoothstep(0.015, 0.009, dHead);
  col = mix(col, mix(vec3(0.14, 0.15, 0.19), accentCol * 0.5, 0.25), headMask * 0.95);

  float pivotOuter = smoothstep(0.044, 0.038, dPivot);
  float pivotInner = smoothstep(0.022, 0.016, dPivot);
  col = mix(col, vec3(0.16, 0.18, 0.22), pivotOuter * 0.92);
  col = mix(col, mix(vec3(0.55, 0.58, 0.65), primaryCol, 0.35), pivotInner * 0.95);

  // Glowing diamond stylus contact spark pulsing to hi-hats, snares & live audio!
  float dTip = length(vp - tip);
  float spark = exp(-dTip * 48.0) * (0.35 + uHiHat * 0.75 + snareHit * 0.65 + uEnergy * 0.45);
  float sparkCore = exp(-dTip * 160.0) * (0.55 + uEnergy * 0.65);
  col += mix(accentCol, vec3(1.0), 0.45) * spark + vec3(1.0) * sparkCore * 0.65;

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 5. OSCILLOSCOPE — Authentic Single-Line Lab Oscilloscope with X & Y Axes
 * Real center-origin rising-edge triggered waveform trace (crosses (0, 0) upward at the Y-axis),
 * crisp X (time) and Y (amplitude) axes with major/minor scale divisions, lowered cleanly
 * below center with restrained signal-accurate amplitude.
 */
const OSCILLOSCOPE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.45);
  vec3 lineHot = mix(primaryCol, vec3(1.0), 0.58);
  vec3 axisCol = mix(mix(deepTint, primaryCol, 0.55), vec3(0.85, 0.90, 0.96), 0.30);

  float punch = clamp(uPulse, 0.55, 1.35);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Clean dark CRT glass backdrop
  float bgScale = mix(1.0, 0.14, uDarkStage);
  float vignette = clamp(1.0 - r * r * 0.32, 0.42, 1.0);
  vec3 col = (uBackdrop * 0.72 + deepTint * (0.04 + uEnergy * 0.04) * bgScale) * vignette;

  // Real Oscilloscope Coordinate System:
  // X-axis (Time) & Y-axis (Voltage/Amplitude) centered cleanly at (0.50, 0.50)
  float axisX = 0.50;
  float axisY = 0.50;
  float pxX = max(uResolution.x, 1.0);
  float pxY = max(uResolution.y, 1.0);

  // Aspect-accurate square division spacing (10 horizontal divisions across screen)
  float divX = 0.092;
  float divY = divX * aspect;
  float dxAxis = uv.x - axisX;
  float dyAxis = uv.y - axisY;

  // Scope graticule bounds: crisp ±4.5 X-divisions, ±2.5 Y-divisions around (axisX, axisY)
  float scopeSpanX = divX * 4.75;
  float scopeSpanY = divY * 2.55;
  float inScopeX = smoothstep(scopeSpanX + 0.015, scopeSpanX - 0.005, abs(dxAxis));
  float inScopeY = smoothstep(scopeSpanY + 0.015, scopeSpanY - 0.005, abs(dyAxis));
  float inScope = inScopeX * inScopeY;

  // Subtle faint calibration graticule lines aligned exactly to the X and Y divisions
  vec2 gridDiv = vec2(dxAxis / divX, dyAxis / divY);
  float gridLineX = smoothstep(1.1, 0.25, abs(fract(gridDiv.x + 0.5) - 0.5) * divX * pxX);
  float gridLineY = smoothstep(1.1, 0.25, abs(fract(gridDiv.y + 0.5) - 0.5) * divY * pxY);
  float graticule = max(gridLineX, gridLineY) * inScope;
  col += axisCol * graticule * 0.085;

  // Crisp X-axis (horizontal zero-voltage line) & Y-axis (vertical trigger time=0 line)
  float distToXAxisPx = abs(dyAxis) * pxY;
  float distToYAxisPx = abs(dxAxis) * pxX;
  float xAxisLine = smoothstep(1.5, 0.45, distToXAxisPx) * inScopeX;
  float yAxisLine = smoothstep(1.5, 0.45, distToYAxisPx) * inScopeY;

  // Authentic major & minor (5 per div) oscilloscope scale ticks on BOTH X-axis and Y-axis
  float xMajorDistPx = abs(fract(gridDiv.x + 0.5) - 0.5) * divX * pxX;
  float xMinorDistPx = abs(fract(gridDiv.x * 5.0 + 0.5) - 0.5) * (divX * 0.2) * pxX;
  float xMajorTick = smoothstep(1.3, 0.35, xMajorDistPx) * smoothstep(8.0, 6.2, distToXAxisPx) * inScopeX;
  float xMinorTick = smoothstep(1.1, 0.30, xMinorDistPx) * smoothstep(4.2, 2.8, distToXAxisPx) * inScopeX;

  float yMajorDistPx = abs(fract(gridDiv.y + 0.5) - 0.5) * divY * pxY;
  float yMinorDistPx = abs(fract(gridDiv.y * 5.0 + 0.5) - 0.5) * (divY * 0.2) * pxY;
  float yMajorTick = smoothstep(1.3, 0.35, yMajorDistPx) * smoothstep(8.0, 6.2, distToYAxisPx) * inScopeY;
  float yMinorTick = smoothstep(1.1, 0.30, yMinorDistPx) * smoothstep(4.2, 2.8, distToYAxisPx) * inScopeY;

  float axesMask = clamp(
    (xAxisLine + yAxisLine) * 0.36 +
    (xMajorTick + yMajorTick) * 0.34 +
    (xMinorTick + yMinorTick) * 0.22,
    0.0,
    0.72
  );
  col += axisCol * axesMask;

  // Tiny luminous trigger-origin marker right at (X = 0, Y = 0)
  float originDistPx = length(vec2(dxAxis * pxX, dyAxis * pxY));
  float originDot = smoothstep(3.4, 1.4, originDistPx) * (0.45 + uAudioActive * 0.45);
  col += mix(accentCol, vec3(1.0), 0.5) * originDot;

  // REAL SINGLE THIN LINE OSCILLOSCOPE TRACE (lowered to axisY, realistic controlled amplitude!)
  // Crosses (axisX, axisY) upward on every triggered audio cycle just like a real hardware scope.
  float amp = min(scopeSpanY * 0.72, 0.165);
  float dx = 1.0 / 256.0;
  float wL = sampleWave(uv.x - dx);
  float wC = sampleWave(uv.x);
  float wR = sampleWave(uv.x + dx);

  float yWave = axisY + wC * amp;
  float slope = ((wR - wL) * amp) / (2.0 * dx * max(aspect, 0.5));
  float perpDistPx = (abs(uv.y - yWave) / sqrt(1.0 + slope * slope)) * pxY;

  // Razor-sharp ~1.7px electron beam core + sleek tight phosphor glow
  float thinCore = smoothstep(1.95, 0.55, perpDistPx) * inScopeX;
  float tightGlow = exp(-perpDistPx * 0.26) * (0.46 + uEnergy * 0.22 + kickHit * 0.22 + snareHit * 0.15) * inScopeX;
  float softScatter = exp(-perpDistPx * 0.06) * (0.07 + bassPower * 0.10 + kickHit * 0.10) * inScopeX;

  vec3 traceTint = mixCoverColor(primaryCol, accentCol, snareHit * 0.28 + uVocal * 0.14);
  col += traceTint * softScatter;
  col += traceTint * tightGlow;
  col += lineHot * thinCore * (0.98 + kickHit * 0.18);

  // Subtle perimeter kick breath for LED screen backlights
  col += primaryCol * smoothstep(0.72, 1.32, r) * (kickHit * 0.10 + bassPower * 0.05);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 6. FERROLIQUID — Fast 3D Glossy Magnetic Ferrofluid Orb
 * Mirror-wet obsidian magnetic liquid metal orb that erupts into gleaming Rosensweig
 * spikes on bass & kick drums with smooth-unioned orbiting droplets and album-colored
 * studio softbox reflections. Uses tight bounding-sphere early-out for locked 60 FPS.
 */
const FERROLIQUID_FRAG = `${COMMON_HEADER}
mat2 rot2d(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float sminFerro(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Fast magnetic ferrofluid orb + Rosensweig conical spikes + 3 orbiting droplets
vec2 ferroMap(
  vec3 pos,
  float rotY,
  float rotX,
  float phase,
  float bassPower,
  float kickHit,
  float vocal,
  float treble
) {
  vec3 q = pos;
  q.xz = rot2d(rotY) * q.xz;
  q.yz = rot2d(rotX) * q.yz;

  float r = length(q);
  vec3 dir = q / max(r, 1e-4);

  // Seamless 3D spherical FFT coordinate (zero atan branch cut -> zero surface seam!)
  float freqCoord = clamp(0.06 + (dir.y * 0.5 + 0.5) * 0.48 + (dir.x * 0.5 + 0.5) * 0.24 + abs(dir.z) * 0.10, 0.02, 0.88);
  float bandFft = sampleFFT(freqCoord);

  // Primary uniform Rosensweig conical magnetic spikes (clamped cleanly to [0, 1] -> zero freak horn clipping!)
  float f1 = cos(dir.x * 6.8 + phase * 0.55) * cos(dir.y * 6.8 - phase * 0.42) * cos(dir.z * 6.8 + phase * 0.35);
  float f2 = sin((dir.x + dir.y) * 5.2 - phase * 0.48) * sin((dir.y - dir.z) * 5.2 + phase * 0.38) * cos((dir.z + dir.x) * 5.2);
  float spikeField = clamp((f1 * 0.58 + f2 * 0.42) * 0.5 + 0.5, 0.0, 1.0);
  float primarySpikes = pow(spikeField, 3.6);

  // Secondary finer high-frequency magnetic crown spikes on vocals & treble
  float f3 = cos(dir.x * 11.4 - phase * 0.85) * cos(dir.y * 11.4 + phase * 0.65) * sin(dir.z * 11.4);
  float fineSpikes = pow(clamp(abs(f3), 0.0, 1.0), 3.4);

  // Calm smooth liquid black orb when quiet -> sharp gleaming Rosensweig spikes on bass & kicks!
  float liquidSwell = sin(dir.x * 3.0 + phase) * cos(dir.y * 3.0 - phase * 0.8) * 0.020;
  float spikeStrength = 0.026 + bassPower * 0.160 + kickHit * 0.140 + bandFft * 0.072;
  float fineStrength = 0.008 + vocal * 0.052 + treble * 0.052;
  float disp = liquidSwell + primarySpikes * spikeStrength + fineSpikes * fineStrength;

  float coreR = 0.45 + uSubBass * 0.032 + kickHit * 0.032;
  float dOrb = (r - (coreR + disp)) * 0.46;

  // 3 orbiting magnetic ferrofluid droplets that stretch out & merge seamlessly on bass drops!
  float orbitPull = 0.49 + bassPower * 0.14 + kickHit * 0.10;
  vec3 drop1Pos = vec3(cos(phase * 1.15) * orbitPull, sin(phase * 1.75) * 0.30, sin(phase * 1.15) * orbitPull * 0.85);
  vec3 drop2Pos = vec3(cos(phase * 0.92 + 2.1) * (orbitPull * 0.95), cos(phase * 1.45 + 1.0) * 0.35, sin(phase * 0.92 + 2.1) * orbitPull);
  vec3 drop3Pos = vec3(sin(phase * 1.35 + 4.2) * 0.42, sin(phase * 0.85 + 2.6) * (orbitPull * 0.88), cos(phase * 1.35 + 4.2) * 0.44);

  float dDrop = length(pos - drop1Pos) - (0.082 + kickHit * 0.022);
  dDrop = min(dDrop, length(pos - drop2Pos) - (0.072 + vocal * 0.018));
  dDrop = min(dDrop, length(pos - drop3Pos) - (0.064 + treble * 0.016));

  float dTotal = sminFerro(dOrb, dDrop, 0.16);
  float tipIntensity = clamp(primarySpikes * (0.45 + bassPower * 0.8 + kickHit * 0.7) + fineSpikes * treble, 0.0, 1.0);
  return vec2(dTotal, tipIntensity);
}

vec3 calcFerroNormal(
  vec3 pos,
  float rotY,
  float rotX,
  float phase,
  float bassPower,
  float kickHit,
  float vocal,
  float treble
) {
  const vec2 e = vec2(0.0028, -0.0028);
  return normalize(
    e.xyy * ferroMap(pos + e.xyy, rotY, rotX, phase, bassPower, kickHit, vocal, treble).x +
    e.yyx * ferroMap(pos + e.yyx, rotY, rotX, phase, bassPower, kickHit, vocal, treble).x +
    e.yxy * ferroMap(pos + e.yxy, rotY, rotX, phase, bassPower, kickHit, vocal, treble).x +
    e.xxx * ferroMap(pos + e.xxx, rotY, rotX, phase, bassPower, kickHit, vocal, treble).x
  );
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float fitScale = min(aspect, 1.0);
  vec2 q = ((uv - 0.5) * vec2(aspect, 1.0)) / max(fitScale, 0.38);
  float screenR = length(q);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.44);
  vec3 specWhite = mix(primaryCol, vec3(1.0), 0.58);
  vec3 accentHot = mix(accentCol, vec3(1.0), 0.40);

  float punch = clamp(uPulse, 0.55, 1.35);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Sleek dark studio stage + backlit aura radiating behind the floating ferrofluid orb
  float bgScale = mix(1.0, 0.16, uDarkStage);
  vec3 col = uBackdrop * 0.58 + deepTint * (0.05 + uEnergy * 0.06) * bgScale;
  float backHalo = exp(-screenR * screenR * (4.4 - bassPower * 0.7)) * (0.28 + bassPower * 0.36 + kickHit * 0.34);
  float rimAura = exp(-abs(screenR - (0.29 + kickHit * 0.035)) * 10.5) * (0.14 + uVocal * 0.24 + snareHit * 0.28);
  col += primaryCol * backHalo + accentCol * rimAura;

  // Camera & tight bounding-sphere ray intersection (skips ~70% of screen pixels with 0 march steps!)
  vec3 ro = vec3(0.0, 0.0, 2.95);
  vec3 rd = normalize(vec3(q, -1.78));
  float boundR = 1.24;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - boundR * boundR;
  float disc = b * b - c;

  if (disc >= 0.0) {
    float sqrtDisc = sqrt(disc);
    float t = max(0.0, -b - sqrtDisc);
    float tMax = -b + sqrtDisc;

    float rotY = uTime * 0.26 + uFlowTime * 0.32;
    float rotX = sin(uTime * 0.22 + uFlowTime * 0.18) * 0.38;
    float phase = uTime * 0.55 + uFlowTime * 0.78;

    float hitT = -1.0;
    float hitTip = 0.0;

    // 42-step sphere march inside tight bounding volume -> razor-sharp spikes, zero clipping!
    for (int i = 0; i < 42; i++) {
      vec3 pos = ro + rd * t;
      vec2 res = ferroMap(pos, rotY, rotX, phase, bassPower, kickHit, uVocal, uTreble);
      if (res.x < 0.0025) {
        hitT = t;
        hitTip = res.y;
        break;
      }
      t += res.x;
      if (t > tMax) break;
    }

    if (hitT > 0.0) {
      vec3 hitPos = ro + rd * hitT;
      vec3 n = calcFerroNormal(hitPos, rotY, rotX, phase, bassPower, kickHit, uVocal, uTreble);
      vec3 v = -rd;
      vec3 refl = reflect(rd, n);

      float ndv = max(dot(n, v), 0.0);
      float fresnel = pow(1.0 - ndv, 3.8);

      // Pure mirror-wet obsidian liquid-metal ferrofluid base
      vec3 ferroCol = vec3(0.010, 0.011, 0.015) + uBackdrop * 0.08;

      // Dual studio softbox strip reflections tinted faithfully in the album's colors
      vec3 keyDir = normalize(vec3(-0.62, 0.72, 0.55));
      vec3 fillDir = normalize(vec3(0.75, -0.35, 0.52));
      vec3 rimDir = normalize(vec3(0.05, 0.88, -0.45));

      float specKey = pow(max(dot(refl, keyDir), 0.0), 28.0);
      float specKeyBroad = pow(max(dot(refl, keyDir), 0.0), 6.0);
      float specFill = pow(max(dot(refl, fillDir), 0.0), 18.0);
      float specRim = pow(max(dot(refl, rimDir), 0.0), 12.0);

      // Synthetic glossy curved studio environment horizon bands
      float envBand1 = smoothstep(0.15, 0.85, refl.y * 0.5 + 0.5) * pow(max(0.0, 1.0 - abs(refl.x + 0.25)), 2.2);
      float envBand2 = smoothstep(-0.2, 0.65, -refl.y * 0.5 + 0.4) * pow(max(0.0, 1.0 - abs(refl.x - 0.35)), 2.4);

      ferroCol += primaryCol * (specKeyBroad * (0.42 + bassPower * 0.35) + envBand1 * 0.24);
      ferroCol += specWhite * specKey * (0.95 + kickHit * 0.55);
      ferroCol += accentCol * (specFill * (0.68 + uVocal * 0.45 + snareHit * 0.50) + envBand2 * 0.26);
      ferroCol += accentHot * specRim * (0.45 + uTreble * 0.45 + uHiHat * 0.45);

      // Razor-sharp wet liquid-metal Fresnel silhouette outline wrapping every magnetic spike!
      vec3 rimCol = mixCoverColor(primaryCol, accentHot, 0.42 + snareHit * 0.38);
      ferroCol += rimCol * fresnel * (0.92 + bassPower * 0.48 + kickHit * 0.52);

      // Glistening wet specular glints along the sharpest active magnetic spike tips
      ferroCol += mix(primaryCol, vec3(1.0), 0.55) * hitTip * (0.12 + fresnel * 0.55) * (0.35 + uTreble * 0.65 + uHiHat * 0.55);

      // Crisp soft anti-aliased edge blend at grazing silhouette
      float edgeSoft = smoothstep(0.0, 0.14, ndv);
      col = mix(col + rimCol * 0.42, ferroCol, clamp(edgeSoft * 1.15, 0.0, 1.0));
    }
  }

  // Subtle perimeter kick glow for ambient LED backlights
  col += primaryCol * smoothstep(0.55, 1.15, screenR) * (kickHit * 0.12 + bassPower * 0.06) * mix(1.0, 0.55, uDarkStage);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

export const SHADER_PRESETS: ShaderPresetMeta[] = [
  {
    id: 'liquid',
    name: 'Liquid',
    key: '1',
    tagline: 'Real GPU fluid simulation with music-synced album-color swoops',
    fragmentSource: LIQUID_FRAG,
  },
  {
    id: 'wave',
    name: 'Wave',
    key: '2',
    tagline: 'Layered flowing ocean & acoustic ribbon waves pulsing to the beat',
    fragmentSource: WAVE_FRAG,
  },
  {
    id: 'cloud',
    name: 'Cloud',
    key: '3',
    tagline: 'Clean drifting sky filled with fluffy audio-reactive cumulus clouds',
    fragmentSource: CLOUD_FRAG,
  },
  {
    id: 'bars',
    name: 'Bars',
    key: '4',
    tagline: 'Rough edge-to-edge bottom-up segmented spectrum bars with falling peak caps',
    fragmentSource: BARS_FRAG,
  },
  {
    id: 'vinyl',
    name: 'Vinyl',
    key: '5',
    tagline: 'Spinning 12" vinyl with live album label, spectrum grooves & reactive stylus',
    fragmentSource: VINYL_FRAG,
  },
  {
    id: 'oscilloscope',
    name: 'Oscilloscope',
    key: '6',
    tagline: 'Centered real single-line oscilloscope with X & Y axes',
    fragmentSource: OSCILLOSCOPE_FRAG,
  },
  {
    id: 'ferroliquid',
    name: 'Ferroliquid',
    key: '7',
    tagline: '3D glossy magnetic ferrofluid orb spiking dynamically to bass & beats',
    fragmentSource: FERROLIQUID_FRAG,
  },
  {
    id: 'blank',
    name: 'Blank',
    key: '8',
    tagline: 'Clean solid-color background with zero motion',
    fragmentSource: '',
  },
];
