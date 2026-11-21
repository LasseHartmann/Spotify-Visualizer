import { useEffect, useRef } from 'react';
import type { ShaderPresetId, ThemePalette } from '@shared/types';
import { AudioEngine, type AudioCaptureStatus, type AudioFrame } from '@/audio/audioEngine';
import { rgbToCss, sampleMoodColor } from '@/lib/palette';
import { ShaderRenderer } from '@/shaders/renderer';

interface ShaderCanvasProps {
  preset: ShaderPresetId;
  palette: ThemePalette;
  audioEnabled: boolean;
  colorCycle: boolean;
  isPlaying: boolean;
  onAudioStatusChange: (status: AudioCaptureStatus) => void;
  audioEngineRef: React.MutableRefObject<AudioEngine | null>;
}

declare global {
  interface Window {
    __svOverrideAudioFrame?: Partial<AudioFrame> | null;
  }
}

export function ShaderCanvas({
  preset,
  palette,
  audioEnabled,
  colorCycle,
  isPlaying,
  onAudioStatusChange,
  audioEngineRef,
}: ShaderCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ShaderRenderer | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const colorCycleRef = useRef(colorCycle);
  const presetRef = useRef(preset);
  const paletteRef = useRef(palette);
  const audioEnabledRef = useRef(audioEnabled);

  isPlayingRef.current = isPlaying;
  colorCycleRef.current = colorCycle;
  presetRef.current = preset;
  paletteRef.current = palette;
  audioEnabledRef.current = audioEnabled;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new ShaderRenderer(canvas);
    // Apply initial saved state immediately so Color Lock / Preset / Palette take effect on frame 1
    renderer.setPreset(presetRef.current, true);
    renderer.setPalette(paletteRef.current);
    renderer.setColorCycle(colorCycleRef.current);
    rendererRef.current = renderer;

    const audioEngine = new AudioEngine(onAudioStatusChange);
    audioEngine.setEnabled(audioEnabledRef.current);
    audioEngineRef.current = audioEngine;

    if (audioEnabledRef.current) {
      void audioEngine.startCapture();
    }

    const handleResize = () => renderer.resize();
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    let lastTime = performance.now();

    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop);
      const dt = (now - lastTime) * 0.001;
      lastTime = now;

      let frame = audioEngine.update(dt, now, isPlayingRef.current);

      if (window.__svOverrideAudioFrame) {
        frame = { ...frame, ...window.__svOverrideAudioFrame };
      }

      renderer.render(dt, frame);

      const root = document.documentElement.style;
      root.setProperty('--beat', frame.kick.toFixed(3));
      root.setProperty('--energy', frame.energy.toFixed(3));
      root.setProperty('--eq0', Math.max(0.14, frame.eqBars[0]).toFixed(3));
      root.setProperty('--eq1', Math.max(0.14, frame.eqBars[1]).toFixed(3));
      root.setProperty('--eq2', Math.max(0.14, frame.eqBars[2]).toFixed(3));
      root.setProperty('--eq3', Math.max(0.14, frame.eqBars[3]).toFixed(3));
      root.setProperty('--eq4', Math.max(0.14, frame.eqBars[4]).toFixed(3));

      const activeHue = sampleMoodColor(
        renderer.getCurrentPalette(),
        frame.colorIndex,
        colorCycleRef.current
      );
      root.setProperty('--backlight', rgbToCss(activeHue));
      root.setProperty('--highlight', rgbToCss(activeHue));
      root.setProperty('--highlight-glow', rgbToCss(activeHue, 0.65));
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      audioEngine.stopCapture();
      audioEngineRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [audioEngineRef, onAudioStatusChange]);

  useEffect(() => {
    rendererRef.current?.setPreset(preset);
  }, [preset]);

  useEffect(() => {
    rendererRef.current?.setPalette(palette);
  }, [palette]);

  useEffect(() => {
    rendererRef.current?.setColorCycle(colorCycle);
  }, [colorCycle]);

  useEffect(() => {
    audioEngineRef.current?.setEnabled(audioEnabled);
  }, [audioEnabled, audioEngineRef]);

  return <canvas ref={canvasRef} className="shader-canvas" />;
}
