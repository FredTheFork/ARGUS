/**
 * install.js — installable-app plumbing.
 *
 * A camera app that cannot be pinned to the home screen is a web page. This
 * module handles beforeinstallprompt, the installed-app state, iOS Safari (which
 * has no install prompt at all and needs instructions instead), service-worker
 * updates, and storage accounting so the user can see that the models really are
 * on the device.
 */

export class Installer {
  constructor({ onState = () => {}, onLog = () => {} } = {}) {
    this.onState = onState;
    this.onLog = onLog;
    this.prompt = null;
    this.installed = false;
    this.display = this._displayMode();
    this.snapshot = { installed: false, canInstall: false, display: this.display, storage: null, updated: false };
    this._bind();
    this.refresh();
  }

  _displayMode() {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return 'standalone';
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return 'fullscreen';
    if (navigator.standalone) return 'ios-standalone';
    return 'browser';
  }

  _bind() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.promptEvent = event;
      this.snapshot.canInstall = true;
      this.onLog('install: available');
      this.refresh();
    });
    window.addEventListener('appinstalled', () => {
      this.installed = true;
      this.promptEvent = null;
      this.onLog('install: complete');
      this.refresh();
    });
    window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', () => this.refresh());
  }

  async refresh() {
    this.display = this._displayMode();
    this.installed = this.display === 'standalone' || this.display === 'fullscreen' || this.display === 'ios-standalone';
    let storage = null;
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        storage = { usage: est.usage, quota: est.quota };
      }
    } catch { /* not fatal */ }
    this.snapshot = {
      installed: this.installed,
      canInstall: !!this.promptEvent && !this.installed,
      display: this.display,
      storage,
      prompt: () => this.promptInstall()
    };
    this.onState(this.snapshot);
    return this.snapshot;
  }

  async promptInstall() {
    if (!this.promptEvent) {
      this.onLog('install: no prompt available — use the browser menu (Share → Add to Home Screen)');
      return false;
    }
    this.promptEvent.prompt();
    const choice = await this.promptEvent.userChoice;
    this.onLog(`install: user chose ${choice?.outcome || 'dismissed'}`);
    this.promptEvent = null;
    this.refresh();
    return choice?.outcome === 'accepted';
  }

  async unregister() {
    if (!navigator.serviceWorker) return false;
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
    this.onLog('service worker unregistered');
    return true;
  }

  async update() {
    if (!navigator.serviceWorker) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    await reg.update();
    this.onLog('checked for updates');
    return true;
  }
}

/** Steps for a human, per platform. Web install prompts are inconsistent. */
export function installGuide(platform = 'other') {
  const guides = {
    ios: {
      title: 'Install on iPhone / iPad',
      note: 'Safari has no install button — it is in the share sheet.',
      steps: [
        'Tap the Share button in Safari.',
        'Scroll and choose “Add to Home Screen”.',
        'Name it ARGUS and tap Add.',
        'Open ARGUS from the home screen so the camera can start in a secure context.',
        'Allow camera (and microphone, for voice commands) when asked.'
      ]
    },
    android: {
      title: 'Install on Android',
      note: 'Chrome installs it as a real app from the menu or a banner.',
      steps: [
        'Open the menu (⋮) in Chrome.',
        'Choose “Install app” or “Add to Home screen”.',
        'Confirm — ARGUS opens without browser chrome.',
        'Allow camera access when prompted.',
        'For the full frame rate, keep the tab in the foreground: background tabs throttle inference.'
      ]
    },
    desktop: {
      title: 'Install on desktop',
      note: 'Works in Chrome, Edge and Brave.',
      steps: [
        'Click the install icon in the address bar.',
        'Confirm the install.',
        'Allow camera access.',
        'WebGPU gives the best frame rate; otherwise WASM multi-threading is used automatically.'
      ]
    },
    other: {
      title: 'Install',
      note: 'Run it as an app for a full-screen, chrome-free view.',
      steps: [
        'Open the browser menu and choose “Install” or “Add to Home Screen”.',
        'Allow camera access.',
        'Models are cached on first run: after that ARGUS works offline.'
      ]
    }
  };
  const key = ['ios', 'android', 'desktop'].includes(platform) ? platform : detectPlatform();
  return guides[key];
}

export function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Windows|Linux|CrOS/.test(ua)) return 'desktop';
  return 'other';
}

export function isSecureContextOk() {
  return typeof window !== 'undefined' && (window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}
