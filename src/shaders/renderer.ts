import type { ShaderPresetId, ThemePalette } from '@shared/types';
import type { AudioFrame } from '@/audio/audioEngine';
import { DEFAULT_PALETTE, lerpPalette } from '@/lib/palette';
import { AUDIO_TEX_WIDTH } from '@/audio/dsp';
import { SHADER_PRESETS, VERTEX_SHADER } from './presets';

interface CompiledProgram {
  program: WebGLProgram;
  uniforms: {
    uResolution: WebGLUniformLocation | null;
    uTime: WebGLUniformLocation | null;
    uFlowTime: WebGLUniformLocation | null;
    uSubBass: WebGLUniformLocation | null;
    uBass: WebGLUniformLocation | null;
    uLowMid: WebGLUniformLocation | null;
    uVocal: WebGLUniformLocation | null;
    uTreble: WebGLUniformLocation | null;
    uEnergy: WebGLUniformLocation | null;
    uKick: WebGLUniformLocation | null;
    uSnare: WebGLUniformLocation | null;
    uHiHat: WebGLUniformLocation | null;
    uDrop: WebGLUniformLocation | null;
    uColorIndex: WebGLUniformLocation | null;
    uColorCycle: WebGLUniformLocation | null;
    uPulse: WebGLUniformLocation | null;
    uAudioActive: WebGLUniformLocation | null;
    uFade: WebGLUniformLocation | null;
    uBackdrop: WebGLUniformLocation | null;
    uDarkStage: WebGLUniformLocation | null;
    uColor1: WebGLUniformLocation | null;
    uColor2: WebGLUniformLocation | null;
    uColor3: WebGLUniformLocation | null;
    uAudioTex: WebGLUniformLocation | null;
  };
}

const AUDIO_TEX_HEIGHT = 2;

export class ShaderRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private audioTex: WebGLTexture | null = null;
  private programs = new Map<ShaderPresetId, CompiledProgram>();

  private activePreset: ShaderPresetId = 'pulse';
  private pendingPreset: ShaderPresetId | null = null;
  private fade = 1.0;

  private currentPalette: ThemePalette = DEFAULT_PALETTE;
  private targetPalette: ThemePalette = DEFAULT_PALETTE;
  private colorCycle = true;
  private elapsedTime = 0;
  private flowTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initContext();
  }

  public isReady(): boolean {
    return this.gl !== null && this.programs.size > 0;
  }

  public setPreset(preset: ShaderPresetId, immediate = false): void {
    if (!this.programs.has(preset)) return;
    if (immediate) {
      this.activePreset = preset;
      this.pendingPreset = null;
      this.fade = 1.0;
      return;
    }
    if (preset === this.activePreset && !this.pendingPreset) return;
    this.pendingPreset = preset;
  }

  public setPalette(palette: ThemePalette): void {
    this.targetPalette = palette;
  }

  public setColorCycle(enabled: boolean): void {
    this.colorCycle = enabled;
  }

  public getCurrentPalette(): ThemePalette {
    return this.currentPalette;
  }

  public resize(): void {
    if (!this.gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  public render(dtSec: number, audio: AudioFrame): void {
    const gl = this.gl;
    if (!gl || !this.vao || !this.audioTex) return;

    const dt = Math.min(Math.max(dtSec, 0.001), 0.05);
    this.elapsedTime += dt;
    this.flowTime +=
      dt * (0.65 + audio.bass * 1.55 + audio.kick * 1.9 + audio.drop * 0.9 + audio.energy * 0.4);

    // Smooth palette cross-fade when track changes
    const paletteLerp = 1 - Math.exp(-dt * 2.2);
    this.currentPalette = lerpPalette(this.currentPalette, this.targetPalette, paletteLerp);

    // Smooth preset transition fade
    if (this.pendingPreset) {
      this.fade = Math.max(0, this.fade - dt * 5.8);
      if (this.fade <= 0.01) {
        this.activePreset = this.pendingPreset;
        this.pendingPreset = null;
      }
    } else if (this.fade < 1.0) {
      this.fade = Math.min(1.0, this.fade + dt * 5.0);
    }

    const compiled = this.programs.get(this.activePreset);
    if (!compiled) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      AUDIO_TEX_WIDTH,
      AUDIO_TEX_HEIGHT,
      gl.RED,
      gl.UNSIGNED_BYTE,
      audio.textureData
    );

    gl.useProgram(compiled.program);
    const u = compiled.uniforms;
    const p = this.currentPalette;

    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this.elapsedTime);
    gl.uniform1f(u.uFlowTime, this.flowTime);
    gl.uniform1f(u.uSubBass, audio.subBass);
    gl.uniform1f(u.uBass, audio.bass);
    gl.uniform1f(u.uLowMid, audio.lowMid);
    gl.uniform1f(u.uVocal, audio.vocal);
    gl.uniform1f(u.uTreble, audio.treble);
    gl.uniform1f(u.uEnergy, audio.energy);
    gl.uniform1f(u.uKick, audio.kick);
    gl.uniform1f(u.uSnare, audio.snare);
    gl.uniform1f(u.uHiHat, audio.hiHat);
    gl.uniform1f(u.uDrop, audio.drop);
    gl.uniform1f(u.uColorIndex, audio.colorIndex);
    gl.uniform1f(u.uColorCycle, this.colorCycle ? 1.0 : 0.0);
    gl.uniform1f(u.uPulse, audio.autoPulse);
    gl.uniform1f(u.uAudioActive, audio.audioActive);
    gl.uniform1f(u.uFade, this.fade);
    gl.uniform3f(u.uBackdrop, p.backdrop.r, p.backdrop.g, p.backdrop.b);
    gl.uniform1f(u.uDarkStage, p.darkStage);
    gl.uniform3f(u.uColor1, p.color1.r, p.color1.g, p.color1.b);
    gl.uniform3f(u.uColor2, p.color2.r, p.color2.g, p.color2.b);
    gl.uniform3f(u.uColor3, p.color3.r, p.color3.g, p.color3.b);
    gl.uniform1i(u.uAudioTex, 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  public dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const { program } of this.programs.values()) {
      gl.deleteProgram(program);
    }
    this.programs.clear();
    if (this.audioTex) gl.deleteTexture(this.audioTex);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.audioTex = null;
    this.vao = null;
    this.gl = null;
  }

  private initContext(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      console.error('[shader] WebGL2 is unavailable.');
      return;
    }

    this.gl = gl;
    this.vao = gl.createVertexArray();

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      AUDIO_TEX_WIDTH,
      AUDIO_TEX_HEIGHT,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      new Uint8Array(AUDIO_TEX_WIDTH * AUDIO_TEX_HEIGHT)
    );
    this.audioTex = tex;

    const vert = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    if (!vert) return;

    for (const preset of SHADER_PRESETS) {
      const frag = this.compileShader(gl, gl.FRAGMENT_SHADER, preset.fragmentSource);
      if (!frag) {
        console.error(`[shader] Failed to compile preset: ${preset.id}`);
        continue;
      }

      const program = gl.createProgram();
      if (!program) continue;
      gl.attachShader(program, vert);
      gl.attachShader(program, frag);
      gl.linkProgram(program);
      gl.deleteShader(frag);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(`[shader] Link failed (${preset.id}):`, gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        continue;
      }

      this.programs.set(preset.id, {
        program,
        uniforms: {
          uResolution: gl.getUniformLocation(program, 'uResolution'),
          uTime: gl.getUniformLocation(program, 'uTime'),
          uFlowTime: gl.getUniformLocation(program, 'uFlowTime'),
          uSubBass: gl.getUniformLocation(program, 'uSubBass'),
          uBass: gl.getUniformLocation(program, 'uBass'),
          uLowMid: gl.getUniformLocation(program, 'uLowMid'),
          uVocal: gl.getUniformLocation(program, 'uVocal'),
          uTreble: gl.getUniformLocation(program, 'uTreble'),
          uEnergy: gl.getUniformLocation(program, 'uEnergy'),
          uKick: gl.getUniformLocation(program, 'uKick'),
          uSnare: gl.getUniformLocation(program, 'uSnare'),
          uHiHat: gl.getUniformLocation(program, 'uHiHat'),
          uDrop: gl.getUniformLocation(program, 'uDrop'),
          uColorIndex: gl.getUniformLocation(program, 'uColorIndex'),
          uColorCycle: gl.getUniformLocation(program, 'uColorCycle'),
          uPulse: gl.getUniformLocation(program, 'uPulse'),
          uAudioActive: gl.getUniformLocation(program, 'uAudioActive'),
          uFade: gl.getUniformLocation(program, 'uFade'),
          uBackdrop: gl.getUniformLocation(program, 'uBackdrop'),
          uDarkStage: gl.getUniformLocation(program, 'uDarkStage'),
          uColor1: gl.getUniformLocation(program, 'uColor1'),
          uColor2: gl.getUniformLocation(program, 'uColor2'),
          uColor3: gl.getUniformLocation(program, 'uColor3'),
          uAudioTex: gl.getUniformLocation(program, 'uAudioTex'),
        },
      });
    }

    gl.deleteShader(vert);
    this.resize();
  }

  private compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[shader] Compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}
