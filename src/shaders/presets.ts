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
  return texture(uAudioTex, vec2(clamp(x, 0.0, 1.0), 0.25)).r;
}

float sampleWave(float x) {
  return (texture(uAudioTex, vec2(clamp(x, 0.0, 1.0), 0.75)).r - 0.5) * 2.0;
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
 * 1. CLOUD — Volumetric Audio-Reactive Storm Clouds & Internal Lightning Blooms
 * Sculpted 3D cumulus clouds floating over a deep twilight stage that physically billow
 * on bass, flash from within on kick shockwaves, surge along the horizon with live FFT,
 * and catch luminous silver linings on vocals & snares.
 */
const CLOUD_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.42);
  vec3 highlightCol = mix(accentCol, vec3(1.0), 0.34);

  float punch = clamp(uPulse, 0.55, 1.4);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Bass & kick physically inflate the cloud field outward
  float breathScale = 1.0 - bassPower * 0.08 - kickHit * 0.07 - uDrop * 0.035;
  vec2 cp = p * breathScale;

  // Deep atmospheric twilight sky base (preserves rich contrast so clouds & lyrics pop)
  float bgScale = mix(1.0, 0.20, uDarkStage);
  vec3 skyTop = uBackdrop * 0.52 + deepTint * (0.06 + uEnergy * 0.06) * bgScale;
  vec3 skyBottom = uBackdrop * 0.68 + deepTint * (0.14 + bassPower * 0.14) * bgScale;
  vec3 col = mix(skyBottom, skyTop, smoothstep(0.0, 1.0, uv.y));

  // Subtle ambient backlight bloom behind cloud layer
  col += primaryCol * exp(-r * r * 1.55) * (0.08 + bassPower * 0.14 + kickHit * 0.14) * bgScale;

  // Two-layer domain-warped volumetric cumulus clouds
  float t = uFlowTime * 0.20;
  vec2 warp = vec2(
    fbm(cp * 1.20 + vec2(t * 0.42, -t * 0.18)),
    fbm(cp * 1.20 + vec2(-t * 0.28, t * 0.34) + vec2(4.7, 1.9))
  );
  float warpAmp = 0.48 + bassPower * 0.42 + kickHit * 0.25;
  vec2 cloudPos = cp * 1.55 + (warp - 0.5) * warpAmp + vec2(t * 0.22, -t * 0.06);

  float dMain = fbm5(cloudPos);
  float dLit = fbm5(cloudPos + vec2(0.04, 0.12)); // Light from above / behind
  float dBack = fbm(cp * 2.35 - vec2(t * 0.32, t * 0.12));

  // Soft, fluffy cumulus masks (no harsh dark blotches)
  float backCloud = smoothstep(0.42, 0.82, dBack);
  float frontCloud = smoothstep(0.40, 0.78, dMain);
  float cloudCore = smoothstep(0.56, 0.86, dMain);
  // Volumetric directional top-light & luminous silver-lining rim
  float topLight = clamp((dMain - dLit) * 3.8 + 0.48, 0.0, 1.0);
  float silverRim = pow(clamp(1.0 - abs(dMain * 2.0 - 1.06), 0.0, 1.0), 3.4);

  // Back drifting cloud mist layer
  vec3 backShade = mix(deepTint * 0.45, primaryCol * (0.34 + uEnergy * 0.24), backCloud);
  col = mix(col, max(col, backShade), backCloud * 0.58);

  // Expanding kick-drum internal lightning shockwave racing through the cloud cores!
  float waveR = uKickWave * 1.45;
  float shockRing = exp(-abs(r - waveR) * 8.5) * (1.0 - smoothstep(0.50, 1.18, uKickWave)) * uKickWaveAmp;
  float lightningCore = (shockRing * 0.95 + kickHit * exp(-r * r * 1.8) * 0.48) * (0.25 + cloudCore * 1.25);

  // Sculpted front cumulus clouds (velvety shaded belly -> glowing album-colored tops -> internal beat glow)
  vec3 cloudBelly = mix(uBackdrop * 0.55, deepTint * 0.42, 0.65);
  vec3 cloudCrown = mixCoverColor(primaryCol, accentCol, 0.28 + topLight * 0.32) * (0.42 + bassPower * 0.36 + kickHit * 0.28);
  vec3 frontShade = mix(cloudBelly, cloudCrown, smoothstep(0.18, 0.88, topLight));
  frontShade += mixCoverColor(primaryCol, highlightCol, 0.55) * lightningCore * 0.78;
  frontShade += mixCoverColor(accentCol, highlightCol, snareHit * 0.45) * silverRim * (0.26 + uVocal * 0.55 + snareHit * 0.58);

  col = mix(col, frontShade, frontCloud * 0.82);

  // Live Mirrored FFT Cumulus Horizon Bank rising from the bottom with glowing backlit ridge!
  float symX = abs(uv.x - 0.5) * 2.0;
  float freqPos = pow(symX, 0.88) * 0.86 + 0.015;
  float fft = (
    sampleFFT(freqPos - 0.020) * 0.25 +
    sampleFFT(freqPos) * 0.50 +
    sampleFFT(freqPos + 0.020) * 0.25
  );
  float puffNoise = fbm(vec2(uv.x * 5.2 + t * 0.45, 2.2 - t * 0.18));
  float bankH = 0.06 + fft * (0.27 + bassPower * 0.14) + (puffNoise - 0.45) * 0.11;
  float bankBody = smoothstep(bankH + 0.08, bankH - 0.05, uv.y);
  float bankDepth = clamp((bankH - uv.y) / max(bankH, 0.05), 0.0, 1.0);
  float bankRim = exp(-abs(uv.y - bankH) * 26.0) * (0.24 + fft * 0.72 + kickHit * 0.22);

  vec3 bankDark = mix(uBackdrop * 0.45, deepTint * 0.55, 0.65);
  vec3 bankLit = mixCoverColor(primaryCol, accentCol, fft * 0.55) * (0.42 + fft * 0.42);
  vec3 bankColor = mix(bankLit, bankDark, smoothstep(0.05, 0.75, bankDepth));
  col = mix(col, bankColor, bankBody * 0.78);
  col += mixCoverColor(primaryCol, highlightCol, 0.45) * bankRim * (0.58 + bassPower * 0.42);

  // Subtle upper frequency aurora wisp balancing top edge
  float topH = 0.05 + fft * (0.16 + uVocal * 0.10) + (puffNoise - 0.45) * 0.08;
  float topRim = exp(-abs((1.0 - uv.y) - topH) * 24.0) * (0.14 + fft * 0.45);
  col += accentCol * topRim * (0.45 + uVocal * 0.35);

  // Fine glowing cloud-mist sparkle on treble & hi-hats
  float mistSparkle = smoothstep(0.72, 0.94, noise2d(cloudPos * 5.5 + vec2(0.0, t * 1.4))) * frontCloud;
  col += highlightCol * mistSparkle * (uTreble * 0.38 + uHiHat * 0.65);

  // Subtle perimeter kick glow for ambient screen-average LED backlights
  col += primaryCol * smoothstep(0.62, 1.25, r) * (kickHit * 0.16 + bassPower * 0.08);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. WAVE — Layered Musical Ocean Swells & Live Acoustic Ribbon Crests
 * 5 depth-stacked translucent waves visibly driven by bass swells, live FFT bands,
 * phase-locked audio waveform, expanding kick crests, and shimmering treble foam.
 */
const WAVE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

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

  // Atmospheric twilight sky gradient above waves
  float bgScale = mix(1.0, 0.18, uDarkStage);
  vec3 col = uBackdrop + deepTint * (0.07 + (1.0 - uv.y) * 0.14 + uEnergy * 0.12) * bgScale;
  col += primaryCol * exp(-abs(uv.y - 0.52) * 3.8) * (0.08 + bassPower * 0.16 + kickHit * 0.16) * bgScale;

  // LAYER 1 (Back): Giant Sub-Bass Horizon Ocean Swell
  float swell1 = 0.52
    + sin(uv.x * 3.8 + flow * 0.55) * (0.045 + bassPower * 0.055)
    + cos(uv.x * 2.1 - flow * 0.35) * 0.03
    + (fft - 0.25) * (0.20 + bassPower * 0.14)
    + kickHit * 0.055;
  float fill1 = smoothstep(swell1 + 0.02, swell1 - 0.015, uv.y) * exp(-max(swell1 - uv.y, 0.0) * 2.6);
  float rim1 = exp(-abs(uv.y - swell1) * 42.0);
  col += deepTint * fill1 * (0.36 + bassPower * 0.42);
  col += primaryCol * rim1 * (0.26 + fft * 0.48 + kickHit * 0.26);

  // LAYER 2 (Mid-Back): Live FFT Spectrum Translucent Ocean Sheet
  float swell2 = 0.45
    + sin(uv.x * 5.6 - flow * 0.78 + 1.2) * (0.038 + uLowMid * 0.045)
    + fft * (0.22 + uEnergy * 0.12) * (1.0 - symX * 0.25)
    + kickCrestWave * 0.085;
  float fill2 = smoothstep(swell2 + 0.016, swell2 - 0.012, uv.y) * exp(-max(swell2 - uv.y, 0.0) * 3.8);
  float rim2 = exp(-abs(uv.y - swell2) * 58.0);
  vec3 sheet2Col = mixCoverColor(primaryCol, accentCol, 0.35 + fft * 0.35);
  col += sheet2Col * fill2 * (0.28 + fft * 0.48 + kickHit * 0.22);
  col += sheet2Col * rim2 * (0.45 + fft * 0.65 + kickCrestWave * 0.55);

  // LAYER 3 (Mid): Vocal Harmonic Counter-Wave Ribbon
  float vocalAmp = 0.075 + uVocal * 0.095 + snareHit * 0.05;
  float swell3 = 0.49
    - liveWave * (vocalAmp * 0.55)
    + sin(uv.x * 7.4 + flow * 1.15) * (0.025 + uVocal * 0.045)
    + cos(uv.x * 4.0 - flow * 0.6) * 0.02;
  float fill3 = smoothstep(swell3 + 0.012, swell3 - 0.012, uv.y) * exp(-max(swell3 - uv.y, 0.0) * 5.2);
  float rim3 = exp(-abs(uv.y - swell3) * 76.0);
  float glow3 = exp(-abs(uv.y - swell3) * 16.0);
  col += accentCol * fill3 * (0.16 + uVocal * 0.34);
  col += accentCol * (rim3 * (0.58 + uVocal * 0.65 + snareHit * 0.55) + glow3 * (0.16 + uVocal * 0.28));

  // LAYER 4 (Foreground Hero): Crisp Live Acoustic Waveform Crest + Caustic Underwater Glow
  float heroAmp = 0.12 + bassPower * 0.09 + kickHit * 0.065 + uDrop * 0.05;
  float trebleRipple = sin(uv.x * 36.0 - flow * 3.6) * (uTreble * 0.012 + uHiHat * 0.018);
  float heroY = 0.46
    + liveWave * heroAmp
    + sin(uv.x * 4.8 + flow * 0.85) * 0.022
    + kickCrestWave * 0.06
    + trebleRipple;
  float dHero = abs(uv.y - heroY);
  float heroBody = smoothstep(heroY + 0.010, heroY - 0.008, uv.y) * exp(-max(heroY - uv.y, 0.0) * 4.2);
  float heroCore = exp(-dHero * (105.0 - kickHit * 24.0));
  float heroHalo = exp(-dHero * 16.0) * (0.28 + uEnergy * 0.36 + kickHit * 0.34);

  col += mixCoverColor(primaryCol, tertiaryCol, 0.3) * heroBody * (0.24 + bassPower * 0.44 + kickHit * 0.28);
  col += primaryCol * heroHalo;
  col += mix(primaryCol, foamCol, 0.52 + uHiHat * 0.35) * heroCore * (0.85 + kickHit * 0.42 + uHiHat * 0.35);

  // LAYER 5 (Subtle Mirrored Sky Wave Reflection for Full-Screen Depth & Backlight Balance)
  float mirrorY = 0.68 + fft * 0.14 - liveWave * (heroAmp * 0.30) + cos(uv.x * 5.2 - flow * 0.7) * 0.018;
  float dMirror = abs(uv.y - mirrorY);
  float mirrorRibbon = exp(-dMirror * 64.0) * (0.24 + uVocal * 0.38 + uTreble * 0.32);
  float mirrorGlow = exp(-dMirror * 14.0) * (0.09 + fft * 0.22);
  col += mixCoverColor(accentCol, primaryCol, 0.4) * (mirrorRibbon + mirrorGlow);

  // Soft bottom reflection shimmer & perimeter kick swell
  float edgeGlow = smoothstep(0.32, 0.50, abs(uv.y - 0.5));
  col += primaryCol * edgeGlow * (kickHit * 0.22 + bassPower * 0.12);

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
 * 4. OSCILLOSCOPE — Analog Phosphor CRT Studio Oscilloscope
 * Phase-locked zero-crossing waveform trace with slope-compensated uniform beam thickness,
 * dual-channel harmonic echo trace, subtle calibration graticule, and live bottom FFT spectrum.
 */
const OSCILLOSCOPE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.52);
  vec3 phosphorHot = mix(primaryCol, vec3(1.0), 0.48);

  float punch = clamp(uPulse, 0.55, 1.4);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Warm dark CRT phosphor glass backdrop
  float bgScale = mix(1.0, 0.16, uDarkStage);
  float crtVignette = clamp(1.0 - r * r * 0.36, 0.35, 1.0);
  vec3 col = (uBackdrop * 0.72 + deepTint * (0.06 + uEnergy * 0.09 + kickHit * 0.12) * bgScale) * crtVignette;

  // Studio Oscilloscope Calibration Graticule (10x8 divisions + fine center axis ticks)
  vec2 gridUv = (uv - 0.5) * vec2(10.0, 8.0);
  vec2 gridDist = abs(fract(gridUv + 0.5) - 0.5);
  float majorGrid = max(
    smoothstep(0.024, 0.006, gridDist.x),
    smoothstep(0.024, 0.006, gridDist.y)
  );
  float centerAxisX = smoothstep(0.0045, 0.0012, abs(uv.y - 0.5));
  float centerAxisY = smoothstep(0.0035, 0.0010, abs(uv.x - 0.5));
  float subTicksX = smoothstep(0.055, 0.015, abs(fract(uv.x * 50.0 + 0.5) - 0.5)) *
                    smoothstep(0.014, 0.004, abs(uv.y - 0.5));
  float subTicksY = smoothstep(0.055, 0.015, abs(fract(uv.y * 40.0 + 0.5) - 0.5)) *
                    smoothstep(0.009, 0.003, abs(uv.x - 0.5));

  float gridMask = clamp(majorGrid * 0.55 + (centerAxisX + centerAxisY) * 0.55 + (subTicksX + subTicksY) * 0.45, 0.0, 1.0);
  float gridGlow = (0.10 + uEnergy * 0.10 + kickHit * 0.14) * crtVignette;
  col += mix(deepTint, primaryCol, 0.55) * gridMask * gridGlow;

  // Live Mirrored FFT Spectrum Silhouette along the bottom graticule floor
  float symX = abs(uv.x - 0.5) * 2.0;
  float freqPos = pow(symX, 0.88) * 0.86 + 0.015;
  float fft = (
    sampleFFT(freqPos - 0.012) * 0.25 +
    sampleFFT(freqPos) * 0.50 +
    sampleFFT(freqPos + 0.012) * 0.25
  );
  float specHeight = 0.025 + fft * (0.20 + bassPower * 0.07);
  float specFill = smoothstep(specHeight + 0.008, specHeight - 0.005, uv.y) * (0.18 + uv.y * 2.2);
  float specLine = exp(-abs(uv.y - specHeight) * 120.0);
  col += mixCoverColor(primaryCol, accentCol, 0.45) * specFill * (0.18 + fft * 0.34);
  col += accentCol * specLine * (0.34 + fft * 0.65);

  // PRIMARY PHOSPHOR TRACE (Channel 1 — Zero-crossing stabilized real audio waveform!)
  // Slope-compensated perpendicular distance keeps beam crisp & uniform even on steep transients!
  float amp1 = 0.21 + bassPower * 0.11 + kickHit * 0.075 + uDrop * 0.05;
  float dx = 1.0 / 256.0;
  float wL = sampleWave(uv.x - dx);
  float wC = sampleWave(uv.x);
  float wR = sampleWave(uv.x + dx);

  float y1 = 0.5 + wC * amp1;
  float slope1 = ((wR - wL) * amp1) / (2.0 * dx * max(aspect, 0.5));
  float perpDist1 = abs(uv.y - y1) / sqrt(1.0 + slope1 * slope1);

  float beamCore1 = exp(-perpDist1 * (195.0 - kickHit * 48.0));
  float beamInner1 = exp(-perpDist1 * (42.0 - kickHit * 10.0)) * (0.62 + uEnergy * 0.45 + kickHit * 0.48);
  float beamHalo1 = exp(-perpDist1 * 10.5) * (0.24 + bassPower * 0.32 + kickHit * 0.34);

  // Illuminate nearby graticule lines with phosphor bounce light
  col += primaryCol * gridMask * beamHalo1 * 0.65;

  col += primaryCol * beamHalo1;
  col += mixCoverColor(primaryCol, phosphorHot, 0.35) * beamInner1;
  col += phosphorHot * beamCore1 * (0.92 + kickHit * 0.38 + uHiHat * 0.25);

  // SECONDARY TRACE (Channel 2 — Harmonic Vocal Accent Beam, seam-free horizontal span)
  float amp2 = (0.14 + uVocal * 0.10 + snareHit * 0.065) * (0.65 + 0.35 * uAudioActive);
  float x2 = clamp(uv.x * 0.92 + 0.04, 0.0, 1.0);
  float w2L = sampleWave(x2 - dx * 2.0);
  float w2C = (sampleWave(x2 - dx) * 0.25 + sampleWave(x2) * 0.5 + sampleWave(x2 + dx) * 0.25);
  float w2R = sampleWave(x2 + dx * 2.0);

  float y2 = 0.5 - w2C * amp2;
  float slope2 = (-(w2R - w2L) * amp2) / (4.0 * dx * max(aspect, 0.5));
  float perpDist2 = abs(uv.y - y2) / sqrt(1.0 + slope2 * slope2);

  float beamCore2 = exp(-perpDist2 * 185.0) * (0.48 + uVocal * 0.52 + snareHit * 0.45);
  float beamHalo2 = exp(-perpDist2 * 26.0) * (0.24 + uVocal * 0.35 + snareHit * 0.35);
  col += accentCol * (beamHalo2 + beamCore2);

  // Expanding subtle horizontal trigger sweep pulse on kicks
  float trigPulse = exp(-abs(symX - uKickWave * 1.15) * 9.0) *
                    (1.0 - smoothstep(0.45, 1.10, uKickWave)) * uKickWaveAmp;
  col += mixCoverColor(primaryCol, accentCol, 0.5) * trigPulse * (0.14 + beamHalo1 * 0.55);

  // Subtle CRT phosphor scanlines & gentle edge backlight breath
  float scanline = 0.965 + 0.035 * sin(gl_FragCoord.y * 1.5);
  col *= scanline;
  col += primaryCol * smoothstep(0.65, 1.25, r) * (kickHit * 0.16 + bassPower * 0.08);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

export const SHADER_PRESETS: ShaderPresetMeta[] = [
  {
    id: 'cloud',
    name: 'Cloud',
    key: '1',
    tagline: 'Volumetric storm clouds with bass swells, kick lightning & FFT horizon banks',
    fragmentSource: CLOUD_FRAG,
  },
  {
    id: 'wave',
    name: 'Wave',
    key: '2',
    tagline: '5 layered ocean & acoustic waves shaped by live bass, spectrum & melody',
    fragmentSource: WAVE_FRAG,
  },
  {
    id: 'vinyl',
    name: 'Vinyl',
    key: '3',
    tagline: 'Spinning 12" vinyl with live album label, spectrum grooves & reactive stylus',
    fragmentSource: VINYL_FRAG,
  },
  {
    id: 'oscilloscope',
    name: 'Oscilloscope',
    key: '4',
    tagline: 'Phase-locked analog phosphor CRT waveform & live spectrum floor',
    fragmentSource: OSCILLOSCOPE_FRAG,
  },
  {
    id: 'blank',
    name: 'Blank',
    key: '5',
    tagline: 'Clean solid-color background with zero motion',
    fragmentSource: '',
  },
];
