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
uniform vec3 uBackdrop;
uniform float uDarkStage;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform sampler2D uAudioTex;

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
    p = rot * p * 2.04 + vec2(11.3, 7.9);
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

// Subtle shade variation that NEVER injects fake saturation into neutral white/silver!
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

// Hue-preserving soft-knee tonemapper (keeps gold gold, red red, silver silver, black black)
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
 * 1. PULSE WASH — Concert Wall Wash faithful to the album's real colors
 * On black-backed covers (RAM, Sick Boi, B&W), negative space stays true jet black while
 * primary & secondary album colors (e.g. Gold + Silver, or Crimson + White) surge cleanly on beats.
 */
const PULSE_WASH_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.72);

  float punch = clamp(uPulse, 0.4, 2.0);
  float kickHit = clamp(uKick * punch, 0.0, 1.15);
  float snareHit = clamp(uSnare * punch, 0.0, 1.1);
  float dropLift = uDrop * 0.22;

  vec2 zp = p * (1.0 - kickHit * 0.12 - uSubBass * 0.05);

  // Flowing silk wave field — tighter contrast on dark-backed covers so true black negative space shines!
  float t = uFlowTime * 0.34;
  float n1 = fbm(zp * 1.7 + vec2(t * 0.72, -t * 0.42));
  float n2 = fbm(zp * 2.5 - vec2(t * 0.52, t * 0.62) + n1 * (1.35 + uBass * 0.85));
  float silk = pow(smoothstep(mix(0.22, 0.40, uDarkStage), 0.92, n2), mix(1.5, 2.1, uDarkStage));
  float ridge = pow(clamp(1.0 - abs(n2 * 2.0 - 1.0), 0.0, 1.0), mix(3.2, 4.5, uDarkStage));

  // True black negative space when album cover is dark-dominant; rich tinted wash on colorful covers
  float bgScale = mix(1.0, 0.05, uDarkStage);
  float baseFloor = (0.08 + uEnergy * 0.14 + dropLift * 0.16 + kickHit * 0.22) * bgScale;
  vec3 col = uBackdrop + deepTint * baseFloor;

  // Silk light ribbons emerging cleanly from the black void in primary cover color
  float silkEnergy = silk * (0.14 + uBass * 0.34 + kickHit * 0.44 + dropLift * 0.20);
  col += primaryCol * silkEnergy;

  // Crisp secondary album color veins (e.g. Silver alongside Gold on RAM, or crisp White on B&W)
  col += accentCol * ridge * (0.16 + uVocal * 0.34 + kickHit * 0.36) * mix(1.0, 0.72, uDarkStage);

  // Expanding concentric kick shockwave rolling center -> edges
  float waveR = fract(uFlowTime * 0.52) * 1.35;
  float shockRing = exp(-abs(r - waveR) * 16.0) * (1.0 - waveR / 1.35);
  col += mixCoverColor(primaryCol, accentCol, 0.45) * shockRing * (0.14 + kickHit * 0.82 + uSubBass * 0.26);

  // Live FFT spectrum light curtains rising from bottom & top edges
  float symX = abs(uv.x - 0.5) * 2.0;
  float fft = sampleFFT(pow(symX, 0.85) * 0.86 + 0.02);
  float curtainScale = mix(1.0, 0.52, uDarkStage);
  float bottomCurtain = exp(-uv.y * (5.6 - fft * 2.4 - kickHit * 0.9)) * (0.14 + fft * 0.68) * curtainScale;
  float topCurtain = exp(-(1.0 - uv.y) * (6.0 - fft * 2.0 - uTreble * 1.0)) * (0.08 + fft * 0.42) * curtainScale;
  col += mixCoverColor(primaryCol, accentCol, fft * 0.55) * (bottomCurtain + topCurtain) * (0.36 + uBass * 0.44);

  // Snare diagonal spotlight sweep in the cover's secondary accent color
  float sweepCoord = dot(p, normalize(vec2(1.0, 0.55))) - sin(uTime * 1.7) * 0.42;
  float snareBeam = exp(-abs(sweepCoord) * 5.2) * snareHit;
  col += accentCol * snareBeam * 0.52;

  // Subtle vocal halo behind lyrics (restrained on dark-stage covers so black stays deep)
  float vocalAura = exp(-r * r * (3.8 - uVocal * 1.0)) * (0.06 + uVocal * 0.26 + kickHit * 0.14) * mix(1.0, 0.42, uDarkStage);
  col += primaryCol * vocalAura;

  // Kick perimeter bounce so average-screen-color backlights punch crisply on drums
  float edgeBand = smoothstep(0.55, 1.15, r);
  col += primaryCol * edgeBand * (uHiHat * 0.18 + kickHit * 0.26) * mix(1.0, 0.65, uDarkStage);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. BASS ECLIPSE — High-Contrast Impact Reactor
 * Pitch-black void on dark covers with a blazing radial 64-spoke EQ ring in primary cover color,
 * secondary album color crest tips & snare corona, and crisp kick perimeter flares.
 */
const BASS_ECLIPSE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);
  float angle = atan(p.y, p.x);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.70);

  float punch = clamp(uPulse, 0.4, 2.0);
  float kickHit = clamp(uKick * punch, 0.0, 1.18);
  float snareHit = clamp(uSnare * punch, 0.0, 1.15);

  float symAngle = abs(angle) / 3.14159265;
  float fft = sampleFFT(pow(symAngle, 0.92) * 0.85 + 0.02);
  float wave = sampleWave(symAngle);

  // Quantized 64-spoke radial EQ bars around the eclipse ring
  float spokeCount = 64.0;
  float spokeId = floor((angle + 3.14159265) / 6.2831853 * spokeCount);
  float spokeLocal = fract((angle + 3.14159265) / 6.2831853 * spokeCount) - 0.5;
  float spokeAngleNorm = abs((spokeId / spokeCount) * 2.0 - 1.0);
  float spokeFft = sampleFFT(pow(spokeAngleNorm, 0.9) * 0.84 + 0.02);
  float spokeMask = smoothstep(0.35, 0.14, abs(spokeLocal));

  // True black background between beats on dark covers; dramatic kick pulse across outer stage
  float bgScale = mix(1.0, 0.28, uDarkStage);
  float roomFlash = (0.05 + uEnergy * 0.09 + uDrop * 0.12 + kickHit * 0.34 + snareHit * 0.14) * bgScale;
  float subtleCloud = fbm(p * 1.9 + vec2(uFlowTime * 0.22, -uFlowTime * 0.16));
  vec3 col = uBackdrop + mix(deepTint, primaryCol, subtleCloud) * roomFlash;

  // Outer perimeter bounce-light surge on kick & snare (keeps dark core pitch-black!)
  float edgeFactor = smoothstep(0.42, 1.05, r);
  col += primaryCol * edgeFactor * (kickHit * 0.42 + uSubBass * 0.16);
  col += accentCol * edgeFactor * snareHit * 0.32;

  // Core eclipse ring expanding crisply with sub-bass & kick
  float innerR = 0.26 + uSubBass * 0.045 + kickHit * 0.055;
  float outerBarR = innerR + 0.02 + spokeFft * (0.22 + uBass * 0.10);

  // Crisp glowing inner eclipse rim
  float rimDist = abs(r - innerR);
  float rimCore = exp(-rimDist * 75.0) * (0.75 + kickHit * 0.85);
  float rimHalo = exp(-rimDist * 14.0) * (0.18 + uBass * 0.34 + kickHit * 0.40);

  // High-contrast radial FFT spikes jumping cleanly outward from the eclipse
  float inBar = smoothstep(innerR - 0.008, innerR + 0.006, r) *
                smoothstep(outerBarR + 0.012, outerBarR - 0.006, r);
  float barTip = exp(-abs(r - outerBarR) * 65.0) * spokeMask * (0.35 + spokeFft * 0.85);
  float barGlow = inBar * spokeMask * (0.48 + spokeFft * 0.90);

  // Live inner waveform filament inside the eclipse in secondary accent color
  float waveR = innerR - 0.042 + wave * (0.036 + uVocal * 0.04);
  float waveRing = exp(-abs(r - waveR) * 95.0) * (0.45 + uVocal * 0.78);

  // Fast outer shockwave blast
  float shockR = 0.28 + (1.0 - clamp(kickHit, 0.0, 1.0)) * 0.82;
  float shock = exp(-abs(r - shockR) * 18.0) * kickHit * 0.70;

  col += mixCoverColor(primaryCol, accentCol, 0.35) * rimCore;
  col += primaryCol * rimHalo;
  col += mixCoverColor(primaryCol, accentCol, spokeFft * 0.55) * barGlow;
  col += accentCol * barTip;
  col += accentCol * waveRing;
  col += mixCoverColor(primaryCol, accentCol, 0.4) * shock;
  col += accentCol * exp(-abs(r - (innerR + fft * 0.14)) * 26.0) * uHiHat * 0.42;

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 3. CHROMATIC TIDE — Living Dual-Tone Waveform & Bass Tides
 * Edge-to-edge real-time waveform ribbons in primary + secondary cover colors gliding across
 * a true-black or deep-cover backdrop.
 */
const CHROMATIC_TIDE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.72);

  float punch = clamp(uPulse, 0.4, 2.0);
  float kickHit = clamp(uKick * punch, 0.0, 1.18);
  float snareHit = clamp(uSnare * punch, 0.0, 1.15);

  float wave = sampleWave(uv.x);
  float waveL = sampleWave(uv.x - 0.014);
  float waveR = sampleWave(uv.x + 0.014);
  float smoothWave = (waveL + wave * 2.0 + waveR) * 0.25;

  float symX = abs(uv.x - 0.5) * 2.0;
  float fft = sampleFFT(pow(symX, 0.9) * 0.82 + 0.02);

  // Background tide respects true black on dark covers while staying lush on colorful covers
  float flow = uFlowTime * 0.48;
  float tideField = sin(p.x * 2.8 + flow) * cos(p.y * 3.2 - flow * 0.7) * 0.5 + 0.5;
  float fbmTide = fbm(p * 2.3 + vec2(flow * 0.35, -flow * 0.22));
  float bgMix = pow(mix(tideField, fbmTide, 0.62), 1.45);

  float bgScale = mix(1.0, 0.14, uDarkStage);
  float globalLum = (0.09 + uEnergy * 0.15 + uDrop * 0.14 + kickHit * 0.24) * bgScale;
  vec3 col = uBackdrop + mix(deepTint, primaryCol, bgMix) * (globalLum + bgMix * (0.10 + uBass * 0.22) * bgScale);

  // Center-anchored mirrored bass tide surge emerging in primary cover color
  float distCenterY = abs(uv.y - 0.5);
  float bassEnvelope = 0.05 + fft * (0.24 + uBass * 0.15 + kickHit * 0.12);
  float tideBody = smoothstep(bassEnvelope + 0.12, bassEnvelope * 0.06, distCenterY);
  col += primaryCol * tideBody * (0.24 + uBass * 0.34 + kickHit * 0.32);

  // Horizontal harmonic ripple waves radiating outward from center
  float ripples = sin(distCenterY * 28.0 - uFlowTime * 4.8) * 0.5 + 0.5;
  ripples = pow(ripples, 3.8) * exp(-distCenterY * 2.8);
  col += mixCoverColor(primaryCol, accentCol, 0.5) * ripples * (0.12 + kickHit * 0.56 + uSubBass * 0.26);

  // Primary electric real-time waveform ribbon in primary album color
  float amp = 0.14 + uBass * 0.10 + kickHit * 0.08;
  float yWave1 = 0.5 + smoothWave * amp + sin(uv.x * 8.0 + uFlowTime * 2.2) * 0.015;
  float dWave1 = abs(uv.y - yWave1);
  float ribbonCore = exp(-dWave1 * (95.0 - kickHit * 24.0));
  float ribbonGlow = exp(-dWave1 * 15.0) * (0.28 + uEnergy * 0.40 + kickHit * 0.42);

  // Secondary offset harmonic waveform in secondary album color (e.g. Silver on RAM, White on Sick Boi!)
  float yWave2 = 0.5 - smoothWave * (amp * 0.62) + cos(uv.x * 11.0 - uFlowTime * 1.9) * 0.018;
  float dWave2 = abs(uv.y - yWave2);
  float ribbon2 = exp(-dWave2 * 100.0) * (0.55 + uVocal * 0.68 + snareHit * 0.58);
  float glow2 = exp(-dWave2 * 18.0) * (0.20 + uVocal * 0.32);

  // Crisp hi-hat sparkles along the waveform crest
  float sparkleNoise = hash21(vec2(floor(uv.x * 140.0), floor(uTime * 18.0)));
  float sparkle = step(0.92, sparkleNoise) * exp(-dWave1 * 42.0) * (uHiHat * 1.2 + uTreble * 0.55);

  col += mixCoverColor(primaryCol, accentCol, 0.35) * ribbonCore * (0.95 + kickHit * 0.45);
  col += primaryCol * ribbonGlow;
  col += accentCol * (ribbon2 + glow2);
  col += accentCol * sparkle * 0.68;

  // Perimeter kick bounce
  col += primaryCol * smoothstep(0.32, 0.5, distCenterY) * (kickHit * 0.28 + snareHit * 0.16);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 4. SPECTRUM WALL — 48 Kinetic Frequency Pillars on True Cover Backdrop
 * Pitch-black negative space on dark covers with glowing primary pillars + crisp secondary
 * album-color peak caps (e.g. Gold pillars with Silver tips on RAM, Crimson pillars with White tips on Sick Boi).
 */
const SPECTRUM_WALL_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.68);

  float punch = clamp(uPulse, 0.4, 2.0);
  float kickHit = clamp(uKick * punch, 0.0, 1.18);
  float snareHit = clamp(uSnare * punch, 0.0, 1.15);

  float numCols = 48.0;
  float colIndex = floor(uv.x * numCols);
  float colLocalX = fract(uv.x * numCols) - 0.5;
  float colCenterNorm = (colIndex + 0.5) / numCols;
  float symNorm = abs(colCenterNorm - 0.5) * 2.0;

  float freqPos = pow(symNorm, 0.85) * 0.88 + 0.015;
  float fft = (
    sampleFFT(freqPos - 0.012) * 0.25 +
    sampleFFT(freqPos) * 0.5 +
    sampleFFT(freqPos + 0.012) * 0.25
  );

  float pillarHalfH = clamp(
    0.04 + fft * (0.29 + uEnergy * 0.09) + kickHit * (1.0 - symNorm * 0.7) * 0.10,
    0.04,
    0.45
  );
  float distY = abs(uv.y - 0.5);

  float colMask = smoothstep(0.42, 0.28, abs(colLocalX));

  // Backdrop respects true black on dark covers while glowing cleanly behind the bars
  float bgScale = mix(1.0, 0.14, uDarkStage);
  float wallGlow = (0.08 + uEnergy * 0.12 + uDrop * 0.12 + kickHit * 0.22 + snareHit * 0.10) * bgScale;
  float verticalGrad = 1.0 - distY * 0.4;
  vec3 col = uBackdrop + mix(deepTint, primaryCol, verticalGrad) * wallGlow;

  // Soft vertical spill glow around active pillars
  float spill = exp(-max(distY - pillarHalfH * 0.65, 0.0) * 7.8) * (0.12 + fft * 0.34);
  col += primaryCol * spill * (0.45 + uEnergy * 0.35);

  // Glowing pillar body transitioning smoothly from primary cover color toward secondary cover color at peak
  float insidePillar = smoothstep(pillarHalfH + 0.012, pillarHalfH - 0.008, distY) * colMask;
  float verticalPos = clamp(distY / max(pillarHalfH, 0.001), 0.0, 1.0);
  vec3 pillarCol = mixCoverColor(primaryCol, accentCol, pow(verticalPos, 1.8) * 0.65);
  float pillarLum = 0.42 + verticalPos * 0.32 + fft * 0.56 + kickHit * 0.25;
  col += pillarCol * insidePillar * pillarLum;

  // Razor-sharp glowing cap at the peak of every frequency bar in secondary accent color
  float capDist = abs(distY - pillarHalfH);
  float capGlow = exp(-capDist * 85.0) * colMask * (0.48 + fft * 0.95 + uHiHat * 0.35);
  col += accentCol * capGlow;

  // Center horizon beam pulsing crisply on snares & vocals
  float centerBeam = exp(-distY * 68.0) * (0.20 + uVocal * 0.45 + snareHit * 0.68);
  col += mixCoverColor(primaryCol, accentCol, 0.5) * centerBeam;

  // Top & bottom kick bounce for edge/avg backlights
  float perimeter = smoothstep(0.35, 0.50, distY);
  col += primaryCol * perimeter * (kickHit * 0.26 + uSubBass * 0.16 + uDrop * 0.14);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

export const SHADER_PRESETS: ShaderPresetMeta[] = [
  {
    id: 'pulse',
    name: 'Pulse Wash',
    key: '1',
    tagline: 'True-cover concert wash & kick shockwaves',
    fragmentSource: PULSE_WASH_FRAG,
  },
  {
    id: 'eclipse',
    name: 'Bass Eclipse',
    key: '2',
    tagline: 'High-contrast dark stage with radial EQ & beat flashes',
    fragmentSource: BASS_ECLIPSE_FRAG,
  },
  {
    id: 'tide',
    name: 'Chromatic Tide',
    key: '3',
    tagline: 'Edge-to-edge living dual-tone waveform & bass tides',
    fragmentSource: CHROMATIC_TIDE_FRAG,
  },
  {
    id: 'spectrum',
    name: 'Spectrum Wall',
    key: '4',
    tagline: '48 kinetic frequency pillars in true album colors',
    fragmentSource: SPECTRUM_WALL_FRAG,
  },
];
