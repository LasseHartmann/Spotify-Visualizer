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
 * 1. SOFT CLOUD — Dreamy Liquid-Motion Clouds
 * Silky domain-warped mist clouds that curl, stretch, and flow like slow liquid silk.
 * Only soft, velvety liquid breathing with the music — zero sudden flashes or extreme snaps.
 */
const SOFT_CLOUD_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 tertiaryCol = getTertiaryColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.48);

  // Ultra-calm, silky audio modulation (strictly soft liquid swells, never frantic)
  float gentleBass = clamp(uBass * 0.55 + uSubBass * 0.30, 0.0, 0.72);
  float gentleVocal = clamp(uVocal * 0.65 + uLowMid * 0.25, 0.0, 0.75);
  float softKick = clamp(uKick * 0.30, 0.0, 0.32);

  // Slow continuous liquid drift (advected smoothly by calm uFlowTime + wall clock)
  float t = uTime * 0.065 + uFlowTime * 0.095;
  vec2 sp = p * (1.0 - gentleBass * 0.025);

  // Triple-pass fluid domain warping: clouds curl, fold, and pour like slow-motion liquid silk
  vec2 q = vec2(
    fbm(sp * 1.15 + vec2(t * 0.45, -t * 0.28)),
    fbm(sp * 1.15 + vec2(-t * 0.32, t * 0.38) + vec2(4.2, 1.7))
  );
  vec2 w = vec2(
    fbm(sp * 1.45 + q * (1.35 + gentleBass * 0.32) + vec2(t * 0.30, t * 0.22) + vec2(1.9, 6.4)),
    fbm(sp * 1.45 + q * (1.35 + gentleBass * 0.32) + vec2(-t * 0.25, -t * 0.30) + vec2(7.3, 2.8))
  );
  float liquidCloud = fbm5(sp * 1.35 + w * (1.15 + gentleBass * 0.28) + vec2(t * 0.16, -t * 0.10));

  // Soft volumetric directional shimmer inside the liquid folds
  float litSample = fbm(sp * 1.35 + w * (1.15 + gentleBass * 0.28) + vec2(t * 0.16 + 0.08, -t * 0.10 + 0.10));
  float softFold = clamp((liquidCloud - litSample) * 2.4 + 0.52, 0.0, 1.0);

  // Smooth velvety cloud billows & delicate swirling current ribbons
  float cloudBody = smoothstep(mix(0.24, 0.38, uDarkStage), 0.88, liquidCloud);
  float swirlRibbon = pow(clamp(1.0 - abs(liquidCloud * 2.0 - 1.0), 0.0, 1.0), 2.8);
  float warpMix = clamp(length(w - 0.5) * 1.45, 0.0, 1.0);

  // Deep calm liquid sky backdrop
  float bgScale = mix(1.0, 0.12, uDarkStage);
  vec3 col = uBackdrop + deepTint * (0.07 + uEnergy * 0.08 + softKick * 0.07) * bgScale;

  // Flowing primary liquid cloud masses
  vec3 liquidHue = mixCoverColor(primaryCol, accentCol, warpMix * 0.48 + softFold * 0.22);
  float bodyGlow = cloudBody * (0.24 + gentleBass * 0.28 + softKick * 0.14 + uEnergy * 0.12);
  col += liquidHue * bodyGlow;

  // Soft swirling vocal & melody eddies drifting inside the cloud currents
  vec3 eddyCol = mixCoverColor(accentCol, tertiaryCol, 0.35);
  col += eddyCol * swirlRibbon * (0.14 + gentleVocal * 0.28 + uTreble * 0.12) * mix(1.0, 0.72, uDarkStage);

  // Subtle pearlescent crest highlights along the softest liquid folds
  float crest = smoothstep(0.60, 0.94, liquidCloud) * softFold;
  col += mix(primaryCol, vec3(1.0), 0.22) * crest * (0.12 + gentleBass * 0.14 + gentleVocal * 0.14);

  // Gentle breathing perimeter aura for smooth LED screen backlights
  col += primaryCol * smoothstep(0.55, 1.25, r) * (0.04 + gentleBass * 0.10 + softKick * 0.09) * mix(1.0, 0.55, uDarkStage);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. CLOUD — Real Sculpted Fluffy Cumulus Clouds in an Audio-Reactive Sky
 * Recognizable flat-bottomed, billowy cumulus clouds drifting across a twilight sky.
 * Individual cloud lobes puff & swell smoothly with bass/mid/treble bands, kicks glow
 * warmly through the dense cloud cores, and vocals/snares gild the sunlit silver linings.
 */
const CLOUD_FRAG = `${COMMON_HEADER}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

// Sculpted puffy cumulus cloud SDF: distinct plump rounded cloud domes + soft flat underside + cotton edge
float cumulusSdf(vec2 q, float bL, float bC, float bR, float kickPump, float seed) {
  float k = 0.028; // Tighter blend keeps each rounded cumulus puff lobe distinct & cloud-shaped!
  float lift = kickPump * 0.020;

  // Classic iconic cumulus cloud profile: wide flat-ish base + plump round domes rising in center & shoulders
  float d = length(q - vec2(-0.02, 0.068 + bC * 0.046 + lift)) - (0.098 + bC * 0.028 + kickPump * 0.016);
  d = smin(d, length(q - vec2( 0.088, 0.052 + bR * 0.038 + lift * 0.9)) - (0.082 + bR * 0.024 + kickPump * 0.013), k);
  d = smin(d, length(q - vec2(-0.128, 0.034 + bL * 0.036 + lift * 0.85)) - (0.078 + bL * 0.024 + kickPump * 0.012), k);
  d = smin(d, length(q - vec2(-0.215, 0.000 + bL * 0.018)) - (0.056 + bL * 0.016 + kickPump * 0.008), k);
  d = smin(d, length(q - vec2( 0.185, 0.004 + bR * 0.020)) - (0.060 + bR * 0.016 + kickPump * 0.009), k);
  d = smin(d, length(q - vec2( 0.258, -0.014 + bR * 0.012)) - (0.042 + bR * 0.011), k);
  d = smin(d, length(q - vec2(-0.280, -0.016 + bL * 0.012)) - (0.040 + bL * 0.010), k);
  // Base body bridge so the underside is continuous & plump
  d = smin(d, length(q - vec2( 0.00, -0.008)) - (0.082 + bC * 0.015), 0.045);

  // Softly flatten the bottom underside so it unmistakably reads as a floating cumulus cloud
  d = smax(d, -0.046 - q.y, 0.026);

  // Delicate fluffy cotton-edge wispiness (keeps domes super round & recognizable)
  float edgeNoise = (fbm(q * 9.0 + vec2(seed, -seed * 0.6)) - 0.5) * 0.026;
  return d + edgeNoise;
}

vec3 compositeCumulus(
  vec3 bg,
  vec2 q,
  float bL,
  float bC,
  float bR,
  float kickPump,
  float internalGlow,
  float rimPower,
  float opacity,
  float seed,
  vec3 bellyCol,
  vec3 bodyCol,
  vec3 crownCol,
  vec3 rimCol
) {
  float d = cumulusSdf(q, bL, bC, bR, kickPump, seed);
  // Soft backlit atmospheric halo hugging the cloud silhouette
  float halo = exp(-max(d, 0.0) * 20.0) * (0.14 + internalGlow * 0.30 + rimPower * 0.22) * opacity;
  vec3 res = bg + rimCol * halo;

  float mask = smoothstep(0.014, -0.010, d);
  if (mask <= 0.001) return res;

  // Authentic 3D cumulus lighting: bright sunlit upper puffs, fluffy internal folds, softly shaded underside
  float dSun = cumulusSdf(q + vec2(-0.016, 0.042), bL, bC, bR, kickPump, seed);
  float topLight = clamp((dSun - d) * 12.0 + 0.50, 0.0, 1.0);
  float bellyGrad = smoothstep(-0.050, 0.085, q.y);
  float folds = fbm(q * 9.5 + vec2(seed * 1.7, 3.1));
  float shadeT = clamp(topLight * 0.54 + bellyGrad * 0.34 + (folds - 0.46) * 0.24, 0.0, 1.0);

  vec3 cloudCol = mix(bellyCol, bodyCol, smoothstep(0.06, 0.56, shadeT));
  cloudCol = mix(cloudCol, crownCol, smoothstep(0.50, 0.94, shadeT));

  // Warm internal beat glow shining through the dense center of the cloud
  float coreDepth = smoothstep(0.0, -0.068, d);
  cloudCol += rimCol * coreDepth * internalGlow * 0.42;

  // Crisp backlit silver-lining rim around upper cumulus puffs
  float rim = exp(-abs(d) * 76.0) * smoothstep(-0.030, 0.070, q.y);
  cloudCol += rimCol * rim * (0.36 + rimPower * 0.65);

  return mix(res, cloudCol, mask * opacity);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.38);
  vec3 highlightCol = mix(accentCol, vec3(1.0), 0.48);

  float punch = clamp(uPulse, 0.55, 1.35);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Live smooth frequency bands for organic puff swells
  float fSub = (sampleFFT(0.03) + sampleFFT(0.07) + sampleFFT(0.11)) / 3.0;
  float fMid = (sampleFFT(0.24) + sampleFFT(0.32) + sampleFFT(0.40)) / 3.0;
  float fVoc = (sampleFFT(0.45) + sampleFFT(0.55) + sampleFFT(0.64)) / 3.0;
  float fHi  = (sampleFFT(0.72) + sampleFFT(0.80) + sampleFFT(0.88)) / 3.0;

  // Deep starry twilight sky gradient (lots of breathing room so every cloud silhouette pops!)
  float bgScale = mix(1.0, 0.22, uDarkStage);
  vec3 skyTop = uBackdrop * 0.50 + deepTint * (0.05 + uEnergy * 0.05) * bgScale;
  vec3 skyHorizon = uBackdrop * 0.72 + mix(deepTint, primaryCol, 0.30) * (0.14 + bassPower * 0.14) * bgScale;
  vec3 col = mix(skyHorizon, skyTop, smoothstep(0.02, 0.96, uv.y));

  // Soft moon/sun glow behind the clouds pulsing with kicks & bass
  vec2 sunPos = vec2(0.0, -0.06);
  float sunDist = length(p - sunPos);
  float kickShock = exp(-abs(sunDist - uKickWave * 1.35) * 6.5) *
                    (1.0 - smoothstep(0.45, 1.15, uKickWave)) * uKickWaveAmp;
  col += primaryCol * exp(-sunDist * sunDist * 2.0) * (0.12 + bassPower * 0.20 + kickHit * 0.20) * bgScale;
  col += mixCoverColor(primaryCol, highlightCol, 0.4) * kickShock * 0.20;

  // Twinkling sky stars above & between the clouds sparkling on hi-hats & treble
  vec2 starCell = floor(p * 28.0);
  vec2 starLocal = fract(p * 28.0) - 0.5;
  float starRnd = hash21(starCell);
  if (starRnd > 0.94 && uv.y > 0.25) {
    float twinkle = 0.45 + 0.55 * sin(uTime * (2.4 + starRnd * 5.0) + starRnd * 31.0);
    float starDot = exp(-length(starLocal) * 15.0) * twinkle * (0.20 + uTreble * 0.45 + uHiHat * 0.75);
    col += highlightCol * starDot;
  }

  // Dreamy 3D cloud colors (rich shaded belly, luminous album mid-body, sunlit pastel crown)
  vec3 bellyDark = mix(uBackdrop * 0.62, deepTint * 0.60, 0.62);
  vec3 bodyMid = mixCoverColor(deepTint, primaryCol, 0.72) * (0.58 + uEnergy * 0.20);
  vec3 crownLit = mixCoverColor(primaryCol, highlightCol, 0.44) * (0.80 + bassPower * 0.16);
  vec3 rimGlow = mixCoverColor(accentCol, vec3(1.0), 0.42);

  float drift = uFlowTime * 0.055;
  float wrapSpan = max(aspect + 1.05, 2.25);
  float internalFlash = kickHit * 0.80 + kickShock * 0.70 + bassPower * 0.20;
  float rimEnergy = uVocal * 0.65 + snareHit * 0.75 + uDrop * 0.22;

  // LAYER 1: Small distant high clouds drifting gently across the upper starry sky
  {
    float x1 = mod(p.x - drift * 0.48 + 0.46 + wrapSpan * 0.5, wrapSpan) - wrapSpan * 0.5;
    vec2 q1 = vec2(x1, p.y - 0.28) / 0.58;
    col = compositeCumulus(
      col, q1, fSub * 0.6, fMid * 0.75, fHi * 0.65, kickHit * 0.45,
      internalFlash * 0.40, rimEnergy * 0.50, 0.58, 1.3,
      bellyDark, bodyMid * 0.82, crownLit * 0.82, rimGlow
    );

    float x2 = mod(p.x - drift * 0.36 - 0.58 + wrapSpan * 0.5, wrapSpan) - wrapSpan * 0.5;
    vec2 q2 = vec2(x2, p.y - 0.25) / 0.52;
    col = compositeCumulus(
      col, q2, fMid * 0.6, fVoc * 0.8, fHi * 0.7, kickHit * 0.40,
      internalFlash * 0.40, rimEnergy * 0.50, 0.52, 4.7,
      bellyDark, bodyMid * 0.82, crownLit * 0.82, rimGlow
    );
  }

  // LAYER 2: Distinct floating hero cumulus clouds framing the sky cleanly around the lyrics
  {
    // Left hero cloud (bass-driven puffs)
    float xL = mod(p.x - drift * 0.85 + 0.56 + wrapSpan * 0.5, wrapSpan) - wrapSpan * 0.5;
    vec2 qL = vec2(xL, p.y - 0.06) / 0.82;
    col = compositeCumulus(
      col, qL, fSub, fMid, fVoc, kickHit * 0.90,
      internalFlash * 0.78, rimEnergy * 0.85, 0.88, 8.2,
      bellyDark, bodyMid, crownLit, rimGlow
    );

    // Right hero cloud (vocal & treble puffs)
    float xR = mod(p.x - drift * 0.74 - 0.58 + wrapSpan * 0.5, wrapSpan) - wrapSpan * 0.5;
    vec2 qR = vec2(xR, p.y - 0.11) / 0.78;
    col = compositeCumulus(
      col, qR, fMid, fVoc, fHi, kickHit * 0.82,
      internalFlash * 0.75, rimEnergy * 0.92, 0.86, 13.5,
      bellyDark, bodyMid, crownLit, rimGlow
    );

    // Hero lower-center cumulus cloud floating prominently beneath the lyrics!
    float xC = mod(p.x - drift * 1.05 + wrapSpan * 0.5, wrapSpan) - wrapSpan * 0.5;
    vec2 qC = vec2(xC, p.y + 0.26) / 0.98;
    col = compositeCumulus(
      col, qC, fSub, max(fSub * 0.65, fVoc), fHi, kickHit,
      internalFlash * 0.95, rimEnergy, 0.95, 21.4,
      bellyDark * 0.95, bodyMid * 1.02, crownLit * 1.04, rimGlow
    );
  }

  // LAYER 3: Smaller drifting foreground clouds near bottom corners for parallax depth
  {
    float xB1 = mod(p.x - drift * 1.35 + 0.78 + wrapSpan * 0.5, wrapSpan) - wrapSpan * 0.5;
    vec2 qB1 = vec2(xB1, p.y + 0.37) / 0.88;
    col = compositeCumulus(
      col, qB1, fSub, fMid, fVoc, kickHit * 0.95,
      internalFlash * 0.70, rimEnergy * 0.72, 0.90, 29.1,
      bellyDark * 0.88, bodyMid * 0.92, crownLit * 0.95, rimGlow
    );
  }

  // Gentle edge backlight breath for screen-average LEDs
  col += primaryCol * smoothstep(0.68, 1.30, r) * (kickHit * 0.14 + bassPower * 0.08);

  fragColor = vec4(finalizeLedColor(col), 1.0);
}
`;

/**
 * 2. BARS — Bottom-Anchored Vertical Spectrum Equalizer Bars with Falling Peak-Hold Caps
 * Clean musical left-to-right (bass -> vocal -> treble) rounded vertical bars rising from
 * the bottom edge, topped by classic hardware-EQ gravity peak caps.
 */
const BARS_FRAG = `${COMMON_HEADER}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  vec3 primaryCol = getPrimaryColor();
  vec3 accentCol = getAccentColor();
  vec3 deepTint = preserveShade(primaryCol, -0.02, 0.52);
  vec3 capCol = mix(accentCol, vec3(1.0), 0.52);

  float punch = clamp(uPulse, 0.55, 1.35);
  float kickHit = clamp(uKick * punch, 0.0, 1.0);
  float snareHit = clamp(uSnare * punch, 0.0, 0.95);
  float bassPower = clamp(uBass * 0.85 + uSubBass * 0.45, 0.0, 1.2);

  // Clean dark stage leaving the upper-middle crisp for lyrics
  float bgScale = mix(1.0, 0.18, uDarkStage);
  vec3 col = uBackdrop * 0.82 + deepTint * (0.05 + (1.0 - uv.y) * 0.10 + uEnergy * 0.08) * bgScale;

  // Aspect-responsive bar count (~53 sleek bars on desktop, ~20 wide readable bars on mobile portrait)
  float numBars = clamp(floor(aspect * 30.0), 20.0, 56.0);
  float padX = 0.035;
  float innerX = (uv.x - padX) / (1.0 - padX * 2.0);
  float inBounds = step(0.0, innerX) * step(innerX, 1.0);

  float barSlot = innerX * numBars;
  float barIdx = clamp(floor(barSlot), 0.0, numBars - 1.0);
  float barLocalX = fract(barSlot) - 0.5; // -0.5 .. +0.5 within bar column
  float barNorm = (barIdx + 0.5) / numBars; // 0 (sub-bass left) -> 1 (treble right)

  // Left-to-right musical frequency spectrum (log-packed in row 0, gravity peak-hold in row 2)
  float freqPos = pow(barNorm, 0.94) * 0.90 + 0.012;
  float fft = (
    sampleFFT(freqPos - 0.008) * 0.22 +
    sampleFFT(freqPos) * 0.56 +
    sampleFFT(freqPos + 0.008) * 0.22
  );
  float peakFft = max(
    fft,
    samplePeak(freqPos - 0.008) * 0.20 +
    samplePeak(freqPos) * 0.60 +
    samplePeak(freqPos + 0.008) * 0.20
  );

  // Subtle kick lift on bass bars & snare sparkle on high-mid bars
  float kickBoost = kickHit * exp(-barNorm * 4.0) * 0.065;
  float snareBoost = snareHit * exp(-pow((barNorm - 0.62) * 3.8, 2.0)) * 0.045;

  float floorY = 0.015;
  float barH = clamp(0.018 + fft * (0.60 + uEnergy * 0.08) + kickBoost + snareBoost, 0.018, 0.78);
  float peakH = clamp(0.024 + peakFft * (0.60 + uEnergy * 0.08) + kickBoost * 0.6, barH + 0.012, 0.82);

  // Soft ambient vertical glow rising behind the active bars
  float backGlow = exp(-max(uv.y - (floorY + barH * 0.85), 0.0) * 6.5) * (0.08 + fft * 0.26) * inBounds;
  col += mixCoverColor(primaryCol, accentCol, barNorm * 0.35) * backGlow;

  // Rounded-top vertical bar geometry in aspect-accurate pixel space
  float colWidthUv = (1.0 - padX * 2.0) / numBars;
  float halfBarW = 0.35; // leaves crisp 30% dark gaps between bars
  float barRadiusUvY = halfBarW * colWidthUv * aspect;
  float capCenterY = max(floorY + barRadiusUvY, floorY + barH - barRadiusUvY);

  // Signed distance to rounded-top bar rising from floorY
  vec2 barRel = vec2(barLocalX * colWidthUv * aspect, uv.y - capCenterY);
  float distCap = length(vec2(barRel.x, max(barRel.y, 0.0))) - barRadiusUvY;
  float distRectX = abs(barRel.x) - barRadiusUvY;
  float dBar = (uv.y >= capCenterY) ? distCap : distRectX;
  dBar = max(dBar, floorY - uv.y);

  float aa = max(1.3 / max(uResolution.y, 1.0), 0.0012);
  float barMask = smoothstep(aa, -aa, dBar) * inBounds;

  if (barMask > 0.001) {
    float vFrac = clamp((uv.y - floorY) / max(barH, 0.001), 0.0, 1.0);
    // Rich gradient: deep saturated base -> bright primary body -> glowing accent tip
    vec3 baseCol = mix(deepTint, primaryCol, smoothstep(0.0, 0.45, vFrac));
    vec3 barCol = mixCoverColor(baseCol, accentCol, pow(vFrac, 1.55) * 0.78);
    // Subtle inner vertical center sheen so each bar looks crisp & sculptural
    float centerSheen = 1.0 - pow(abs(barLocalX) / halfBarW, 2.0) * 0.22;
    float lum = (0.48 + vFrac * 0.44 + fft * 0.32 + kickHit * 0.12) * centerSheen;
    // Bright luminous top rim inside the rounded cap
    float topHighlight = smoothstep(0.84, 1.0, vFrac) * (0.28 + fft * 0.48);
    barCol = barCol * lum + capCol * topHighlight;
    col = mix(col, barCol, barMask);
  }

  // Crisp glowing halo hugging the top of active bars
  float topGlow = exp(-length(vec2(barRel.x * 1.4, (uv.y - (floorY + barH)) * 1.2)) * 28.0) *
                  (0.14 + fft * 0.42) * inBounds;
  col += accentCol * topGlow;

  // Classic floating gravity peak-hold cap hovering cleanly above each bar
  float peakY = floorY + peakH;
  float capThickness = max(0.0038, 2.4 / max(uResolution.y, 1.0));
  vec2 capRel = vec2(max(abs(barLocalX) - (halfBarW - 0.06), 0.0) * colWidthUv * aspect, uv.y - peakY);
  float dPeakCap = length(capRel) - capThickness * 0.75;
  float peakMask = smoothstep(aa, -aa, dPeakCap) * inBounds * smoothstep(0.026, 0.055, peakH);
  float peakHalo = exp(-max(dPeakCap, 0.0) * 95.0) * smoothstep(0.026, 0.055, peakH) * inBounds;
  col += capCol * (peakMask * 0.95 + peakHalo * 0.34);

  // Crisp subtle floor baseline & perimeter kick breath
  float floorLine = exp(-abs(uv.y - floorY) * 260.0) * (0.22 + uEnergy * 0.28 + kickHit * 0.25);
  col += mixCoverColor(primaryCol, accentCol, 0.35) * floorLine;
  col += primaryCol * smoothstep(0.75, 1.0, 1.0 - uv.y) * (kickHit * 0.14 + bassPower * 0.08);

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
  // X-axis (Time) lowered neatly to y = 0.36; Y-axis (Voltage/Amplitude) centered at x = 0.50
  float axisX = 0.50;
  float axisY = 0.36;
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

export const SHADER_PRESETS: ShaderPresetMeta[] = [
  {
    id: 'soft-cloud',
    name: 'Soft Cloud',
    key: '1',
    tagline: 'Dreamy liquid-motion clouds with calm, velvety audio breathing',
    fragmentSource: SOFT_CLOUD_FRAG,
  },
  {
    id: 'cloud',
    name: 'Cloud',
    key: '2',
    tagline: 'Sculpted fluffy cumulus clouds that puff, swell & glow with the music',
    fragmentSource: CLOUD_FRAG,
  },
  {
    id: 'bars',
    name: 'Bars',
    key: '3',
    tagline: 'Bottom-up vertical spectrum bars with falling peak-hold caps',
    fragmentSource: BARS_FRAG,
  },
  {
    id: 'vinyl',
    name: 'Vinyl',
    key: '4',
    tagline: 'Spinning 12" vinyl with live album label, spectrum grooves & reactive stylus',
    fragmentSource: VINYL_FRAG,
  },
  {
    id: 'oscilloscope',
    name: 'Oscilloscope',
    key: '5',
    tagline: 'Real center-triggered single-line oscilloscope with X & Y axes',
    fragmentSource: OSCILLOSCOPE_FRAG,
  },
  {
    id: 'blank',
    name: 'Blank',
    key: '6',
    tagline: 'Clean solid-color background with zero motion',
    fragmentSource: '',
  },
];
