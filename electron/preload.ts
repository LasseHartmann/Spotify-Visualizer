import { contextBridge, ipcRenderer } from 'electron';
import type {
  NativeAudioPacket,
  PlaybackControlAction,
  TrackInfo,
  VisualizerApi,
} from '@shared/types';

const api: VisualizerApi = {
  auth: {
    getState: () => ipcRenderer.invoke('auth:get-state'),
    setClientId: (clientId: string) => ipcRenderer.invoke('auth:set-client-id', clientId),
    login: (clientId?: string) => ipcRenderer.invoke('auth:login', clientId),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  spotify: {
    getPlayback: () => ipcRenderer.invoke('spotify:get-playback'),
    control: (action: PlaybackControlAction, currentlyPlaying: boolean) =>
      ipcRenderer.invoke('spotify:control', action, currentlyPlaying),
    fetchImageDataUrl: (url: string) =>
      ipcRenderer.invoke('spotify:fetch-image-data-url', url),
  },
  lyrics: {
    fetch: (track: TrackInfo) => ipcRenderer.invoke('lyrics:fetch', track),
    getOffset: (trackId: string) => ipcRenderer.invoke('lyrics:get-offset', trackId),
    setOffset: (trackId: string, offsetMs: number) =>
      ipcRenderer.invoke('lyrics:set-offset', trackId, offsetMs),
  },
  audio: {
    startTap: (deviceId: string) => ipcRenderer.invoke('audio:start-tap', deviceId),
    stopTap: () => ipcRenderer.invoke('audio:stop-tap'),
    onFrame: (callback: (packet: NativeAudioPacket) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, packet: NativeAudioPacket) => {
        callback(packet);
      };
      ipcRenderer.on('audio:frame', listener);
      return () => {
        ipcRenderer.removeListener('audio:frame', listener);
      };
    },
  },
  window: {
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    setFullscreen: (value: boolean) => ipcRenderer.invoke('window:set-fullscreen', value),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    openExternal: (url: string) => ipcRenderer.invoke('window:open-external', url),
    onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => {
        callback(isFullscreen);
      };
      ipcRenderer.on('window:fullscreen-changed', listener);
      return () => {
        ipcRenderer.removeListener('window:fullscreen-changed', listener);
      };
    },
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
};

contextBridge.exposeInMainWorld('visualizer', api);
