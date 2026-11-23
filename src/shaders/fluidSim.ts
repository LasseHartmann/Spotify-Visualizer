import type { RGB, ThemePalette } from '@shared/types';
import type { AudioFrame } from '@/audio/audioEngine';
import { VERTEX_SHADER } from './presets';

interface FboTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

interface DoubleFbo {
  width: number;
  height: number;
  read: FboTarget;
  write: FboTarget;
  swap(): void;
}

interface WanderingBrush {
  x: number;
  y: number;
  angle: number;
  turnRate: number;
  targetTurnRate: number;
  turnTimer: number;
  speed: number;
  colorSlot: 0 | 1 | 2;
}

interface BurstJet {
  x: number;
  y: number;
  angle: number;
  curveRate: number;
  speed: number;
  life: number;
  maxLife: number;
  radius: number;
  force: number;
  colorSlot: 0 | 1 | 2;
}

const SIM_WIDTH = 160;
const SIM_HEIGHT = 90;
const DYE_WIDTH = 512;
const DYE_HEIGHT = 288;
const PRESSURE_ITERATIONS = 16;

const SPLAT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTarget;
uniform float uAspect;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;

void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  float splat = exp(-dot(p, p) / max(uRadius, 1e-5));
  vec3 base = texture(uTarget, vUv).xyz;
  fragColor = vec4(base + splat * uColor, 1.0);
}
`;

const CURL_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
  float vorticity = R - L - T + B;
  fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

const VORTICITY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexelSize;
uniform float uCurlStrength;
uniform float uDt;

void main() {
  float L = texture(uCurl, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexelSize.x, 0.0)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexelSize.y)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexelSize.y)).x;
  float C = texture(uCurl, vUv).x;

  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uCurlStrength * C;
  force.y *= -1.0;

  vec2 vel = texture(uVelocity, vUv).xy;
  vel += force * uDt;
  vel = clamp(vel, vec2(-1000.0), vec2(1000.0));
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

const DIVERGENCE_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  vec2 vL = vUv - vec2(uTexelSize.x, 0.0);
  vec2 vR = vUv + vec2(uTexelSize.x, 0.0);
  vec2 vT = vUv + vec2(0.0, uTexelSize.y);
  vec2 vB = vUv - vec2(0.0, uTexelSize.y);

  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;

  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;

  float div = 0.5 * (R - L + T - B);
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const CLEAR_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform float uValue;

void main() {
  fragColor = uValue * texture(uTexture, vUv);
}
`;

const PRESSURE_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexelSize;

void main() {
  float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const GRADIENT_SUBTRACT_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  vec2 vel = texture(uVelocity, vUv).xy;
  vel -= 0.5 * vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}
`;

const ADVECTION_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
uniform float uDt;
uniform float uDissipation;

void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexelSize;
  vec4 result = texture(uSource, clamp(coord, vec2(0.001), vec2(0.999)));
  float decay = 1.0 + uDissipation * uDt;
  fragColor = result / decay;
}
`;

const DISPLAY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uDye;
uniform vec2 uDyeTexelSize;
uniform vec3 uBackdrop;
uniform float uDarkStage;
uniform float uFade;
uniform float uTime;
uniform float uShimmer;
uniform float uBeatLift;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 c = max(texture(uDye, vUv).rgb, vec3(0.0));

  // Silky wet liquid sheen from smoothed 2-texel dye gradient (glossy fluid surface, glistens on treble/hi-hats!)
  vec2 stepUv = uDyeTexelSize * 2.0;
  vec3 cL = texture(uDye, vUv - vec2(stepUv.x, 0.0)).rgb;
  vec3 cR = texture(uDye, vUv + vec2(stepUv.x, 0.0)).rgb;
  vec3 cT = texture(uDye, vUv + vec2(0.0, stepUv.y)).rgb;
  vec3 cB = texture(uDye, vUv - vec2(0.0, stepUv.y)).rgb;

  float dx = length(cR) - length(cL);
  float dy = length(cT) - length(cB);
  vec3 n = normalize(vec3(dx * 1.35, dy * 1.35, 0.50));
  float spec = pow(max(dot(n, normalize(vec3(0.35, 0.55, 0.85))), 0.0), 12.0);
  float density = clamp(length(c), 0.0, 1.0);
  c += mix(c, vec3(1.0), 0.28) * spec * (0.14 + uShimmer * 0.24) * smoothstep(0.08, 0.60, density);

  // Soft filmic curve keeps dark canvas rich & fluid swoops glowing vividly on beats
  vec3 mapped = c / (vec3(1.0) + c * 0.44);
  mapped *= uBeatLift;

  // Deep album-tinted dark backdrop so swirling swoops pop cleanly like Magic Fluids
  vec3 bg = uBackdrop * mix(0.62, 0.16, uDarkStage);
  vec3 col = bg + mapped * 1.04;

  float peak = max(col.r, max(col.g, col.b));
  if (peak > 0.88) {
    float compressed = 0.88 + (1.0 - exp(-(peak - 0.88) * 1.6)) * 0.12;
    col *= compressed / peak;
  }

  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 59.0) - 0.5) / 255.0;
  fragColor = vec4(clamp(col * uFade + dither, 0.0, 1.0), 1.0);
}
`;

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/**
 * Real 2D GPU Navier-Stokes fluid solver (ping-pong WebGL2 FBOs) for the Liquid style.
 * Simulates velocity at 128x72 and album-colored dye at 512x288 for buttery 60+ FPS
 * with authentic curling vortices and music-driven random fluid swoops.
 */
export class FluidSimulator {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private supported = false;
  private seeded = false;

  private velocity: DoubleFbo | null = null;
  private dye: DoubleFbo | null = null;
  private divergence: FboTarget | null = null;
  private curl: FboTarget | null = null;
  private pressure: DoubleFbo | null = null;

  private programs: WebGLProgram[] = [];
  private splatProg: WebGLProgram | null = null;
  private curlProg: WebGLProgram | null = null;
  private vorticityProg: WebGLProgram | null = null;
  private divergenceProg: WebGLProgram | null = null;
  private clearProg: WebGLProgram | null = null;
  private pressureProg: WebGLProgram | null = null;
  private gradSubProg: WebGLProgram | null = null;
  private advectProg: WebGLProgram | null = null;
  private displayProg: WebGLProgram | null = null;

  // Cached uniform locations
  private uSplat: Record<string, WebGLUniformLocation | null> = {};
  private uCurl: Record<string, WebGLUniformLocation | null> = {};
  private uVort: Record<string, WebGLUniformLocation | null> = {};
  private uDiv: Record<string, WebGLUniformLocation | null> = {};
  private uClear: Record<string, WebGLUniformLocation | null> = {};
  private uPress: Record<string, WebGLUniformLocation | null> = {};
  private uGrad: Record<string, WebGLUniformLocation | null> = {};
  private uAdv: Record<string, WebGLUniformLocation | null> = {};
  private uDisp: Record<string, WebGLUniformLocation | null> = {};

  // Two graceful music-guided ribbons (0 = bass/energy ribbon, 1 = vocal melody ribbon) + beat swoop jets
  private brushes: WanderingBrush[] = [
    { x: 0.26, y: 0.42, angle: 0.35, turnRate: 0.4, targetTurnRate: 0.45, turnTimer: 2.2, speed: 0.19, colorSlot: 0 },
    { x: 0.74, y: 0.58, angle: 3.45, turnRate: -0.45, targetTurnRate: -0.4, turnTimer: 2.6, speed: 0.18, colorSlot: 2 },
  ];
  private jets: BurstJet[] = [];
  private prevKick = 0;
  private prevSnare = 0;
  private kickCooldown = 0;
  private snareCooldown = 0;
  private lastSpawnQuadrant = 0;
  private idleSwoopTimer = 1.6;
  private smoothShimmer = 0;
  private smoothBeatLift = 1;
  private elapsed = 0;

  constructor(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject) {
    this.gl = gl;
    this.vao = vao;
    this.init();
  }

  public isSupported(): boolean {
    return this.supported;
  }

  public render(
    dtSec: number,
    canvasWidth: number,
    canvasHeight: number,
    audio: AudioFrame,
    palette: ThemePalette,
    colorCycle: boolean,
    fade: number
  ): void {
    if (!this.supported || !this.velocity || !this.dye || !this.displayProg) return;
    const gl = this.gl;
    const dt = Math.min(Math.max(dtSec, 0.004), 0.033);
    this.elapsed += dt;
    const aspect = canvasWidth / Math.max(canvasHeight, 1);

    // Seed initial lush swirling strokes on first frame so Liquid never starts blank
    if (!this.seeded) {
      this.seeded = true;
      this.seedInitialSwirls(palette, colorCycle, audio.colorIndex, aspect);
    }

    // 1. Update wandering curved brushes & fire random beat-driven fluid swoop jets
    this.emitMusicSwoops(dt, audio, palette, colorCycle, aspect);

    // 2. Run real 2D incompressible Navier-Stokes simulation step paced by music energy!
    const flowScale = 0.36 + Math.min(1.15, audio.energy * 0.62 + audio.bass * 0.28 + audio.kick * 0.44);
    this.stepFluid(dt * flowScale, audio);

    // 3. Render glossy dye field to screen (with subtle beat lift & hi-hat wet shimmer)
    const targetShimmer = Math.min(1.2, audio.treble * 0.60 + audio.hiHat * 0.65 + audio.snare * 0.30);
    const targetBeatLift = 0.94 + Math.min(0.26, audio.energy * 0.10 + audio.kick * 0.16 + audio.bass * 0.08);
    const smoothK = Math.min(1, dt * 10);
    this.smoothShimmer += (targetShimmer - this.smoothShimmer) * smoothK;
    this.smoothBeatLift += (targetBeatLift - this.smoothBeatLift) * smoothK;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.useProgram(this.displayProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.texture);
    gl.uniform1i(this.uDisp.uDye, 0);
    gl.uniform2f(this.uDisp.uDyeTexelSize, 1 / DYE_WIDTH, 1 / DYE_HEIGHT);
    gl.uniform3f(this.uDisp.uBackdrop, palette.backdrop.r, palette.backdrop.g, palette.backdrop.b);
    gl.uniform1f(this.uDisp.uDarkStage, palette.darkStage);
    gl.uniform1f(this.uDisp.uFade, fade);
    gl.uniform1f(this.uDisp.uTime, this.elapsed);
    gl.uniform1f(this.uDisp.uShimmer, this.smoothShimmer);
    gl.uniform1f(this.uDisp.uBeatLift, this.smoothBeatLift);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  public dispose(): void {
    const gl = this.gl;
    for (const p of this.programs) gl.deleteProgram(p);
    this.programs = [];
    const freeTarget = (t: FboTarget | null) => {
      if (!t) return;
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.texture);
    };
    const freeDouble = (d: DoubleFbo | null) => {
      if (!d) return;
      freeTarget(d.read);
      freeTarget(d.write);
    };
    freeDouble(this.velocity);
    freeDouble(this.dye);
    freeDouble(this.pressure);
    freeTarget(this.divergence);
    freeTarget(this.curl);
    this.velocity = null;
    this.dye = null;
    this.pressure = null;
    this.divergence = null;
    this.curl = null;
    this.supported = false;
  }

  private init(): void {
    const gl = this.gl;
    const hasFloat = Boolean(gl.getExtension('EXT_color_buffer_float'));
    const hasHalfFloat = Boolean(gl.getExtension('EXT_color_buffer_half_float'));
    if (!hasFloat && !hasHalfFloat) {
      return;
    }

    const vert = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    if (!vert) return;

    this.splatProg = this.link(vert, SPLAT_FRAG);
    this.curlProg = this.link(vert, CURL_FRAG);
    this.vorticityProg = this.link(vert, VORTICITY_FRAG);
    this.divergenceProg = this.link(vert, DIVERGENCE_FRAG);
    this.clearProg = this.link(vert, CLEAR_FRAG);
    this.pressureProg = this.link(vert, PRESSURE_FRAG);
    this.gradSubProg = this.link(vert, GRADIENT_SUBTRACT_FRAG);
    this.advectProg = this.link(vert, ADVECTION_FRAG);
    this.displayProg = this.link(vert, DISPLAY_FRAG);
    gl.deleteShader(vert);

    if (
      !this.splatProg ||
      !this.curlProg ||
      !this.vorticityProg ||
      !this.divergenceProg ||
      !this.clearProg ||
      !this.pressureProg ||
      !this.gradSubProg ||
      !this.advectProg ||
      !this.displayProg
    ) {
      this.dispose();
      return;
    }

    this.velocity = this.createDoubleFbo(SIM_WIDTH, SIM_HEIGHT, gl.LINEAR);
    this.dye = this.createDoubleFbo(DYE_WIDTH, DYE_HEIGHT, gl.LINEAR);
    this.divergence = this.createFbo(SIM_WIDTH, SIM_HEIGHT, gl.NEAREST);
    this.curl = this.createFbo(SIM_WIDTH, SIM_HEIGHT, gl.NEAREST);
    this.pressure = this.createDoubleFbo(SIM_WIDTH, SIM_HEIGHT, gl.NEAREST);

    if (!this.velocity || !this.dye || !this.divergence || !this.curl || !this.pressure) {
      this.dispose();
      return;
    }

    this.uSplat = this.getUniforms(this.splatProg, ['uTarget', 'uAspect', 'uPoint', 'uColor', 'uRadius']);
    this.uCurl = this.getUniforms(this.curlProg, ['uVelocity', 'uTexelSize']);
    this.uVort = this.getUniforms(this.vorticityProg, ['uVelocity', 'uCurl', 'uTexelSize', 'uCurlStrength', 'uDt']);
    this.uDiv = this.getUniforms(this.divergenceProg, ['uVelocity', 'uTexelSize']);
    this.uClear = this.getUniforms(this.clearProg, ['uTexture', 'uValue']);
    this.uPress = this.getUniforms(this.pressureProg, ['uPressure', 'uDivergence', 'uTexelSize']);
    this.uGrad = this.getUniforms(this.gradSubProg, ['uPressure', 'uVelocity', 'uTexelSize']);
    this.uAdv = this.getUniforms(this.advectProg, ['uVelocity', 'uSource', 'uTexelSize', 'uDt', 'uDissipation']);
    this.uDisp = this.getUniforms(this.displayProg, [
      'uDye',
      'uDyeTexelSize',
      'uBackdrop',
      'uDarkStage',
      'uFade',
      'uTime',
      'uShimmer',
      'uBeatLift',
    ]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.supported = true;
  }

  private pickPaletteColor(
    palette: ThemePalette,
    colorCycle: boolean,
    colorIndex: number,
    slot: 0 | 1 | 2
  ): RGB {
    const base = [palette.color1, palette.color2, palette.color3];
    if (!colorCycle) {
      return base[slot];
    }
    const idx = (((colorIndex + slot) % 3) + 3) % 3;
    const i0 = Math.floor(idx) % 3;
    const i1 = (i0 + 1) % 3;
    const frac = idx - Math.floor(idx);
    const s = frac * frac * (3 - 2 * frac);
    return mixRgb(base[i0], base[i1], s);
  }

  private seedInitialSwirls(
    palette: ThemePalette,
    colorCycle: boolean,
    colorIndex: number,
    aspect: number
  ): void {
    const seeds: Array<{ x: number; y: number; dx: number; dy: number; slot: 0 | 1 | 2 }> = [
      { x: 0.24, y: 0.38, dx: 0.22, dy: 0.14, slot: 0 },
      { x: 0.76, y: 0.62, dx: -0.24, dy: -0.12, slot: 1 },
    ];
    for (let step = 0; step < 5; step++) {
      const f = step / 5;
      for (const s of seeds) {
        const col = this.pickPaletteColor(palette, colorCycle, colorIndex, s.slot);
        this.splat(
          s.x + s.dx * f,
          s.y + s.dy * f,
          s.dx * 260,
          s.dy * 260,
          col.r * 0.24,
          col.g * 0.24,
          col.b * 0.24,
          0.0055,
          aspect
        );
      }
      this.stepFluid(0.016, {
        subBass: 0.25,
        bass: 0.30,
        lowMid: 0.20,
        vocal: 0.25,
        treble: 0.15,
        energy: 0.30,
        kick: 0,
        snare: 0,
        hiHat: 0,
        drop: 0,
        autoPulse: 1,
        colorIndex,
        audioActive: 1,
        rms: 0.1,
        eqBars: [0, 0, 0, 0, 0],
        textureData: new Uint8Array(0),
      });
    }
  }

  private emitMusicSwoops(
    dt: number,
    audio: AudioFrame,
    palette: ThemePalette,
    colorCycle: boolean,
    aspect: number
  ): void {
    const bass = Math.min(1.1, audio.bass * 0.85 + audio.subBass * 0.40);
    const vocal = Math.min(1.05, audio.vocal * 0.85 + audio.lowMid * 0.25);
    const musicActive = audio.audioActive > 0.25;

    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.snareCooldown = Math.max(0, this.snareCooldown - dt);

    // Cleanly debounced beat triggers: every kick or snare launches ONE graceful sweeping ribbon (never chaotic!)
    const kickTrig =
      audio.kick > 0.34 &&
      audio.kick > this.prevKick + 0.055 &&
      this.kickCooldown <= 0;
    const snareTrig =
      audio.snare > 0.36 &&
      audio.snare > this.prevSnare + 0.065 &&
      this.snareCooldown <= 0;
    this.prevKick = audio.kick;
    this.prevSnare = audio.snare;

    if (kickTrig && this.jets.length < 3) {
      this.kickCooldown = 0.26;
      const strength = Math.min(1, audio.kick * 0.8 + bass * 0.35);
      this.spawnChoreographedJet(
        0,
        0.52 + strength * 0.20,
        0.0044 + strength * 0.0020,
        360 + strength * 260,
        palette,
        colorCycle,
        audio.colorIndex,
        aspect,
        0.24 + strength * 0.14
      );
      // On big drops, launch a harmonious counter-arc from the opposite side
      if ((audio.drop > 0.42 || (audio.kick > 0.78 && bass > 0.62)) && this.jets.length < 3) {
        this.spawnChoreographedJet(
          1,
          0.56 + strength * 0.16,
          0.0040 + strength * 0.0016,
          340 + strength * 210,
          palette,
          colorCycle,
          audio.colorIndex,
          aspect,
          0.22 + strength * 0.12
        );
      }
    }

    if (snareTrig && this.jets.length < 2) {
      this.snareCooldown = 0.26;
      const strength = Math.min(1, audio.snare * 0.8 + vocal * 0.30);
      this.spawnChoreographedJet(
        1,
        0.46 + strength * 0.18,
        0.0034 + strength * 0.0016,
        310 + strength * 210,
        palette,
        colorCycle,
        audio.colorIndex,
        aspect,
        0.20 + strength * 0.12
      );
    }

    // Only emit a slow calm screensaver swoop when audio is completely idle/paused;
    // when music is playing, EVERY swoop is genuinely triggered by the music!
    if (!musicActive) {
      this.idleSwoopTimer -= dt;
      if (this.idleSwoopTimer <= 0) {
        this.idleSwoopTimer = 2.8 + Math.random() * 1.4;
        if (this.jets.length < 1) {
          const slot = (this.lastSpawnQuadrant % 3) as 0 | 1 | 2;
          this.spawnChoreographedJet(
            slot,
            0.72,
            0.0044,
            210,
            palette,
            colorCycle,
            audio.colorIndex,
            aspect,
            0.14
          );
        }
      }
    } else {
      this.idleSwoopTimer = 2.0;
    }

    // Advance active beat swoop jets (front-loaded punch on the beat, gliding smoothly into silk curls)
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const jet = this.jets[i];
      jet.life += dt;
      if (jet.life >= jet.maxLife) {
        this.jets.splice(i, 1);
        continue;
      }
      const p = jet.life / jet.maxLife;
      const env = Math.pow(Math.sin(p * Math.PI), 0.65) * (1.22 - 0.58 * p);
      jet.angle += jet.curveRate * dt;
      const vx = Math.cos(jet.angle) * jet.speed;
      const vy = Math.sin(jet.angle) * jet.speed;
      jet.x += vx * dt;
      jet.y += vy * dt;

      if (jet.x < 0.05 || jet.x > 0.95 || jet.y < 0.05 || jet.y > 0.95) {
        jet.life = jet.maxLife;
        continue;
      }

      const col = this.pickPaletteColor(palette, colorCycle, audio.colorIndex, jet.colorSlot);
      const dyeGain = (0.16 + audio.energy * 0.16 + audio.kick * 0.14) * env;
      this.splat(
        jet.x,
        jet.y,
        vx * jet.force * env,
        vy * jet.force * env,
        col.r * dyeGain,
        col.g * dyeGain,
        col.b * dyeGain,
        jet.radius * (0.78 + env * 0.30),
        aspect
      );
    }

    // Graceful music-paced ribbons:
    // Brush 0 glides gently with bass/energy (whisper-quiet during calm moments, rich on basslines).
    // Brush 1 rises smoothly ONLY when vocals/melody enter (quiet when no vocals!).
    for (let i = 0; i < this.brushes.length; i++) {
      const b = this.brushes[i];
      const drive = i === 0 ? Math.max(bass, audio.energy * 0.75) : vocal;

      b.turnTimer -= dt;
      if (b.turnTimer <= 0) {
        b.turnTimer = 2.0 + Math.random() * 2.2;
        b.targetTurnRate = (Math.random() - 0.5) * 1.45;
      }
      // Smooth eased steering -> long graceful arcs, zero sudden jerky turns!
      b.turnRate += (b.targetTurnRate - b.turnRate) * Math.min(1, dt * 1.8);

      const dxC = 0.5 - b.x;
      const dyC = 0.5 - b.y;
      if (b.x < 0.16 || b.x > 0.84 || b.y < 0.16 || b.y > 0.84) {
        const targetAng = Math.atan2(dyC, dxC);
        let diff = targetAng - b.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        b.angle += diff * Math.min(1, dt * 2.2);
      } else {
        b.angle += b.turnRate * dt;
      }

      const baseSpeed = i === 0 ? 0.30 : 0.18;
      const moveSpeed = b.speed * (baseSpeed + drive * 1.05 + (i === 0 ? audio.kick * 0.45 : audio.snare * 0.35));
      const vx = Math.cos(b.angle) * moveSpeed;
      const vy = Math.sin(b.angle) * moveSpeed;
      b.x = Math.max(0.06, Math.min(0.94, b.x + vx * dt));
      b.y = Math.max(0.06, Math.min(0.94, b.y + vy * dt));

      // Keep Brush 1 completely quiet until vocals/melody actually bloom
      if (i === 1 && drive < 0.14) continue;
      const vocalPresence = i === 1 ? Math.min(1, (drive - 0.14) / 0.36) : 1;

      const col = this.pickPaletteColor(palette, colorCycle, audio.colorIndex, b.colorSlot);
      const force =
        i === 0
          ? 38 + drive * 235 + audio.kick * 165
          : (40 + drive * 210 + audio.snare * 95) * vocalPresence;
      const dyeAmp =
        i === 0
          ? 0.022 + drive * 0.145 + audio.kick * 0.06
          : (0.015 + drive * 0.14) * vocalPresence;
      const radius = 0.0028 + drive * 0.0020;

      this.splat(
        b.x,
        b.y,
        vx * force,
        vy * force,
        col.r * dyeAmp,
        col.g * dyeAmp,
        col.b * dyeAmp,
        radius,
        aspect
      );
    }
  }

  private spawnChoreographedJet(
    colorSlot: 0 | 1 | 2,
    maxLife: number,
    radius: number,
    force: number,
    palette: ThemePalette,
    colorCycle: boolean,
    colorIndex: number,
    aspect: number,
    initialDyeGain: number
  ): void {
    // Alternate across opposite screen quadrants so beat swoops dance gracefully across fresh dark canvas
    const quad = (this.lastSpawnQuadrant + 1 + (Math.random() < 0.35 ? 1 : 0)) % 4;
    this.lastSpawnQuadrant = quad;
    const qx = quad === 0 || quad === 3 ? 0.18 + Math.random() * 0.16 : 0.66 + Math.random() * 0.16;
    const qy = quad === 0 || quad === 1 ? 0.20 + Math.random() * 0.18 : 0.62 + Math.random() * 0.18;

    const centerAng = Math.atan2(0.5 - qy, 0.5 - qx);
    const angle = centerAng + (Math.random() - 0.5) * 0.85;
    const speed = 0.48 + Math.random() * 0.24;

    // Immediate zero-latency downbeat impulse right on the kick/snare hit frame!
    const col = this.pickPaletteColor(palette, colorCycle, colorIndex, colorSlot);
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    this.splat(
      qx,
      qy,
      vx * force * 0.85,
      vy * force * 0.85,
      col.r * initialDyeGain,
      col.g * initialDyeGain,
      col.b * initialDyeGain,
      radius * 1.1,
      aspect
    );

    this.jets.push({
      x: qx,
      y: qy,
      angle,
      curveRate: (Math.random() - 0.5) * 1.9,
      speed,
      life: 0,
      maxLife,
      radius,
      force,
      colorSlot,
    });
  }

  private splat(
    x: number,
    y: number,
    dx: number,
    dy: number,
    r: number,
    g: number,
    b: number,
    radius: number,
    aspect: number
  ): void {
    if (!this.splatProg || !this.velocity || !this.dye) return;
    const gl = this.gl;

    gl.useProgram(this.splatProg);
    gl.uniform1i(this.uSplat.uTarget, 0);
    gl.uniform1f(this.uSplat.uAspect, aspect);
    gl.uniform2f(this.uSplat.uPoint, x, y);

    // Splat velocity
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform3f(this.uSplat.uColor, dx, dy, 0.0);
    gl.uniform1f(this.uSplat.uRadius, radius);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Splat dye color
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.texture);
    gl.uniform3f(this.uSplat.uColor, r, g, b);
    gl.uniform1f(this.uSplat.uRadius, radius * 1.15);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  private stepFluid(dt: number, audio: AudioFrame): void {
    if (
      !this.velocity ||
      !this.dye ||
      !this.curl ||
      !this.divergence ||
      !this.pressure ||
      !this.curlProg ||
      !this.vorticityProg ||
      !this.divergenceProg ||
      !this.clearProg ||
      !this.pressureProg ||
      !this.gradSubProg ||
      !this.advectProg
    ) {
      return;
    }

    const gl = this.gl;
    const simTexelX = 1 / SIM_WIDTH;
    const simTexelY = 1 / SIM_HEIGHT;

    // 1. Curl
    gl.useProgram(this.curlProg);
    gl.uniform2f(this.uCurl.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(this.uCurl.uVelocity, 0);
    this.blit(this.curl);

    // 2. Vorticity confinement (creates iconic swirling liquid curls!)
    gl.useProgram(this.vorticityProg);
    gl.uniform2f(this.uVort.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(this.uVort.uVelocity, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curl.texture);
    gl.uniform1i(this.uVort.uCurl, 1);
    gl.uniform1f(this.uVort.uCurlStrength, 8.5 + audio.energy * 5.5 + audio.kick * 4.5);
    gl.uniform1f(this.uVort.uDt, dt);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // 3. Divergence
    gl.useProgram(this.divergenceProg);
    gl.uniform2f(this.uDiv.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(this.uDiv.uVelocity, 0);
    this.blit(this.divergence);

    // 4. Dampen previous pressure (warm start)
    gl.useProgram(this.clearProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
    gl.uniform1i(this.uClear.uTexture, 0);
    gl.uniform1f(this.uClear.uValue, 0.82);
    this.blit(this.pressure.write);
    this.pressure.swap();

    // 5. Pressure projection (12 fast Jacobi iterations on 128x72!)
    gl.useProgram(this.pressureProg);
    gl.uniform2f(this.uPress.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.divergence.texture);
    gl.uniform1i(this.uPress.uDivergence, 0);
    gl.uniform1i(this.uPress.uPressure, 1);
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    // 6. Subtract pressure gradient -> incompressible velocity field
    gl.useProgram(this.gradSubProg);
    gl.uniform2f(this.uGrad.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
    gl.uniform1i(this.uGrad.uPressure, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(this.uGrad.uVelocity, 1);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // 7. Advect velocity
    gl.useProgram(this.advectProg);
    gl.uniform2f(this.uAdv.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(this.uAdv.uVelocity, 0);
    gl.uniform1i(this.uAdv.uSource, 0);
    gl.uniform1f(this.uAdv.uDt, dt);
    gl.uniform1f(this.uAdv.uDissipation, 0.65);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // 8. Advect high-res album-color dye
    gl.uniform2f(this.uAdv.uTexelSize, simTexelX, simTexelY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform1i(this.uAdv.uVelocity, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.texture);
    gl.uniform1i(this.uAdv.uSource, 1);
    gl.uniform1f(this.uAdv.uDt, dt);
    gl.uniform1f(this.uAdv.uDissipation, 0.92);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  private blit(target: FboTarget): void {
    const gl = this.gl;
    gl.viewport(0, 0, target.width, target.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private createFbo(width: number, height: number, filter: number): FboTarget | null {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);

    const fbo = gl.createFramebuffer();
    if (!fbo) {
      gl.deleteTexture(texture);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(texture);
      return null;
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, fbo, width, height };
  }

  private createDoubleFbo(width: number, height: number, filter: number): DoubleFbo | null {
    const a = this.createFbo(width, height, filter);
    const b = this.createFbo(width, height, filter);
    if (!a || !b) {
      if (a) {
        this.gl.deleteFramebuffer(a.fbo);
        this.gl.deleteTexture(a.texture);
      }
      if (b) {
        this.gl.deleteFramebuffer(b.fbo);
        this.gl.deleteTexture(b.texture);
      }
      return null;
    }
    return {
      width,
      height,
      read: a,
      write: b,
      swap() {
        const tmp = this.read;
        this.read = this.write;
        this.write = tmp;
      },
    };
  }

  private compile(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[fluidSim] Compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private link(vert: WebGLShader, fragSource: string): WebGLProgram | null {
    const gl = this.gl;
    const frag = this.compile(gl.FRAGMENT_SHADER, fragSource);
    if (!frag) return null;
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(frag);
      return null;
    }
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[fluidSim] Link error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    this.programs.push(prog);
    return prog;
  }

  private getUniforms(
    prog: WebGLProgram,
    names: string[]
  ): Record<string, WebGLUniformLocation | null> {
    const out: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) {
      out[n] = this.gl.getUniformLocation(prog, n);
    }
    return out;
  }
}
