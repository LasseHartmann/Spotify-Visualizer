import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session, shell } from 'electron';
import { SpotifyService } from './spotify';
import { LyricsService } from './lyrics';
import { NativeAudioTapService } from './audioTap';
import type { PlaybackControlAction, TrackInfo } from '@shared/types';

// Keep GPU WebGL2 smooth and prevent Chromium background throttling on multi-monitor setups
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const spotifyService = new SpotifyService();
const lyricsService = new LyricsService();
const audioTapService = new NativeAudioTapService();

let mainWindow: BrowserWindow | null = null;

function getAppIconPath(): string {
  return path.join(__dirname, '..', '..', 'build', 'icon.png');
}

function createWindow(): void {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    title: 'Spotify Visualizer',
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    fullscreen: true,
    backgroundColor: '#06080f',
    autoHideMenuBar: true,
    show: false,
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreen-changed', true);
  });

  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreen-changed', false);
  });

  mainWindow.on('closed', () => {
    audioTapService.stop();
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('auth:get-state', () => spotifyService.getAuthState());

  ipcMain.handle('auth:set-client-id', (_event, clientId: string) =>
    spotifyService.setClientId(clientId)
  );

  ipcMain.handle('auth:login', (_event, clientId?: string) =>
    spotifyService.login(clientId, () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    })
  );

  ipcMain.handle('auth:logout', () => spotifyService.logout());

  ipcMain.handle('spotify:get-playback', () => spotifyService.getCurrentlyPlaying());

  ipcMain.handle(
    'spotify:control',
    async (_event, action: PlaybackControlAction, currentlyPlaying: boolean) => {
      // Try Spotify Web API first (controls remote devices too); instantly fall back to Windows media keys
      // for Free accounts or existing sessions without the modify-playback scope.
      const apiOk = await spotifyService.controlPlayback(action, currentlyPlaying);
      if (apiOk) return true;
      return audioTapService.sendMediaKey(action);
    }
  );

  ipcMain.handle('spotify:fetch-image-data-url', (_event, url: string) =>
    spotifyService.fetchImageDataUrl(url)
  );

  ipcMain.handle('lyrics:fetch', (_event, track: TrackInfo) =>
    lyricsService.fetchLyrics(track)
  );

  ipcMain.handle('lyrics:get-offset', (_event, trackId: string) =>
    lyricsService.getOffset(trackId)
  );

  ipcMain.handle('lyrics:set-offset', (_event, trackId: string, offsetMs: number) => {
    lyricsService.setOffset(trackId, offsetMs);
  });

  ipcMain.handle('audio:start-tap', (_event, deviceId: string) =>
    audioTapService.start(
      deviceId,
      (packet) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:frame', packet);
        }
      },
      (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:status', status);
        }
      }
    )
  );

  ipcMain.handle('audio:stop-tap', () => {
    audioTapService.stop();
  });

  ipcMain.handle('window:toggle-fullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });

  ipcMain.handle('window:set-fullscreen', (_event, value: boolean) => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(Boolean(value));
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false);

  ipcMain.handle('window:open-external', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('before-quit', () => {
    audioTapService.stop();
  });

  app.whenReady().then(() => {
    // Built-in Chromium WASAPI loopback handler used automatically if wasapi-tap.exe is blocked or fails
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('[audioTap] Display media loopback fallback failed:', err);
        callback({});
      }
    });

    spotifyService.init();
    lyricsService.init();
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    audioTapService.stop();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
