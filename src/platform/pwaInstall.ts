import { isWebPlatform } from './webBridge';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt: () => Promise<void>;
}

export type PwaInstallState =
  | 'hidden'      // Desktop Electron, already installed, or unsupported browser
  | 'prompt'      // Native 1-click browser install prompt ready (Chrome / Edge / Android)
  | 'ios-guide';  // iOS Safari (install via Share -> Add to Home Screen)

export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mql = window.matchMedia?.('(display-mode: standalone)')?.matches;
  const iosStandalone = Boolean(
    (window.navigator as Navigator & { standalone?: boolean }).standalone
  );
  return Boolean(mql || iosStandalone);
}

export function isIosSafari(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIos && isSafari;
}

/**
 * Registers the PWA Service Worker strictly in web/HTTPS/localhost mode
 * (never in Electron file:// builds).
 */
export function registerPwaServiceWorker(): void {
  if (!isWebPlatform()) return;
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const isSecureContextForSw =
    window.location.protocol === 'https:' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost';
  if (!isSecureContextForSw) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Non-fatal if browser blocks service workers (e.g. private browsing)
    });
  });
}

export class PwaInstallController {
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private state: PwaInstallState = 'hidden';
  private onChange?: (state: PwaInstallState) => void;

  private boundBeforeInstall = (event: Event) => {
    event.preventDefault();
    this.deferredPrompt = event as BeforeInstallPromptEvent;
    this.updateState();
  };

  private boundAppInstalled = () => {
    this.deferredPrompt = null;
    this.setState('hidden');
  };

  constructor(onChange?: (state: PwaInstallState) => void) {
    this.onChange = onChange;
  }

  public start(): void {
    if (!isWebPlatform() || typeof window === 'undefined') {
      this.setState('hidden');
      return;
    }
    this.updateState();
    window.addEventListener('beforeinstallprompt', this.boundBeforeInstall);
    window.addEventListener('appinstalled', this.boundAppInstalled);
  }

  public dispose(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('beforeinstallprompt', this.boundBeforeInstall);
    window.removeEventListener('appinstalled', this.boundAppInstalled);
    this.deferredPrompt = null;
  }

  public async triggerInstall(): Promise<'accepted' | 'dismissed' | 'ios-guide' | 'unavailable'> {
    if (this.deferredPrompt) {
      const promptEvent = this.deferredPrompt;
      this.deferredPrompt = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      this.updateState();
      return choice.outcome;
    }
    if (this.state === 'ios-guide') {
      return 'ios-guide';
    }
    return 'unavailable';
  }

  private updateState(): void {
    if (!isWebPlatform() || isRunningStandalone()) {
      this.setState('hidden');
      return;
    }
    if (this.deferredPrompt) {
      this.setState('prompt');
      return;
    }
    if (isIosSafari()) {
      this.setState('ios-guide');
      return;
    }
    this.setState('hidden');
  }

  private setState(next: PwaInstallState): void {
    if (this.state === next) return;
    this.state = next;
    this.onChange?.(next);
  }
}
