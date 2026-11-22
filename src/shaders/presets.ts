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

// 7 precision frequency bands + combined treble & energy
uniform float uSubBass;
uniform float uBass;
uniform float uLowMid;
uniform float uVocal;
uniform float uPresence;
uniform float uBrilliance;
uniform float uAir;
uniform float uTreble;
uniform float uEnergy;

// 4 independent percussion / onset detectors
uniform float uKick;
uniform float uSnare;
uniform float uHiHat;
uniform float uTransient;

// Song dynamics, timbre, stereo & layout
uniform float uDrop;
uniform float uColorIndex;
uniform float uColorCycle;
uniform float uPulse;
uniform float uAudioActive;
uniform float uFade;
uniform float uCentroid;
uniform float uTonality;
uniform float uCrest;
uniform float uStereoWidth;
uniform float uStereoBalance;
uniform float uLyricsActive;
uniform float uHistoryHead;

// Harmonic 12-note Chromagram (C..B) & physical traveling shockwave ring ages
uniform float uChroma[12];
uniform float uKickWaves[6];
uniform float uSnareWaves[4];

// Album glow palette
uniform vec3 uBackdrop;
uniform float uDarkStage;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;

// uAudioTex: 256x10 R8 (row 0 FFT, 1 Peak, 2 Flux, 3 Wave, 4 L-FFT, 5 R-FFT, 6 L-Wave, 7 R-Wave, 8 BassWave, 9 AirWave)
uniform sampler2D uAudioTex;
// uHistoryTex: 256x64 RGBA8 rolling ring buffer (R: FFT, G: Stereo Pan, B: Flux, A: Wave)
uniform sampler2D uHistoryTex;

float sampleRow(float x, float rowIdx) {
  return texture(uAudioTex, vec2(clamp(x, 0.0, 1.0), (rowIdx + 0.5) / 10.0)).r;
}

float sampleFFT(float x) { return sampleRow(x, 0.0); }
float samplePeak(float x) { return sampleRow(x, 1.0); }
float sampleFlux(float x) { return sampleRow(x, 2.0); }
float sampleWave(float x) { return (sampleRow(x, 3.0) - 0.5) * 2.0; }
float sampleLeftFFT(float x) { return sampleRow(x, 4.0); }
float sampleRightFFT(float x) { return sampleRow(x, 5.0); }
float sampleLeftWave(float x) { return (sampleRow(x, 6.0) - 0.5) * 2.0; }
float sampleRightWave(float x) { return (sampleRow(x, 7.0) - 0.5) * 2.0; }
float sampleBassWave(float x) { return (sampleRow(x, 8.0) - 0.5) * 2.0; }
float sampleTrebleWave(float x) { return (sampleRow(x, 9.0) - 0.5) * 2.0; }

vec4 sampleHistory(float x, float age01) {
  float y = fract(uHistoryHead - clamp(age01, 0.0, 0.96) * 0.96);
  return texture(uHistoryTex, vec2(clamp(x, 0.0, 1.0), y));
}

// Smoothly samples the 12-note Chromagram around 0..1 using constant-indexed unrolled blending
float sampleChroma(float pos01) {
  float p = fract(pos01) * 12.0;
  float total = 0.0;
  float wSum = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float d = abs(p - fi);
    d = min(d, 12.0 - d);
    float w = max(0.0, 1.0 - d);
    total += uChroma[i] * w;
    wSum += w;
  }
  return total / max(wSum, 0.001);
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

// Crisp jittered circular micro-sparkle / starlight pinpoint (zero blocky grid squares)
float microSparkField(vec2 coord, float density, float timeStep, float threshold) {
  vec2 scaled = coord * density;
  vec2 cell = floor(scaled);
  vec2 f = fract(scaled) - 0.5;
  float rnd = hash21(cell + timeStep);
  if (rnd < threshold) return 0.0;
  vec2 jitter = (vec2(hash21(cell + 19.7), hash21(cell + 73.1)) - 0.5) * 0.52;
  vec2 d = f - jitter;
  float core = exp(-dot(d, d) * 68.0);
  float crossGlint = exp(-abs(d.x) * 32.0 - abs(d.y) * 9.0) + exp(-abs(d.y) * 32.0 - abs(d.x) * 9.0);
  return (core + crossGlint * 0.16) * smoothstep(threshold, 1.0, rnd);
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
  return uColorCycle < 0.5 ? uColor1 : samplePaletteCycle(0.0);
}

vec3 getAccentColor() {
  return uColorCycle < 0.5 ? uColor2 : samplePaletteCycle(1.0);
}

vec3 getHarmonicColor() {
  return uColorCycle < 0.5 ? uColor3 : samplePaletteCycle(2.0);
}

// Gentle center protection behind Focus lyrics so text stays crisp; opens to 1.0 when lyrics are hidden
float lyricCenterSoften(vec2 uv, float strength) {
  vec2 d = (uv - vec2(0.5, 0.5)) / vec2(0.38, 0.30);
  float inside = exp(-dot(d, d) * 1.45);
  return 1.0 - inside * uLyricsActive * strength;
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
 * 1. AUDIO ATLAS — Full-Detail Studio Telemetry Stage
 * Simultaneously reveals:
 * - 64 stereo-weighted spectrum columns (L left half, R right half) + floating gravity peak-hold caps + per-bin attack flux
 * - Dual center horizon waveforms (deep bass wave + razor vocal/PCM wave + air micro-filament)
 * - 12-note Chromagram harmonic canopy across the top arch
 * - Traveling kick shockwaves, snare horizon fracture seams, hi-hat crystalline sparks & stereo-width frame aura
 */
const AUDIO_ATLAS_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 harmonicCol = getHarmonicColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.58);

  float punch = clamp(uPulse, 0.5, 1.3);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 1.0);
  float lyricMask = lyricCenterSoften(uv, 0.48);

  // 1. Sub-bass & stereo-tilted atmospheric floor
  float bgScale = mix(1.0, 0.14, uDarkStage);
  float panBias = clamp(0.5 + (uv.x - 0.5) * uStereoBalance * 0.9, 0.0, 1.0);
  vec3 stageTint = mixCoverColor(deepTint, mixCoverColor(primaryCol, accentCol, panBias), 0.35 + uCentroid * 0.3);
  float distY = abs(uv.y - 0.5);
  float subFloor = exp(-uv.y * 4.5) * (0.14 + uSubBass * 0.42 + kickHit * 0.24) * mix(1.0, 0.55, uDarkStage);
  vec3 col = uBackdrop + stageTint * ((0.06 + uEnergy * 0.10 + uDrop * 0.12) * bgScale + subFloor);

  // 2. Traveling physical kick shockwaves racing vertically from horizon to edges
  float kickRippleSum = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = uKickWaves[i];
    if (age < 1.0) {
      float waveY = age * 0.54;
      float band = exp(-abs(distY - waveY) * 44.0) * (1.0 - age) * (1.0 - age);
      kickRippleSum += band;
    }
  }
  col += primaryCol * kickRippleSum * (0.34 + uSubBass * 0.24) * lyricMask;

  // 3. 64-column stereo-weighted spectrum + gravity peak-hold caps + per-bin attack flux
  float numCols = 64.0;
  float colIdx = floor(uv.x * numCols);
  float colLocalX = fract(uv.x * numCols) - 0.5;
  float colCenterX = (colIdx + 0.5) / numCols;
  float symNorm = abs(colCenterX - 0.5) * 2.0;
  float isRightSide = step(0.5, colCenterX);
  float freqPos = pow(symNorm, 0.86) * 0.92 + 0.012;

  float leftSpec = sampleLeftFFT(freqPos);
  float rightSpec = sampleRightFFT(freqPos);
  float midSpec = sampleFFT(freqPos);
  // Left half leans Left-channel spectrum; right half leans Right-channel spectrum so panning visibly shifts!
  float stereoSpec = mix(
    mix(midSpec, leftSpec, 0.65),
    mix(midSpec, rightSpec, 0.65),
    isRightSide
  );
  float peakVal = max(samplePeak(freqPos), stereoSpec);
  float fluxVal = sampleFlux(freqPos);

  float barHalfH = clamp(
    0.022 + stereoSpec * (0.27 + uEnergy * 0.07) + kickHit * (1.0 - symNorm * 0.72) * 0.055,
    0.022,
    0.42
  );
  float peakHalfH = clamp(
    0.026 + peakVal * (0.27 + uEnergy * 0.07) + kickHit * (1.0 - symNorm * 0.72) * 0.04,
    barHalfH + 0.008,
    0.45
  );
  float colMask = smoothstep(0.43, 0.24, abs(colLocalX));

  // Soft frequency wash behind columns
  float spill = exp(-max(distY - barHalfH * 0.7, 0.0) * 10.5) * (0.06 + stereoSpec * 0.24) * lyricMask;
  col += mixCoverColor(primaryCol, accentCol, symNorm * 0.65) * spill;

  // Frosted frequency pillar body colored by band (bass -> vocal -> air)
  float insideBar = smoothstep(barHalfH + 0.008, barHalfH - 0.005, distY) * colMask;
  float vPos = clamp(distY / max(barHalfH, 0.001), 0.0, 1.0);
  vec3 bandCol = symNorm < 0.45
    ? mixCoverColor(primaryCol, accentCol, symNorm / 0.45)
    : mixCoverColor(accentCol, harmonicCol, (symNorm - 0.45) / 0.55);
  float barLum = (0.24 + vPos * 0.34 + stereoSpec * 0.42 + fluxVal * 0.55) * lyricMask;
  col += bandCol * insideBar * barLum;

  // Floating gravity peak-hold cap
  float peakCap = exp(-abs(distY - peakHalfH) * 185.0) * colMask * (0.45 + peakVal * 0.75 + fluxVal * 0.45);
  col += mixCoverColor(accentCol, harmonicCol, 0.55) * peakCap * lyricMask;

  // Per-bin flux attack spark right at the active bar crest
  float fluxSpark = exp(-abs(distY - barHalfH) * 120.0) * colMask * fluxVal * (0.65 + uTransient * 0.45);
  col += harmonicCol * fluxSpark;

  // 4. Dual overlaid live horizon waveforms (thick bass wave + razor vocal/PCM wave + treble micro-filament)
  float bassW = sampleBassWave(uv.x);
  float fullW = (
    sampleWave(uv.x - 0.008) * 0.2 +
    sampleWave(uv.x) * 0.6 +
    sampleWave(uv.x + 0.008) * 0.2
  );
  float airW = sampleTrebleWave(uv.x);

  float yBass = 0.5 + bassW * (0.065 + uSubBass * 0.045);
  float bassRibbon = exp(-abs(uv.y - yBass) * 38.0) * (0.18 + uBass * 0.32) * lyricMask;
  col += primaryCol * bassRibbon;

  float yMain = 0.5 + fullW * (0.075 + uVocal * 0.045 + uEnergy * 0.03);
  float dMain = abs(uv.y - yMain);
  float mainCore = exp(-dMain * 145.0) * (0.55 + uVocal * 0.55 + uTonality * 0.22) * lyricMask;
  float mainHalo = exp(-dMain * 26.0) * (0.12 + uVocal * 0.22) * lyricMask;
  col += mixCoverColor(accentCol, harmonicCol, uCentroid * 0.5) * mainCore + accentCol * mainHalo;

  float yAir = 0.5 + airW * (0.045 + uBrilliance * 0.04 + uAir * 0.04);
  float airFilament = exp(-abs(uv.y - yAir) * 210.0) * (0.16 + uBrilliance * 0.55 + uAir * 0.65) * lyricMask;
  col += harmonicCol * airFilament;

  // 5. 12-Note Chromagram Canopy along the upper edge (C..B exact chord beacons)
  float noteRegion = smoothstep(0.84, 0.97, uv.y);
  if (noteRegion > 0.001) {
    float xSpan = (uv.x - 0.14) / 0.72;
    if (xSpan >= 0.0 && xSpan <= 1.0) {
      float noteIdxF = floor(xSpan * 12.0);
      float noteLocal = fract(xSpan * 12.0) - 0.5;
      float noteVal = sampleChroma((noteIdxF + 0.5) / 12.0);
      float pillMask = smoothstep(0.36, 0.16, abs(noteLocal));
      float archY = 0.945 - pow(abs(xSpan - 0.5) * 2.0, 2.0) * 0.025;
      float beaconCore = exp(-abs(uv.y - archY) * 140.0) * pillMask * (0.14 + noteVal * 0.95);
      float beaconDrop = exp(-max(archY - uv.y, 0.0) * 24.0) * pillMask * noteVal * 0.26 * step(uv.y, archY);
      vec3 chromaCol = mixCoverColor(
        mixCoverColor(primaryCol, accentCol, fract(noteIdxF / 6.0)),
        harmonicCol,
        step(6.0, noteIdxF) * 0.55
      );
      col += chromaCol * (beaconCore + beaconDrop);
    }
  }

  // 6. Snare horizon fracture seams (crisp twin horizontal light lines snapping outward)
  float snareBeam = exp(-distY * 110.0) * snareHit * 0.55 * lyricMask;
  for (int i = 0; i < 4; i++) {
    float age = uSnareWaves[i];
    if (age < 1.0) {
      float sy = 0.04 + age * 0.44;
      snareBeam += exp(-abs(distY - sy) * 170.0) * (1.0 - age) * 0.42;
    }
  }
  col += harmonicCol * snareBeam;

  // 7. Hi-hat & air crystalline pinpoint micro-sparks riding above outer treble columns
  float sparkZone = smoothstep(0.30, 0.92, symNorm) * smoothstep(barHalfH - 0.03, barHalfH + 0.08, distY) * smoothstep(0.495, 0.34, distY);
  float sparkPower = clamp(uHiHat * 0.90 + uAir * 0.85 + uBrilliance * 0.50, 0.0, 1.35);
  float sparkPin = microSparkField(vec2(uv.x * aspect, uv.y), 34.0, floor(uTime * 11.0) * 0.13, 0.925 - sparkPower * 0.045);
  col += mixCoverColor(accentCol, harmonicCol, 0.72) * sparkPin * sparkZone * (0.55 + sparkPower * 0.95);

  // 8. Stereo width peripheral frame aura (widens on lush stereo choruses)
  float sideEdge = smoothstep(0.34, 0.50, abs(uv.x - 0.5));
  float sideStereo = isRightSide > 0.5 ? rightSpec : leftSpec;
  col += mixCoverColor(primaryCol, harmonicCol, isRightSide * 0.5) * sideEdge * (uStereoWidth * 0.24 + sideStereo * 0.14 + kickHit * 0.10);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. HARMONIC ORBIT — Concentric Polar Instrument Mandala & Stereo Core
 * Simultaneously reveals:
 * - Physical traveling kick shockwave rings expanding from the eclipse to screen corners
 * - 96-spoke stereo-hemisphere polar spectrum + floating gravity peak dots + flux tips
 * - 12-petal Chromagram harmonic clock orbiting the outer ring (C..B chord nodes)
 * - Inner stereo Left/Right phase waveforms + vocal filament inside the dark eclipse core
 * - Snare radial corona rays + crystalline hi-hat / air starlight dust
 */
const HARMONIC_ORBIT_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);
  float angle = atan(p.y, p.x); // -pi..pi
  float angle01 = (angle + 3.14159265) / 6.2831853; // 0..1

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 harmonicCol = getHarmonicColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.58);

  float punch = clamp(uPulse, 0.5, 1.3);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 1.0);
  float centerMask = lyricCenterSoften(uv, 0.45);

  // 1. Deep dark stage with subtle harmonic nebula cloud
  float bgScale = mix(1.0, 0.18, uDarkStage);
  float nebula = fbm(p * 1.55 + vec2(uFlowTime * 0.10, -uFlowTime * 0.08));
  vec3 col = uBackdrop + mix(deepTint, primaryCol, nebula) * (0.05 + uEnergy * 0.09 + uDrop * 0.10) * bgScale;

  float innerR = 0.245 + uSubBass * 0.024 + kickHit * 0.026;

  // 2. Physical traveling kick shockwaves radiating outward from eclipse to outer screen
  for (int i = 0; i < 6; i++) {
    float age = uKickWaves[i];
    if (age < 1.0) {
      float ringR = innerR + age * 0.88;
      float ringGlow = exp(-abs(r - ringR) * (58.0 - age * 28.0)) * (1.0 - age) * (1.0 - age);
      col += mixCoverColor(primaryCol, accentCol, age * 0.45) * ringGlow * (0.48 + uSubBass * 0.25);
    }
  }

  // 3. 96-spoke stereo-hemisphere radial spectrum + floating peak dots + flux sparks
  float spokeCount = 96.0;
  float spokeId = floor(angle01 * spokeCount);
  float spokeLocal = fract(angle01 * spokeCount) - 0.5;
  float spokeMask = smoothstep(0.37, 0.14, abs(spokeLocal));

  // Frequency runs low at top/bottom poles to high at sides, left half leans Left ear, right half leans Right ear
  float symVert = abs(cos(angle)); // 0 at top/bottom, 1 at left/right sides
  float freqPos = pow(symVert, 0.88) * 0.88 + 0.015;
  float isRight = smoothstep(-0.15, 0.15, p.x);
  float specL = sampleLeftFFT(freqPos);
  float specR = sampleRightFFT(freqPos);
  float specMid = sampleFFT(freqPos);
  float spokeFft = mix(mix(specMid, specL, 0.68), mix(specMid, specR, 0.68), isRight);
  float spokePeak = max(samplePeak(freqPos), spokeFft);
  float spokeFlux = sampleFlux(freqPos);

  float barLen = 0.016 + spokeFft * (0.145 + uBass * 0.05 + uPresence * 0.03);
  float outerBarR = innerR + barLen;
  float peakR = innerR + 0.022 + spokePeak * (0.145 + uBass * 0.05 + uPresence * 0.03);

  float inBar = smoothstep(innerR - 0.006, innerR + 0.005, r) *
                smoothstep(outerBarR + 0.009, outerBarR - 0.005, r);
  vec3 spokeCol = mixCoverColor(
    mixCoverColor(primaryCol, accentCol, symVert * 0.8),
    harmonicCol,
    spokeFft * 0.45 + spokeFlux * 0.4
  );
  col += spokeCol * inBar * spokeMask * (0.34 + spokeFft * 0.68 + spokeFlux * 0.55);

  // Floating peak-hold crown dot at tip of each spoke
  float peakDot = exp(-abs(r - peakR) * 145.0) * spokeMask * (0.34 + spokePeak * 0.72);
  col += harmonicCol * peakDot;

  // Eclipse luminous rim
  float rimDist = abs(r - innerR);
  col += mixCoverColor(primaryCol, accentCol, 0.35 + uCentroid * 0.3) * exp(-rimDist * 88.0) * (0.62 + kickHit * 0.42);
  col += primaryCol * exp(-rimDist * 14.0) * (0.14 + uBass * 0.24 + kickHit * 0.22);

  // 4. 12-Petal Chromagram Harmonic Clock orbiting outside the spokes (C..B notes!)
  float clockR = innerR + 0.205 + uStereoWidth * 0.025;
  float clockAngle = mod(angle + 1.5707963 + 6.2831853, 6.2831853) / 6.2831853; // 12 o'clock = C
  float petalId = floor(clockAngle * 12.0);
  float petalLocal = fract(clockAngle * 12.0) - 0.5;
  float chromaVal = sampleChroma((petalId + 0.5) / 12.0);
  float petalArc = smoothstep(0.32, 0.08, abs(petalLocal));
  float petalRing = exp(-abs(r - clockR) * 120.0) * petalArc * (0.14 + chromaVal * 0.92);
  float petalGlow = exp(-abs(r - clockR) * 24.0) * petalArc * chromaVal * 0.30;
  vec3 petalCol = mixCoverColor(
    mixCoverColor(primaryCol, accentCol, fract(petalId / 6.0)),
    harmonicCol,
    step(6.0, petalId) * 0.6
  );
  col += petalCol * (petalRing + petalGlow);

  // 5. Inner Stereo Core: Twin Left/Right waveform filaments + vocal tonality halo
  if (r < innerR + 0.02) {
    float wAngle = abs(angle) / 3.14159265;
    float wL = sampleLeftWave(wAngle);
    float wR = sampleRightWave(wAngle);
    float wBass = sampleBassWave(wAngle);

    float coreScale = centerMask;
    float rBass = innerR * 0.52 + wBass * (0.026 + uSubBass * 0.022);
    float rLeft = innerR * (0.72 - uStereoWidth * 0.06) + wL * (0.028 + uVocal * 0.032);
    float rRight = innerR * (0.72 + uStereoWidth * 0.06) + wR * (0.028 + uVocal * 0.032);

    float bassCore = exp(-abs(r - rBass) * 65.0) * (0.20 + uBass * 0.34) * coreScale;
    float leftWire = exp(-abs(r - rLeft) * 130.0) * (0.36 + uVocal * 0.55) * coreScale;
    float rightWire = exp(-abs(r - rRight) * 130.0) * (0.36 + uVocal * 0.55) * coreScale;

    col += primaryCol * bassCore;
    col += accentCol * leftWire;
    col += mixCoverColor(accentCol, harmonicCol, 0.65) * rightWire;

    // Soft vocal tonality heart glow at very center (bright when singing, soft behind lyrics)
    float heart = exp(-r * r * 55.0) * (0.08 + uVocal * 0.28 * (0.4 + uTonality * 0.6)) * coreScale;
    col += mixCoverColor(primaryCol, accentCol, uCentroid) * heart;
  }

  // 6. Snare radial corona rays & snare ripple ring
  float rayPattern = pow(max(0.0, cos(angle * 12.0 + uFlowTime * 0.4)), 14.0);
  float rayMask = smoothstep(innerR, innerR + 0.06, r) * exp(-max(r - innerR, 0.0) * 5.2);
  col += harmonicCol * rayPattern * rayMask * (snareHit * 0.68 + uTransient * 0.32);

  for (int i = 0; i < 4; i++) {
    float age = uSnareWaves[i];
    if (age < 1.0) {
      float sr = innerR + 0.03 + age * 0.48;
      col += harmonicCol * exp(-abs(r - sr) * 110.0) * (1.0 - age) * 0.44;
    }
  }

  // 7. Hi-hat & air crystalline pinpoint starlight dust around the outer corona
  float starRingMask = smoothstep(innerR + 0.12, innerR + 0.32, r) * smoothstep(1.18, 0.52, r);
  float airPow = clamp(uHiHat * 0.95 + uAir * 0.85 + uBrilliance * 0.55, 0.0, 1.35);
  float starSpark = microSparkField(p, 28.0, floor(uTime * 11.0) * 0.11, 0.935 - airPow * 0.045) * starRingMask;
  col += harmonicCol * starSpark * (0.55 + airPow * 0.95);

  // 8. Stereo-reactive perimeter glow for room backlight
  float edgeGlow = smoothstep(0.54, 1.16, r);
  col += primaryCol * edgeGlow * (kickHit * 0.22 + uSubBass * 0.12 + uStereoWidth * 0.10);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 3. SONIC TERRAIN — 3D Perspective Rolling Spectrogram & Harmonic Landscape
 * Powered by uHistoryTex (256x64 RGBA8 ring buffer):
 * - 28 perspective depth slices of rolling frequency mountains with real 3D occlusion
 * - Stereo L/R color tinting on every ridge (from history.g pan channel)
 * - Glowing neon contour isolines on snare & pluck attacks (from history.b flux channel)
 * - Traveling kick terrain swells + live foreground oscilloscope ridge
 * - 12-note Chromagram northern-lights sky aurora + spectral centroid altitude + hi-hat starfield
 */
const SONIC_TERRAIN_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 harmonicCol = getHarmonicColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.55);

  float punch = clamp(uPulse, 0.5, 1.3);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 1.0);
  float lyricMask = lyricCenterSoften(uv, 0.42);

  float horizonY = 0.57 + uCentroid * 0.035;
  float bgScale = mix(1.0, 0.16, uDarkStage);

  // 1. Sky backdrop + 12-note Chromagram Harmonic Aurora above horizon
  vec3 skyCol = uBackdrop + deepTint * (0.07 + uEnergy * 0.10 + uDrop * 0.12) * bgScale;
  float skyFactor = smoothstep(horizonY - 0.06, horizonY + 0.34, uv.y);

  if (skyFactor > 0.001) {
    float chromaEnergy = sampleChroma(uv.x);
    float auroraWave = fbm(vec2(uv.x * 3.0 + uFlowTime * 0.14, (uv.y - horizonY) * 2.2 - uFlowTime * 0.08));
    float auroraCurtain = exp(-abs(uv.y - (horizonY + 0.14 + uCentroid * 0.11 + auroraWave * 0.09)) * 6.5);
    vec3 auroraCol = mixCoverColor(
      mixCoverColor(primaryCol, accentCol, uv.x),
      harmonicCol,
      0.25 + uCentroid * 0.55
    );
    skyCol += auroraCol * auroraCurtain * (0.22 + chromaEnergy * 0.52 + uVocal * 0.28) * skyFactor * lyricMask;

    // 12 discrete subtle chroma sky rays
    float rayId = floor(uv.x * 12.0);
    float rayLocal = fract(uv.x * 12.0) - 0.5;
    float rayVal = sampleChroma((rayId + 0.5) / 12.0);
    float rayBeam = exp(-rayLocal * rayLocal * 22.0) * exp(-max(uv.y - horizonY, 0.0) * 3.8) * rayVal;
    skyCol += mixCoverColor(accentCol, harmonicCol, fract(rayId / 4.0)) * rayBeam * 0.32 * skyFactor * lyricMask;

    // Hi-hat & air crystalline pinpoint starfield across upper sky
    float airPow = clamp(uHiHat * 0.95 + uAir * 0.90 + uBrilliance * 0.55, 0.0, 1.35);
    float starLayer1 = microSparkField(vec2(uv.x * aspect, uv.y), 26.0, 0.0, 0.935);
    float starLayer2 = microSparkField(vec2(uv.x * aspect + 0.37, uv.y + 0.19), 42.0, floor(uTime * 9.0) * 0.17, 0.952 - airPow * 0.035);
    float skyFade = smoothstep(horizonY + 0.03, horizonY + 0.24, uv.y);
    skyCol += mixCoverColor(accentCol, harmonicCol, 0.7) * (starLayer1 * (0.35 + airPow * 0.65) + starLayer2 * airPow * 0.95) * skyFade;
  }

  // Horizon atmospheric glow
  float horizonGlow = exp(-abs(uv.y - horizonY) * 18.0) * (0.16 + uVocal * 0.26 + snareHit * 0.34 + uDrop * 0.16) * mix(1.0, 0.55, uDarkStage);
  vec3 col = skyCol + mixCoverColor(primaryCol, accentCol, 0.45) * horizonGlow;

  // 2. 3D Perspective Rolling Spectrogram Terrain (28 slices front-to-back with true mountain occlusion!)
  if (uv.y < horizonY + 0.18) {
    vec3 terrainCol = col;
    bool occluded = false;

    // Precompute traveling kick swell helper across depth age 0..1
    for (int i = 0; i < 28; i++) {
      float fi = float(i) / 27.0; // 0 = nearest foreground (live), 1 = farthest horizon (~1.5s ago)
      // Perspective foreshortening: rows pack tighter near horizon
      float persp = pow(fi, 1.42);
      float baseY = mix(0.05, horizonY - 0.005, persp);
      float scaleX = mix(1.0, 2.05, persp);
      float xPersp = (uv.x - 0.5) * scaleX + 0.5;

      // Mirror frequency around center valley (bass in center/mid, treble toward flanks)
      float symX = abs(xPersp - 0.5) * 2.0;
      float inBounds = smoothstep(1.12, 0.94, symX);
      float freqX = pow(clamp(symX, 0.0, 1.0), 0.85) * 0.88 + 0.015;

      vec4 hist = sampleHistory(freqX, fi);
      float hSpec = (
        sampleHistory(freqX - 0.014, fi).r * 0.24 +
        hist.r * 0.52 +
        sampleHistory(freqX + 0.014, fi).r * 0.24
      );
      float hPan = hist.g; // <0.5 left, >0.5 right
      float hFlux = hist.b;
      float hWave = (hist.a - 0.5) * 2.0;

      // Kick physical swell rolling backward through the mountains
      float kickSwell = 0.0;
      for (int k = 0; k < 6; k++) {
        float kAge = uKickWaves[k];
        if (kAge < 1.0) {
          kickSwell += exp(-abs(fi - kAge) * 18.0) * (1.0 - kAge) * 0.045;
        }
      }

      float ampScale = mix(0.24, 0.085, persp) * inBounds;
      float waveDetail = (i == 0) ? (sampleWave(uv.x) * 0.028 + sampleBassWave(uv.x) * 0.022) : (hWave * 0.008 * (1.0 - persp));
      float ridgeY = baseY + (hSpec * ampScale + kickSwell * inBounds) * (0.72 + uEnergy * 0.45) + waveDetail;

      float distToRidge = uv.y - ridgeY;
      float distAbs = abs(distToRidge);

      // Ridge rim light & flux isoline glow
      float lineSharpness = mix(175.0, 290.0, persp);
      float rim = exp(-distAbs * lineSharpness);
      float depthFade = mix(1.0, 0.24, persp);

      // Stereo pan colors each ridge slope naturally across album colors
      float panMix = clamp((hPan - 0.5) * 2.2 + 0.5, 0.0, 1.0);
      vec3 ridgeColor = mixCoverColor(
        mixCoverColor(primaryCol, accentCol, panMix),
        harmonicCol,
        clamp(hFlux * 0.9 + symX * 0.35, 0.0, 1.0)
      );

      if (!occluded) {
        // Above this ridge: add soft glow crest
        float crestIntensity = (0.34 + hSpec * 0.72 + hFlux * 1.05 + snareHit * 0.28) * depthFade * inBounds;
        terrainCol += ridgeColor * rim * crestIntensity * lyricMask;

        if (distToRidge < 0.0) {
          // Pixel is INSIDE this mountain face — shade the slope and occlude all farther slices behind it!
          float slopeDepth = clamp(-distToRidge / max(ampScale * 0.85, 0.02), 0.0, 1.0);
          vec3 faceShade = mix(
            uBackdrop + deepTint * (0.14 + hSpec * 0.28) * bgScale,
            uBackdrop * 0.95,
            slopeDepth
          );
          // Subtle topographic contour lines glowing on snare / flux hits
          float topoLine = exp(-abs(fract(slopeDepth * 4.0) - 0.5) * 24.0) * (0.06 + hFlux * 0.38 + snareHit * 0.24);
          terrainCol = faceShade + ridgeColor * (rim * crestIntensity * 1.15 + topoLine * depthFade) * lyricMask;
          occluded = true;
        }
      }
    }
    col = terrainCol;
  }

  // 3. Sub-bass foreground floor breath & stereo edge glow
  float bottomGlow = exp(-uv.y * 7.5) * (0.10 + uSubBass * 0.30 + kickHit * 0.22);
  col += primaryCol * bottomGlow;
  col += accentCol * smoothstep(0.36, 0.50, abs(uv.x - 0.5)) * uStereoWidth * 0.16;

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 4. FLUID SYMPHONY — Living Cymatics, Twin Stereo Filaments & Micro-Sparkle Foam
 * Calm, hypnotic & organic while quietly exposing every single layer of the music:
 * - Sub-bass cymatic standing waves + expanding kick ripples
 * - 3-color harmonic liquid silk currents tinted by uChroma[12] & spectral centroid
 * - Twin intertwined Left/Right stereo vocal ribbons splitting apart on wide stereo mixes
 * - Snare caustic water-refraction webs + fine hi-hat/air bokeh micro-glints
 */
const FLUID_SYMPHONY_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 harmonicCol = getHarmonicColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.62);

  float punch = clamp(uPulse, 0.5, 1.3);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 1.0);
  float lyricMask = lyricCenterSoften(uv, 0.35);

  // 1. Sub-bass cymatic standing-wave field & gentle breathing zoom
  vec2 zp = p * (1.0 - kickHit * 0.03 - uSubBass * 0.022);
  float t = uFlowTime * 0.16;
  float cymaticFreq = 3.2 + uCentroid * 2.4;
  float cymatic = abs(
    cos(zp.x * cymaticFreq + t * 0.7) * cos(zp.y * (cymaticFreq + 1.1) - t * 0.5) -
    cos(zp.y * cymaticFreq - t * 0.6) * cos(zp.x * (cymaticFreq + 1.1) + t * 0.4)
  );
  float cymaticNodal = exp(-cymatic * (4.5 - uSubBass * 1.4)) * (0.10 + uSubBass * 0.28 + uLowMid * 0.18);

  // 2. Domain-warped 3-color harmonic silk currents driven by Chroma & Bass
  float n1 = fbm(zp * 1.35 + vec2(t * 0.52, -t * 0.30));
  float n2 = fbm(zp * 2.05 - vec2(t * 0.38, t * 0.44) + n1 * (1.05 + uBass * 0.38));
  float silk = pow(smoothstep(mix(0.24, 0.42, uDarkStage), 0.94, n2), mix(1.45, 2.0, uDarkStage));
  float causticRidge = pow(clamp(1.0 - abs(n2 * 2.0 - 1.0), 0.0, 1.0), mix(3.6, 5.0, uDarkStage));

  float chromaField = sampleChroma(uv.x * 0.85 + n1 * 0.25);
  float bgScale = mix(1.0, 0.14, uDarkStage);
  float baseFloor = (0.10 + uEnergy * 0.14 + uDrop * 0.16 + kickHit * 0.16) * bgScale;
  vec3 col = uBackdrop + deepTint * baseFloor;

  // Lush bass silk clouds + subtle cymatic harmonic structure
  vec3 silkCol = mixCoverColor(primaryCol, accentCol, chromaField * 0.58 + uCentroid * 0.22);
  col += silkCol * (silk * (0.22 + uBass * 0.36 + kickHit * 0.26 + uDrop * 0.18) + cymaticNodal * 1.35 * mix(1.0, 0.68, uDarkStage)) * lyricMask;

  // Snare & transient luminous caustic veins
  col += mixCoverColor(accentCol, harmonicCol, 0.55) * causticRidge * (0.16 + uVocal * 0.28 + snareHit * 0.52 + uTransient * 0.34) * mix(1.0, 0.80, uDarkStage) * lyricMask;

  // 3. Expanding physical kick shockwave ripples across the liquid surface
  for (int i = 0; i < 6; i++) {
    float age = uKickWaves[i];
    if (age < 1.0) {
      float waveR = 0.08 + age * 1.05;
      float ripple = exp(-abs(r - waveR) * 32.0) * (1.0 - age) * (1.0 - age);
      col += primaryCol * ripple * (0.38 + uSubBass * 0.28) * lyricMask;
    }
  }

  // 4. Soft mirrored ambient frequency mist along top & bottom currents
  float symX = abs(uv.x - 0.5) * 2.0;
  float freqX = pow(symX, 0.88) * 0.88 + 0.015;
  float fftStereo = mix(sampleLeftFFT(freqX), sampleRightFFT(freqX), smoothstep(0.35, 0.65, uv.x));
  float mistScale = mix(1.0, 0.50, uDarkStage);
  float botMist = exp(-uv.y * (5.2 - fftStereo * 2.0)) * (0.10 + fftStereo * 0.42) * mistScale;
  float topMist = exp(-(1.0 - uv.y) * (5.8 - fftStereo * 1.6)) * (0.06 + fftStereo * 0.28) * mistScale;
  col += mixCoverColor(primaryCol, harmonicCol, fftStereo * 0.55) * (botMist + topMist) * (0.40 + uBass * 0.30);

  // 5. Twin intertwined Left & Right stereo vocal filaments (merge in mono, split wide in stereo!)
  float smoothL = (
    sampleLeftWave(uv.x - 0.015) * 0.25 +
    sampleLeftWave(uv.x) * 0.5 +
    sampleLeftWave(uv.x + 0.015) * 0.25
  );
  float smoothR = (
    sampleRightWave(uv.x - 0.015) * 0.25 +
    sampleRightWave(uv.x) * 0.5 +
    sampleRightWave(uv.x + 0.015) * 0.25
  );

  float stereoSpread = 0.015 + uStereoWidth * 0.075;
  float waveAmp = 0.065 + uVocal * 0.045 + uBass * 0.03;
  float yL = 0.5 + stereoSpread + smoothL * waveAmp + sin(uv.x * 4.8 + uFlowTime * 0.85) * 0.015;
  float yR = 0.5 - stereoSpread + smoothR * waveAmp + cos(uv.x * 5.2 - uFlowTime * 0.75) * 0.015;

  float dL = abs(uv.y - yL);
  float dR = abs(uv.y - yR);
  float coreL = exp(-dL * 95.0) * (0.48 + uVocal * 0.48 + uTonality * 0.22) * lyricMask;
  float glowL = exp(-dL * 18.0) * (0.12 + uVocal * 0.20) * lyricMask;
  float coreR = exp(-dR * 95.0) * (0.48 + uVocal * 0.48 + uTonality * 0.22) * lyricMask;
  float glowR = exp(-dR * 18.0) * (0.12 + uVocal * 0.20) * lyricMask;

  col += accentCol * coreL + primaryCol * glowL;
  col += harmonicCol * coreR + accentCol * glowR;

  // 6. Hi-hat & Air organic micro-sparkle bokeh foam riding along the fluid crests (jittered, zero grid alignment)
  float airPow = clamp(uHiHat * 0.95 + uAir * 0.85 + uBrilliance * 0.55, 0.0, 1.4);
  float nearCrest = smoothstep(0.40, 0.84, n2);
  vec2 driftUv = vec2(uv.x * aspect, uv.y) + vec2(uFlowTime * 0.04, -uFlowTime * 0.025);
  float foamDot = microSparkField(driftUv, 26.0, 0.0, 0.91 - airPow * 0.045) * nearCrest;
  col += harmonicCol * foamDot * (0.45 + airPow * 0.85);

  // 7. Smooth perimeter breath for room backlights
  float edgeBand = smoothstep(0.56, 1.18, r);
  col += primaryCol * edgeBand * (kickHit * 0.18 + uSubBass * 0.10 + uStereoWidth * 0.08) * mix(1.0, 0.65, uDarkStage);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 5. WAVE ALCHEMY — 3-Band Precision Oscilloscope, Ghost Trails & Stereo Split
 * Simultaneously reveals the exact physics of the waveform split into every musical layer:
 * - Soft full-spectrum frequency wash + floating peak mist behind the waves
 * - 12-note Chromagram harmonic fret markers across the stage
 * - 3 simultaneous live waves: thick Bass wave, razor Vocal/PCM wave with 4 temporal ghost trails, and electric Air/Treble wave
 * - Live Stereo L/R split filaments responding to uStereoWidth & uStereoBalance
 * - Kick beat pulses & crisp vertical snare refraction gleams
 */
const WAVE_ALCHEMY_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 harmonicCol = getHarmonicColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.56);

  float punch = clamp(uPulse, 0.5, 1.3);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 1.0);
  float lyricMask = lyricCenterSoften(uv, 0.34);

  // 1. Clean deep backdrop + subtle mirrored full-spectrum wash
  float symX = abs(uv.x - 0.5) * 2.0;
  float freqX = pow(symX, 0.88) * 0.88 + 0.015;
  float fft = sampleFFT(freqX);
  float peak = samplePeak(freqX);
  float distCenterY = abs(uv.y - 0.5);

  float bgScale = mix(1.0, 0.12, uDarkStage);
  vec3 col = uBackdrop + deepTint * (0.05 + uEnergy * 0.08 + uDrop * 0.09) * bgScale;

  // Soft spectral envelope curtain behind the waveforms
  float envH = 0.05 + fft * (0.20 + uBass * 0.08);
  float peakH = 0.055 + peak * (0.20 + uBass * 0.08);
  float curtain = smoothstep(envH + 0.12, envH * 0.08, distCenterY) * (0.12 + fft * 0.24) * lyricMask;
  float peakMist = exp(-abs(distCenterY - peakH) * 85.0) * (0.12 + peak * 0.32) * lyricMask;
  col += primaryCol * curtain + accentCol * peakMist * 0.65;

  // 2. 12-note Chromagram harmonic fret markers (vertical whisper lines lighting up active chord notes)
  float xFret = (uv.x - 0.08) / 0.84;
  if (xFret >= 0.0 && xFret <= 1.0) {
    float fId = floor(xFret * 12.0);
    float fLocal = fract(xFret * 12.0) - 0.5;
    float fChroma = sampleChroma((fId + 0.5) / 12.0);
    float fretLine = exp(-fLocal * fLocal * 360.0) * exp(-distCenterY * 4.8) * (0.04 + fChroma * 0.34);
    float fretNode = exp(-fLocal * fLocal * 95.0) * exp(-abs(distCenterY - 0.36) * 90.0) * (0.12 + fChroma * 0.85);
    vec3 fCol = mixCoverColor(primaryCol, harmonicCol, fract(fId / 5.0));
    col += fCol * (fretLine + fretNode);
  }

  // 3. Traveling kick horizontal pulse ticks
  for (int i = 0; i < 6; i++) {
    float age = uKickWaves[i];
    if (age < 1.0) {
      float rx = age * 0.52;
      float tick = exp(-abs(abs(uv.x - 0.5) - rx) * 75.0) * exp(-distCenterY * 6.5) * (1.0 - age) * (1.0 - age);
      col += primaryCol * tick * 0.42;
    }
  }

  // 4. Multi-frame temporal ghost trails of the main PCM waveform (from uHistoryTex.a!)
  float mainAmp = 0.11 + uEnergy * 0.065 + kickHit * 0.04;
  for (int g = 1; g <= 4; g++) {
    float gf = float(g);
    float age = gf * 0.085;
    float pastWave = (sampleHistory(uv.x, age).a - 0.5) * 2.0;
    float yGhost = 0.5 + pastWave * mainAmp * (1.0 - gf * 0.06);
    float ghostLine = exp(-abs(uv.y - yGhost) * (110.0 - gf * 14.0)) * (0.22 / gf) * lyricMask;
    col += mixCoverColor(primaryCol, accentCol, gf * 0.22) * ghostLine * (0.65 + uVocal * 0.45);
  }

  // 5. LAYER A — Broad deep Bass Envelope Wave (low-passed sub/bass body)
  float bassW = (
    sampleBassWave(uv.x - 0.015) * 0.25 +
    sampleBassWave(uv.x) * 0.5 +
    sampleBassWave(uv.x + 0.015) * 0.25
  );
  float yBass = 0.5 + bassW * (0.12 + uSubBass * 0.075 + kickHit * 0.04);
  float dBass = abs(uv.y - yBass);
  col += primaryCol * (exp(-dBass * 42.0) * (0.34 + uBass * 0.46) + exp(-dBass * 11.0) * (0.14 + uSubBass * 0.24)) * lyricMask;

  // 6. LAYER B — Live Stereo L & R split filaments (merge on mono, separate cleanly on wide stereo!)
  float splitOffset = 0.008 + uStereoWidth * 0.075;
  float tilt = uStereoBalance * 0.025;
  float yLeft = 0.5 + splitOffset - tilt + sampleLeftWave(uv.x) * (mainAmp * 0.78);
  float yRight = 0.5 - splitOffset + tilt + sampleRightWave(uv.x) * (mainAmp * 0.78);
  float leftWire = exp(-abs(uv.y - yLeft) * 140.0) * (0.28 + uStereoWidth * 0.55 + uVocal * 0.25) * lyricMask;
  float rightWire = exp(-abs(uv.y - yRight) * 140.0) * (0.28 + uStereoWidth * 0.55 + uVocal * 0.25) * lyricMask;
  col += primaryCol * leftWire * 0.85 + accentCol * rightWire * 0.85;

  // 7. LAYER C — Razor-crisp Core Vocal/PCM Oscilloscope
  float coreW = (
    sampleWave(uv.x - 0.006) * 0.2 +
    sampleWave(uv.x) * 0.6 +
    sampleWave(uv.x + 0.006) * 0.2
  );
  float yCore = 0.5 + coreW * mainAmp;
  float dCore = abs(uv.y - yCore);
  float coreBeam = exp(-dCore * 165.0) * (0.78 + uVocal * 0.45 + kickHit * 0.25) * lyricMask;
  float coreGlow = exp(-dCore * 24.0) * (0.20 + uEnergy * 0.28 + uTonality * 0.16) * lyricMask;
  col += mixCoverColor(accentCol, harmonicCol, 0.35 + uCentroid * 0.35) * coreBeam + accentCol * coreGlow;

  // 8. LAYER D — Electric High-Frequency Air / Treble Micro-Wave (hi-hats, cymbals, breath!)
  float trebleW = sampleTrebleWave(uv.x);
  float treblePower = clamp(uBrilliance * 0.8 + uAir * 0.9 + uHiHat * 0.85, 0.0, 1.4);
  float yAirTop = 0.5 + 0.16 + trebleW * (0.045 + treblePower * 0.055);
  float yAirBot = 0.5 - 0.16 - trebleW * (0.045 + treblePower * 0.055);
  float airTrace = (exp(-abs(uv.y - yAirTop) * 195.0) + exp(-abs(uv.y - yAirBot) * 195.0)) * (0.14 + treblePower * 0.68);
  col += harmonicCol * airTrace;

  // 9. Snare phase flash & crisp perimeter breath
  float snareGleam = exp(-distCenterY * 90.0) * (snareHit * 0.48 + uTransient * 0.24) * lyricMask;
  col += harmonicCol * snareGleam;
  col += primaryCol * smoothstep(0.36, 0.50, distCenterY) * (kickHit * 0.18 + uSubBass * 0.10);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

export const SHADER_PRESETS: ShaderPresetMeta[] = [
  {
    id: 'atlas',
    name: 'Atlas',
    key: '1',
    tagline: 'Full-spectrum studio stage: stereo EQ, peak caps, 12-note chroma, waves & sparks',
    fragmentSource: AUDIO_ATLAS_FRAG,
  },
  {
    id: 'orbit',
    name: 'Orbit',
    key: '2',
    tagline: 'Concentric polar mandala: kick shockwaves, 96 stereo spokes, chroma clock & stereo core',
    fragmentSource: HARMONIC_ORBIT_FRAG,
  },
  {
    id: 'terrain',
    name: 'Terrain',
    key: '3',
    tagline: '3D rolling spectrogram landscape with flux isolines, stereo ridges & chroma aurora',
    fragmentSource: SONIC_TERRAIN_FRAG,
  },
  {
    id: 'symphony',
    name: 'Symphony',
    key: '4',
    tagline: 'Living cymatics, 3-color silk currents, twin stereo filaments & micro-sparkle foam',
    fragmentSource: FLUID_SYMPHONY_FRAG,
  },
  {
    id: 'waves',
    name: 'Waves',
    key: '5',
    tagline: '3-band precision oscilloscope: bass wave, ghost trails, stereo split & air trace',
    fragmentSource: WAVE_ALCHEMY_FRAG,
  },
  {
    id: 'blank',
    name: 'Blank',
    key: '6',
    tagline: 'Clean solid-color background with zero motion',
    fragmentSource: '',
  },
];
