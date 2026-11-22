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
    uSpinAngle: WebGLUniformLocation | null;
    uKickWave: WebGLUniformLocation | null;
    uKickWaveAmp: WebGLUniformLocation | null;
    uHasAlbumArt: WebGLUniformLocation | null;
    uBackdrop: WebGLUniformLocation | null;
    uDarkStage: WebGLUniformLocation | null;
    uColor1: WebGLUniformLocation | null;
    uColor2: WebGLUniformLocation | null;
    uColor3: WebGLUniformLocation | null;
    uAudioTex: WebGLUniformLocation | null;
    uAlbumArt: WebGLUniformLocation | null;
  };
}

const AUDIO_TEX_HEIGHT = 2;

export class ShaderRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private audioTex: WebGLTexture | null = null;
  private albumArtTex: WebGLTexture | null = null;
  private hasAlbumArt = false;
  private artLoadGen = 0;
  private programs = new Map<ShaderPresetId, CompiledProgram>();

  private activePreset: ShaderPresetId = 'cloud';
  private pendingPreset: ShaderPresetId | null = null;
  private fade = 1.0;

  private currentPalette: ThemePalette = DEFAULT_PALETTE;
  private targetPalette: ThemePalette = DEFAULT_PALETTE;
  private currentBlankColor: { r: number; g: number; b: number } = { r: 0.024, g: 0.031, b: 0.059 };
  private targetBlankColor: { r: number; g: number; b: number } = { r: 0.024, g: 0.031, b: 0.059 };
  private colorCycle = true;
  private elapsedTime = 0;
  private flowTime = 0;

  // Turntable spin state (smooth vinyl platter momentum)
  private spinAngle = 0;
  private spinVelocity = 0;

  // Expanding beat shockwave impulse state (0 -> 1.5 across each kick drum hit)
  private kickWave = 1.5;
  private kickWaveAmp = 0;
  private prevKick = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initContext();
  }

  public isReady(): boolean {
    return this.gl !== null && this.programs.size > 0;
  }

  public setPreset(preset: ShaderPresetId, immediate = false): void {
    if (preset !== 'blank' && !this.programs.has(preset)) return;
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

  public setBlankColor(color: { r: number; g: number; b: number }, immediate = false): void {
    this.targetBlankColor = color;
    if (immediate) {
      this.currentBlankColor = { ...color };
    }
  }

  public setColorCycle(enabled: boolean): void {
    this.colorCycle = enabled;
  }

  public setAlbumArt(dataUrl: string | null): void {
    const gen = ++this.artLoadGen;
    if (!dataUrl || !this.gl || !this.albumArtTex) {
      this.hasAlbumArt = false;
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (gen !== this.artLoadGen) return;
      const gl = this.gl;
      if (!gl || !this.albumArtTex) return;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.albumArtTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.hasAlbumArt = true;
    };
    img.onerror = () => {
      if (gen === this.artLoadGen) {
        this.hasAlbumArt = false;
      }
    };
    img.src = dataUrl;
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

  public render(dtSec: number, audio: AudioFrame, isPlaying = true): void {
    const gl = this.gl;
    if (!gl || !this.vao || !this.audioTex) return;

    const dt = Math.min(Math.max(dtSec, 0.001), 0.05);
    this.elapsedTime += dt;
    // Noticeably responsive flow acceleration on bass & beats
    this.flowTime +=
      dt * (0.36 + audio.energy * 0.52 + audio.bass * 0.42 + audio.kick * 0.38);

    // Smooth vinyl turntable rotation (spins briskly when playing, coasts down smoothly when paused)
    const targetSpinVel =
      isPlaying || audio.audioActive > 0.2
        ? 1.95 + audio.energy * 0.30 + audio.drop * 0.35
        : 0.0;
    const spinLerp = 1 - Math.exp(-dt * (targetSpinVel > this.spinVelocity ? 3.2 : 2.1));
    this.spinVelocity += (targetSpinVel - this.spinVelocity) * spinLerp;
    this.spinAngle = (this.spinAngle + this.spinVelocity * dt) % (Math.PI * 200);

    // Trigger expanding beat shockwave on fresh kick hits
    if (audio.kick > 0.40 && audio.kick > this.prevKick + 0.08 && this.kickWave > 0.16) {
      this.kickWave = 0.0;
      this.kickWaveAmp = Math.min(1.0, Math.max(0.45, audio.kick));
    }
    this.prevKick = audio.kick;
    this.kickWave = Math.min(1.5, this.kickWave + dt * 1.48);

    // Smooth palette & responsive blank color cross-fades
    const paletteLerp = 1 - Math.exp(-dt * 2.8);
    const blankLerp = 1 - Math.exp(-dt * 8.0);
    this.currentPalette = lerpPalette(this.currentPalette, this.targetPalette, paletteLerp);
    this.currentBlankColor = {
      r: this.currentBlankColor.r + (this.targetBlankColor.r - this.currentBlankColor.r) * blankLerp,
      g: this.currentBlankColor.g + (this.targetBlankColor.g - this.currentBlankColor.g) * blankLerp,
      b: this.currentBlankColor.b + (this.targetBlankColor.b - this.currentBlankColor.b) * blankLerp,
    };

    // Smooth preset transition fade
    if (this.pendingPreset) {
      this.fade = Math.max(0, this.fade - dt * 5.2);
      if (this.fade <= 0.01) {
        this.activePreset = this.pendingPreset;
        this.pendingPreset = null;
      }
    } else if (this.fade < 1.0) {
      this.fade = Math.min(1.0, this.fade + dt * 4.6);
    }

    // Blank mode: pure crisp solid color with zero shader movement & ~0% GPU usage
    if (this.activePreset === 'blank') {
      gl.clearColor(
        this.currentBlankColor.r * this.fade,
        this.currentBlankColor.g * this.fade,
        this.currentBlankColor.b * this.fade,
        1.0
      );
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
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

    if (this.albumArtTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.albumArtTex);
    }

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
    gl.uniform1f(u.uSpinAngle, this.spinAngle);
    gl.uniform1f(u.uKickWave, this.kickWave);
    gl.uniform1f(u.uKickWaveAmp, this.kickWaveAmp);
    gl.uniform1f(u.uHasAlbumArt, this.hasAlbumArt ? 1.0 : 0.0);
    gl.uniform3f(u.uBackdrop, p.backdrop.r, p.backdrop.g, p.backdrop.b);
    gl.uniform1f(u.uDarkStage, p.darkStage);
    gl.uniform3f(u.uColor1, p.color1.r, p.color1.g, p.color1.b);
    gl.uniform3f(u.uColor2, p.color2.r, p.color2.g, p.color2.b);
    gl.uniform3f(u.uColor3, p.color3.r, p.color3.g, p.color3.b);
    gl.uniform1i(u.uAudioTex, 0);
    gl.uniform1i(u.uAlbumArt, 1);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  public dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    this.artLoadGen++;
    for (const { program } of this.programs.values()) {
      gl.deleteProgram(program);
    }
    this.programs.clear();
    if (this.audioTex) gl.deleteTexture(this.audioTex);
    if (this.albumArtTex) gl.deleteTexture(this.albumArtTex);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.audioTex = null;
    this.albumArtTex = null;
    this.hasAlbumArt = false;
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

    // Audio FFT + waveform data texture (unit 0)
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
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

    // Album cover texture for Vinyl label (unit 1)
    const artTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, artTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([16, 18, 24, 255])
    );
    this.albumArtTex = artTex;

    const vert = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    if (!vert) return;

    for (const preset of SHADER_PRESETS) {
      if (!preset.fragmentSource) continue;
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
          uSpinAngle: gl.getUniformLocation(program, 'uSpinAngle'),
          uKickWave: gl.getUniformLocation(program, 'uKickWave'),
          uKickWaveAmp: gl.getUniformLocation(program, 'uKickWaveAmp'),
          uHasAlbumArt: gl.getUniformLocation(program, 'uHasAlbumArt'),
          uBackdrop: gl.getUniformLocation(program, 'uBackdrop'),
          uDarkStage: gl.getUniformLocation(program, 'uDarkStage'),
          uColor1: gl.getUniformLocation(program, 'uColor1'),
          uColor2: gl.getUniformLocation(program, 'uColor2'),
          uColor3: gl.getUniformLocation(program, 'uColor3'),
          uAudioTex: gl.getUniformLocation(program, 'uAudioTex'),
          uAlbumArt: gl.getUniformLocation(program, 'uAlbumArt'),
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
