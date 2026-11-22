import type { LyricsLayoutMode, ShaderPresetId, ThemePalette } from '@shared/types';
import type { AudioFrame } from '@/audio/audioEngine';
import { DEFAULT_PALETTE, lerpPalette } from '@/lib/palette';
import { AUDIO_TEX_HEIGHT, AUDIO_TEX_WIDTH, HISTORY_FRAMES } from '@/audio/dsp';
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
    uPresence: WebGLUniformLocation | null;
    uBrilliance: WebGLUniformLocation | null;
    uAir: WebGLUniformLocation | null;
    uTreble: WebGLUniformLocation | null;
    uEnergy: WebGLUniformLocation | null;
    uKick: WebGLUniformLocation | null;
    uSnare: WebGLUniformLocation | null;
    uHiHat: WebGLUniformLocation | null;
    uTransient: WebGLUniformLocation | null;
    uDrop: WebGLUniformLocation | null;
    uColorIndex: WebGLUniformLocation | null;
    uColorCycle: WebGLUniformLocation | null;
    uPulse: WebGLUniformLocation | null;
    uAudioActive: WebGLUniformLocation | null;
    uFade: WebGLUniformLocation | null;
    uCentroid: WebGLUniformLocation | null;
    uTonality: WebGLUniformLocation | null;
    uCrest: WebGLUniformLocation | null;
    uStereoWidth: WebGLUniformLocation | null;
    uStereoBalance: WebGLUniformLocation | null;
    uLyricsActive: WebGLUniformLocation | null;
    uHistoryHead: WebGLUniformLocation | null;
    uChroma: WebGLUniformLocation | null;
    uKickWaves: WebGLUniformLocation | null;
    uSnareWaves: WebGLUniformLocation | null;
    uBackdrop: WebGLUniformLocation | null;
    uDarkStage: WebGLUniformLocation | null;
    uColor1: WebGLUniformLocation | null;
    uColor2: WebGLUniformLocation | null;
    uColor3: WebGLUniformLocation | null;
    uAudioTex: WebGLUniformLocation | null;
    uHistoryTex: WebGLUniformLocation | null;
  };
}

export class ShaderRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private audioTex: WebGLTexture | null = null;
  private historyTex: WebGLTexture | null = null;
  private historyHead = 0;
  private programs = new Map<ShaderPresetId, CompiledProgram>();

  private activePreset: ShaderPresetId = 'atlas';
  private pendingPreset: ShaderPresetId | null = null;
  private fade = 1.0;

  private currentPalette: ThemePalette = DEFAULT_PALETTE;
  private targetPalette: ThemePalette = DEFAULT_PALETTE;
  private currentBlankColor: { r: number; g: number; b: number } = {
    r: 0.024,
    g: 0.031,
    b: 0.059,
  };
  private targetBlankColor: { r: number; g: number; b: number } = {
    r: 0.024,
    g: 0.031,
    b: 0.059,
  };
  private colorCycle = true;
  private targetLyricsActive = 1.0;
  private currentLyricsActive = 1.0;
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

  public setLyricsMode(mode: LyricsLayoutMode, immediate = false): void {
    const target = mode === 'focus' ? 1.0 : mode === 'cinema' ? 0.42 : 0.0;
    this.targetLyricsActive = target;
    if (immediate) {
      this.currentLyricsActive = target;
    }
  }

  public getCurrentPalette(): ThemePalette {
    return this.currentPalette;
  }

  public resize(): void {
    if (!this.gl) return;
    const isSmallScreen = window.innerWidth <= 960 || window.innerHeight <= 560;
    const dprCap = isSmallScreen ? 1.35 : 1.75;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
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
    if (!gl || !this.vao || !this.audioTex || !this.historyTex) return;

    const dt = Math.min(Math.max(dtSec, 0.001), 0.05);
    this.elapsedTime += dt;
    this.flowTime +=
      dt * (0.34 + audio.energy * 0.42 + audio.bass * 0.28 + audio.kick * 0.24);

    const paletteLerp = 1 - Math.exp(-dt * 2.8);
    const blankLerp = 1 - Math.exp(-dt * 8.0);
    const lyricLerp = 1 - Math.exp(-dt * 5.0);
    this.currentPalette = lerpPalette(this.currentPalette, this.targetPalette, paletteLerp);
    this.currentLyricsActive +=
      (this.targetLyricsActive - this.currentLyricsActive) * lyricLerp;
    this.currentBlankColor = {
      r:
        this.currentBlankColor.r +
        (this.targetBlankColor.r - this.currentBlankColor.r) * blankLerp,
      g:
        this.currentBlankColor.g +
        (this.targetBlankColor.g - this.currentBlankColor.g) * blankLerp,
      b:
        this.currentBlankColor.b +
        (this.targetBlankColor.b - this.currentBlankColor.b) * blankLerp,
    };

    if (this.pendingPreset) {
      this.fade = Math.max(0, this.fade - dt * 5.2);
      if (this.fade <= 0.01) {
        this.activePreset = this.pendingPreset;
        this.pendingPreset = null;
      }
    } else if (this.fade < 1.0) {
      this.fade = Math.min(1.0, this.fade + dt * 4.6);
    }

    // Always advance the 64-frame rolling history ring (1 KB upload) so switching into Terrain/Waves is instantaneous!
    this.historyHead = (this.historyHead + 1) % HISTORY_FRAMES;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.historyTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      this.historyHead,
      AUDIO_TEX_WIDTH,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      audio.historyRow
    );

    // Blank mode: pure solid color with zero shader pass & ~0% GPU usage
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
    gl.uniform1f(u.uPresence, audio.presence);
    gl.uniform1f(u.uBrilliance, audio.brilliance);
    gl.uniform1f(u.uAir, audio.air);
    gl.uniform1f(u.uTreble, audio.treble);
    gl.uniform1f(u.uEnergy, audio.energy);
    gl.uniform1f(u.uKick, audio.kick);
    gl.uniform1f(u.uSnare, audio.snare);
    gl.uniform1f(u.uHiHat, audio.hiHat);
    gl.uniform1f(u.uTransient, audio.transient);
    gl.uniform1f(u.uDrop, audio.drop);
    gl.uniform1f(u.uColorIndex, audio.colorIndex);
    gl.uniform1f(u.uColorCycle, this.colorCycle ? 1.0 : 0.0);
    gl.uniform1f(u.uPulse, audio.autoPulse);
    gl.uniform1f(u.uAudioActive, audio.audioActive);
    gl.uniform1f(u.uFade, this.fade);
    gl.uniform1f(u.uCentroid, audio.centroid);
    gl.uniform1f(u.uTonality, audio.tonality);
    gl.uniform1f(u.uCrest, audio.crest);
    gl.uniform1f(u.uStereoWidth, audio.stereoWidth);
    gl.uniform1f(u.uStereoBalance, audio.stereoBalance);
    gl.uniform1f(u.uLyricsActive, this.currentLyricsActive);
    gl.uniform1f(u.uHistoryHead, (this.historyHead + 0.5) / HISTORY_FRAMES);

    if (u.uChroma) gl.uniform1fv(u.uChroma, audio.chroma);
    if (u.uKickWaves) gl.uniform1fv(u.uKickWaves, audio.kickWaves);
    if (u.uSnareWaves) gl.uniform1fv(u.uSnareWaves, audio.snareWaves);

    gl.uniform3f(u.uBackdrop, p.backdrop.r, p.backdrop.g, p.backdrop.b);
    gl.uniform1f(u.uDarkStage, p.darkStage);
    gl.uniform3f(u.uColor1, p.color1.r, p.color1.g, p.color1.b);
    gl.uniform3f(u.uColor2, p.color2.r, p.color2.g, p.color2.b);
    gl.uniform3f(u.uColor3, p.color3.r, p.color3.g, p.color3.b);
    gl.uniform1i(u.uAudioTex, 0);
    gl.uniform1i(u.uHistoryTex, 1);

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
    if (this.historyTex) gl.deleteTexture(this.historyTex);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.audioTex = null;
    this.historyTex = null;
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
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // Texture 0: 256 x 10 R8 instantaneous multi-channel audio data
    const audioTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
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
    this.audioTex = audioTex;

    // Texture 1: 256 x 64 RGBA8 rolling history ring buffer (WRAP_T = REPEAT for circular age lookup!)
    const initHist = new Uint8Array(AUDIO_TEX_WIDTH * HISTORY_FRAMES * 4);
    for (let i = 0; i < AUDIO_TEX_WIDTH * HISTORY_FRAMES; i++) {
      initHist[i * 4 + 0] = 0;
      initHist[i * 4 + 1] = 128;
      initHist[i * 4 + 2] = 0;
      initHist[i * 4 + 3] = 128;
    }
    const historyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, historyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      AUDIO_TEX_WIDTH,
      HISTORY_FRAMES,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      initHist
    );
    this.historyTex = historyTex;

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
          uPresence: gl.getUniformLocation(program, 'uPresence'),
          uBrilliance: gl.getUniformLocation(program, 'uBrilliance'),
          uAir: gl.getUniformLocation(program, 'uAir'),
          uTreble: gl.getUniformLocation(program, 'uTreble'),
          uEnergy: gl.getUniformLocation(program, 'uEnergy'),
          uKick: gl.getUniformLocation(program, 'uKick'),
          uSnare: gl.getUniformLocation(program, 'uSnare'),
          uHiHat: gl.getUniformLocation(program, 'uHiHat'),
          uTransient: gl.getUniformLocation(program, 'uTransient'),
          uDrop: gl.getUniformLocation(program, 'uDrop'),
          uColorIndex: gl.getUniformLocation(program, 'uColorIndex'),
          uColorCycle: gl.getUniformLocation(program, 'uColorCycle'),
          uPulse: gl.getUniformLocation(program, 'uPulse'),
          uAudioActive: gl.getUniformLocation(program, 'uAudioActive'),
          uFade: gl.getUniformLocation(program, 'uFade'),
          uCentroid: gl.getUniformLocation(program, 'uCentroid'),
          uTonality: gl.getUniformLocation(program, 'uTonality'),
          uCrest: gl.getUniformLocation(program, 'uCrest'),
          uStereoWidth: gl.getUniformLocation(program, 'uStereoWidth'),
          uStereoBalance: gl.getUniformLocation(program, 'uStereoBalance'),
          uLyricsActive: gl.getUniformLocation(program, 'uLyricsActive'),
          uHistoryHead: gl.getUniformLocation(program, 'uHistoryHead'),
          uChroma: gl.getUniformLocation(program, 'uChroma'),
          uKickWaves: gl.getUniformLocation(program, 'uKickWaves'),
          uSnareWaves: gl.getUniformLocation(program, 'uSnareWaves'),
          uBackdrop: gl.getUniformLocation(program, 'uBackdrop'),
          uDarkStage: gl.getUniformLocation(program, 'uDarkStage'),
          uColor1: gl.getUniformLocation(program, 'uColor1'),
          uColor2: gl.getUniformLocation(program, 'uColor2'),
          uColor3: gl.getUniformLocation(program, 'uColor3'),
          uAudioTex: gl.getUniformLocation(program, 'uAudioTex'),
          uHistoryTex: gl.getUniformLocation(program, 'uHistoryTex'),
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
