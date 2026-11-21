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
    p = rot * p * 2.02 + vec2(11.3, 7.9);
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

vec3 finalizeLedColor(vec3 col) {
  col = max(col, vec3(0.0));
  float peak = max(col.r, max(col.g, col.b));
  if (peak > 0.86) {
    float compressed = 0.86 + (1.0 - exp(-(peak - 0.86) * 1.5)) * 0.14;
    col *= compressed / peak;
  }
  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 59.0) - 0.5) / 255.0;
  return clamp(col * uFade + dither, 0.0, 1.0);
}
`;

/**
 * 1. PULSE WASH — Calm, velvety breathing concert wash
 * Slow silk aurora gliding across the cover's colors, breathing smoothly with bass & vocals
 * without frantic strobe flashes or aggressive zoom snaps.
 */
const PULSE_WASH_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.68);

  float punch = clamp(uPulse, 0.4, 1.3);
  float kickBreath = clamp(uKick * punch, 0.0, 0.9);
  float snareSoft = clamp(uSnare * punch, 0.0, 0.75);
  float dropLift = uDrop * 0.16;

  // Gentle, calm breathing zoom
  vec2 zp = p * (1.0 - kickBreath * 0.035 - uSubBass * 0.02);

  // Slow, hypnotic silk flow
  float t = uFlowTime * 0.15;
  float n1 = fbm(zp * 1.35 + vec2(t * 0.55, -t * 0.32));
  float n2 = fbm(zp * 1.95 - vec2(t * 0.40, t * 0.45) + n1 * (1.05 + uBass * 0.35));
  float silk = pow(smoothstep(mix(0.24, 0.42, uDarkStage), 0.94, n2), mix(1.5, 2.0, uDarkStage));
  float ridge = pow(clamp(1.0 - abs(n2 * 2.0 - 1.0), 0.0, 1.0), mix(3.4, 4.6, uDarkStage));

  float bgScale = mix(1.0, 0.05, uDarkStage);
  float baseFloor = (0.09 + uEnergy * 0.12 + dropLift * 0.14 + kickBreath * 0.16) * bgScale;
  vec3 col = uBackdrop + deepTint * baseFloor;

  // Lush slow silk clouds breathing with bass & kicks
  float silkEnergy = silk * (0.14 + uBass * 0.26 + kickBreath * 0.28 + dropLift * 0.16);
  col += primaryCol * silkEnergy;

  // Delicate secondary album color veins
  col += accentCol * ridge * (0.12 + uVocal * 0.24 + snareSoft * 0.20) * mix(1.0, 0.72, uDarkStage);

  // Soft bottom & top ambient spectrum mist (gentle backlight movement without harsh flicker)
  float symX = abs(uv.x - 0.5) * 2.0;
  float fft = sampleFFT(pow(symX, 0.88) * 0.84 + 0.02);
  float curtainScale = mix(1.0, 0.48, uDarkStage);
  float bottomMist = exp(-uv.y * (5.2 - fft * 1.8 - kickBreath * 0.6)) * (0.12 + fft * 0.42) * curtainScale;
  float topMist = exp(-(1.0 - uv.y) * (5.8 - fft * 1.4)) * (0.07 + fft * 0.26) * curtainScale;
  col += mixCoverColor(primaryCol, accentCol, fft * 0.45) * (bottomMist + topMist) * (0.42 + uBass * 0.32);

  // Warm soft center vocal glow
  float vocalAura = exp(-r * r * (3.6 - uVocal * 0.65)) * (0.06 + uVocal * 0.20 + kickBreath * 0.10) * mix(1.0, 0.45, uDarkStage);
  col += primaryCol * vocalAura;

  // Smooth perimeter breath for average-screen-color backlights
  float edgeBand = smoothstep(0.55, 1.18, r);
  col += primaryCol * edgeBand * (kickBreath * 0.18 + uSubBass * 0.10) * mix(1.0, 0.62, uDarkStage);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. BASS ECLIPSE — Serene High-Contrast Radial Halo
 * Clean dark stage with a smooth glowing ring, damped radial EQ bars, and gentle beat swells.
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
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.68);

  float punch = clamp(uPulse, 0.4, 1.3);
  float kickBreath = clamp(uKick * punch, 0.0, 0.9);
  float snareSoft = clamp(uSnare * punch, 0.0, 0.75);

  float symAngle = abs(angle) / 3.14159265;
  float wave = sampleWave(symAngle);

  float spokeCount = 64.0;
  float spokeId = floor((angle + 3.14159265) / 6.2831853 * spokeCount);
  float spokeLocal = fract((angle + 3.14159265) / 6.2831853 * spokeCount) - 0.5;
  float spokeAngleNorm = abs((spokeId / spokeCount) * 2.0 - 1.0);
  float spokeFft = sampleFFT(pow(spokeAngleNorm, 0.9) * 0.84 + 0.02);
  float spokeMask = smoothstep(0.36, 0.15, abs(spokeLocal));

  // Calm dark stage with gentle breathing glow
  float bgScale = mix(1.0, 0.22, uDarkStage);
  float roomGlow = (0.05 + uEnergy * 0.08 + uDrop * 0.09 + kickBreath * 0.20) * bgScale;
  float subtleCloud = fbm(p * 1.6 + vec2(uFlowTime * 0.12, -uFlowTime * 0.09));
  vec3 col = uBackdrop + mix(deepTint, primaryCol, subtleCloud) * roomGlow;

  // Smooth perimeter swell on kicks (no sudden strobe blast)
  float edgeFactor = smoothstep(0.48, 1.12, r);
  col += primaryCol * edgeFactor * (kickBreath * 0.24 + uSubBass * 0.12);
  col += accentCol * edgeFactor * snareSoft * 0.14;

  // Serene eclipse ring expanding smoothly with bass
  float innerR = 0.27 + uSubBass * 0.026 + kickBreath * 0.028;
  float outerBarR = innerR + 0.018 + spokeFft * (0.14 + uBass * 0.055);

  float rimDist = abs(r - innerR);
  float rimCore = exp(-rimDist * 70.0) * (0.62 + kickBreath * 0.45);
  float rimHalo = exp(-rimDist * 13.0) * (0.16 + uBass * 0.24 + kickBreath * 0.24);

  // Smooth radial FFT spokes
  float inBar = smoothstep(innerR - 0.008, innerR + 0.006, r) *
                smoothstep(outerBarR + 0.014, outerBarR - 0.006, r);
  float barTip = exp(-abs(r - outerBarR) * 65.0) * spokeMask * (0.26 + spokeFft * 0.58);
  float barGlow = inBar * spokeMask * (0.36 + spokeFft * 0.65);

  // Subtle inner vocal filament
  float waveR = innerR - 0.042 + wave * (0.022 + uVocal * 0.022);
  float waveRing = exp(-abs(r - waveR) * 95.0) * (0.32 + uVocal * 0.48);

  col += mixCoverColor(primaryCol, accentCol, 0.35) * rimCore;
  col += primaryCol * rimHalo;
  col += mixCoverColor(primaryCol, accentCol, spokeFft * 0.5) * barGlow;
  col += accentCol * barTip;
  col += accentCol * waveRing;

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 3. CHROMATIC TIDE — Graceful Ocean Waves & Smooth Audio Ribbon
 * Slow, wide rolling liquid swells with a calm, silk-smooth audio ribbon.
 */
const CHROMATIC_TIDE_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.68);

  float punch = clamp(uPulse, 0.4, 1.3);
  float kickBreath = clamp(uKick * punch, 0.0, 0.9);
  float snareSoft = clamp(uSnare * punch, 0.0, 0.75);

  // Multi-tap smoothed waveform so the ribbon flows like silk instead of buzzing
  float smoothWave = (
    sampleWave(uv.x - 0.025) * 0.15 +
    sampleWave(uv.x - 0.012) * 0.22 +
    sampleWave(uv.x) * 0.26 +
    sampleWave(uv.x + 0.012) * 0.22 +
    sampleWave(uv.x + 0.025) * 0.15
  );

  float symX = abs(uv.x - 0.5) * 2.0;
  float fft = sampleFFT(pow(symX, 0.9) * 0.82 + 0.02);

  // Slow rolling liquid tide backdrop
  float flow = uFlowTime * 0.20;
  float tideField = sin(p.x * 2.2 + flow) * cos(p.y * 2.4 - flow * 0.55) * 0.5 + 0.5;
  float fbmTide = fbm(p * 1.8 + vec2(flow * 0.25, -flow * 0.16));
  float bgMix = pow(mix(tideField, fbmTide, 0.62), 1.45);

  float bgScale = mix(1.0, 0.12, uDarkStage);
  float globalLum = (0.09 + uEnergy * 0.12 + uDrop * 0.10 + kickBreath * 0.16) * bgScale;
  vec3 col = uBackdrop + mix(deepTint, primaryCol, bgMix) * (globalLum + bgMix * (0.09 + uBass * 0.16) * bgScale);

  // Wide soft mirrored bass swell
  float distCenterY = abs(uv.y - 0.5);
  float bassEnvelope = 0.045 + fft * (0.17 + uBass * 0.10 + kickBreath * 0.06);
  float tideBody = smoothstep(bassEnvelope + 0.14, bassEnvelope * 0.06, distCenterY);
  col += primaryCol * tideBody * (0.18 + uBass * 0.26 + kickBreath * 0.20);

  // Calm primary waveform ribbon
  float amp = 0.08 + uBass * 0.05 + kickBreath * 0.035;
  float yWave1 = 0.5 + smoothWave * amp + sin(uv.x * 5.0 + uFlowTime * 0.9) * 0.014;
  float dWave1 = abs(uv.y - yWave1);
  float ribbonCore = exp(-dWave1 * 88.0);
  float ribbonGlow = exp(-dWave1 * 14.0) * (0.22 + uEnergy * 0.28 + kickBreath * 0.24);

  // Gentle secondary vocal wave
  float yWave2 = 0.5 - smoothWave * (amp * 0.55) + cos(uv.x * 6.5 - uFlowTime * 0.75) * 0.016;
  float dWave2 = abs(uv.y - yWave2);
  float ribbon2 = exp(-dWave2 * 100.0) * (0.36 + uVocal * 0.45 + snareSoft * 0.30);
  float glow2 = exp(-dWave2 * 18.0) * (0.14 + uVocal * 0.22);

  col += mixCoverColor(primaryCol, accentCol, 0.35) * ribbonCore * (0.78 + kickBreath * 0.30);
  col += primaryCol * ribbonGlow;
  col += accentCol * (ribbon2 + glow2);

  // Soft perimeter breath
  col += primaryCol * smoothstep(0.35, 0.5, distCenterY) * (kickBreath * 0.18 + snareSoft * 0.10);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 4. SPECTRUM WALL — Calm Frosted Kinetic Frequency Pillars
 * 48 architectural frequency bars rising smoothly in true album colors with gentle ambient breathing.
 */
const SPECTRUM_WALL_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.66);

  float punch = clamp(uPulse, 0.4, 1.3);
  float kickBreath = clamp(uKick * punch, 0.0, 0.9);
  float snareSoft = clamp(uSnare * punch, 0.0, 0.75);

  float numCols = 48.0;
  float colIndex = floor(uv.x * numCols);
  float colLocalX = fract(uv.x * numCols) - 0.5;
  float colCenterNorm = (colIndex + 0.5) / numCols;
  float symNorm = abs(colCenterNorm - 0.5) * 2.0;

  float freqPos = pow(symNorm, 0.85) * 0.88 + 0.015;
  float fft = (
    sampleFFT(freqPos - 0.016) * 0.25 +
    sampleFFT(freqPos) * 0.5 +
    sampleFFT(freqPos + 0.016) * 0.25
  );

  float pillarHalfH = clamp(
    0.035 + fft * (0.24 + uEnergy * 0.06) + kickBreath * (1.0 - symNorm * 0.7) * 0.055,
    0.035,
    0.40
  );
  float distY = abs(uv.y - 0.5);
  float colMask = smoothstep(0.42, 0.28, abs(colLocalX));

  float bgScale = mix(1.0, 0.12, uDarkStage);
  float wallGlow = (0.07 + uEnergy * 0.10 + uDrop * 0.10 + kickBreath * 0.16) * bgScale;
  float verticalGrad = 1.0 - distY * 0.4;
  vec3 col = uBackdrop + mix(deepTint, primaryCol, verticalGrad) * wallGlow;

  // Soft spill glow behind active pillars
  float spill = exp(-max(distY - pillarHalfH * 0.65, 0.0) * 8.2) * (0.10 + fft * 0.26);
  col += primaryCol * spill * (0.40 + uEnergy * 0.28);

  // Smooth frosted pillar body
  float insidePillar = smoothstep(pillarHalfH + 0.014, pillarHalfH - 0.008, distY) * colMask;
  float verticalPos = clamp(distY / max(pillarHalfH, 0.001), 0.0, 1.0);
  vec3 pillarCol = mixCoverColor(primaryCol, accentCol, pow(verticalPos, 1.8) * 0.6);
  float pillarLum = 0.34 + verticalPos * 0.26 + fft * 0.44 + kickBreath * 0.16;
  col += pillarCol * insidePillar * pillarLum;

  // Clean luminous bar tip
  float capDist = abs(distY - pillarHalfH);
  float capGlow = exp(-capDist * 85.0) * colMask * (0.34 + fft * 0.68);
  col += accentCol * capGlow;

  // Subtle center horizon line
  float centerBeam = exp(-distY * 72.0) * (0.14 + uVocal * 0.28 + snareSoft * 0.32);
  col += mixCoverColor(primaryCol, accentCol, 0.5) * centerBeam;

  // Soft perimeter breath
  float perimeter = smoothstep(0.36, 0.50, distY);
  col += primaryCol * perimeter * (kickBreath * 0.18 + uSubBass * 0.12);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

export const SHADER_PRESETS: ShaderPresetMeta[] = [
  {
    id: 'pulse',
    name: 'Pulse Wash',
    key: '1',
    tagline: 'Calm breathing velvet wash & subtle bass glow',
    fragmentSource: PULSE_WASH_FRAG,
  },
  {
    id: 'eclipse',
    name: 'Bass Eclipse',
    key: '2',
    tagline: 'Serene dark stage with smooth radial EQ halo',
    fragmentSource: BASS_ECLIPSE_FRAG,
  },
  {
    id: 'tide',
    name: 'Chromatic Tide',
    key: '3',
    tagline: 'Graceful rolling ocean waves & silk waveform ribbon',
    fragmentSource: CHROMATIC_TIDE_FRAG,
  },
  {
    id: 'spectrum',
    name: 'Spectrum Wall',
    key: '4',
    tagline: '48 smooth frosted kinetic frequency pillars',
    fragmentSource: SPECTRUM_WALL_FRAG,
  },
  {
    id: 'blank',
    name: 'Blank',
    key: '5',
    tagline: 'Clean solid-color background with zero motion',
    fragmentSource: '',
  },
];
