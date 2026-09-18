/**
 * install.js — installation surface for ARGUS.
 *
 * A PWA is only installable under three conditions at once: a secure origin,
 * a manifest the browser accepts, and a service worker that can answer offline.
 * ARGUS has all three — this module is the part the operator interacts with, and
 * it deliberately handles the three real-world cases rather than pretending
 * there is one:
 *
 *   prompt-available  Chromium fired `beforeinstallprompt`, so the app can
 *                     install itself from a button, in place.
 *   manual            iOS/iPadOS (and browsers that never fire the event, or
 *                     desktops without the install UI). The operator has to use
 *                     the platform's own route — Safari's Share sheet on iOS,
 *                     the ⋮ menu on Android — so the guide has to be exact.
 *   installed         Already running from the home screen. Then the job is to
 *                     stop offering an install and say so.
 *
 * Nothing here is guessed from a user-agent string alone where a capability
 * check exists: `display-mode` and `navigator.standalone` decide "installed",
 * and the event decides "promptable".
 */

/** Longest-lived listener set in the app, so the HUD can re-render on change. */
export class Installer {
  constructor({ onState = () => {}, onLog = () => {} } = {}) {
    this.onState = onState;
    this.onLog = onLog;
    this.platform = Installer.platform();
    this._deferred = null;
    this._installed = Installer.isStandalone();

    window.addEventListener('beforeinstallprompt', (event) => {
      // Chrome only shows its own mini-infobar if we decline to handle it; the
      // in-app button is better placed and better worded, so take it over.
      event.preventDefault();
      this._deferred = event;
      this._emit('prompt-available');
    });

    window.addEventListener('appinstalled', () => {
      this._deferred = null;
      this._installed = true;
      this.onLog('install: ARGUS was added to the home screen', 'ok');
      this._emit('installed');
    });

    // A launch in a different display mode (e.g. the tab was resurrected from an
    // installed window) should re-sync the UI without a reload.
    try {
      const mq = window.matchMedia('(display-mode: standalone)');
      mq.addEventListener('change', () => {
        this._installed = Installer.isStandalone();
        this._emit('display-mode');
      });
    } catch { /* older engines: no matchMedia listener, the next boot re-syncs */ }
  }

  /* ---------------------------------------------------------------- state */

  get canPrompt() { return !!this._deferred && !this._installed; }
  get installed() { return this._installed; }

  /** 'installed' | 'prompt-available' | 'manual' */
  get mode() {
    if (this._installed) return 'installed';
    if (this.canPrompt) return 'prompt-available';
    return 'manual';
  }

  snapshot() {
    return {
      mode: this.mode,
      platform: this.platform,
      installed: this.installed,
      canPrompt: this.canPrompt,
      secure: Installer.isSecure(),
      ua: navigator.userAgent
    };
  }

  _emit(reason) {
    const snapshot = this.snapshot();
    this.onState(snapshot, reason);
    return snapshot;
  }

  /**
   * Re-read the display mode, push state to the UI, and hand the snapshot back
   * so callers act on exactly what was just rendered.
   */
  refresh(reason = 'refresh') {
    this._installed = Installer.isStandalone();
    return this._emit(reason);
  }

  /* --------------------------------------------------------------- action */

  /**
   * Run the browser's own install prompt. Resolves to the operator's answer so
   * callers can narrate it — 'accepted', 'dismissed' or 'unavailable'.
   */
  async promptInstall() {
    if (this._installed) { this.onLog('install: already running as an installed app'); return 'installed'; }
    const deferred = this._deferred;
    if (!deferred) {
      this.onLog('install: this browser offers no automatic prompt — using the manual route');
      return 'unavailable';
    }
    this._deferred = null;                     // a deferred prompt is single-use
    try {
      deferred.prompt();
      const choice = await deferred.userChoice;
      const outcome = (choice && choice.outcome) || 'dismissed';
      if (outcome === 'accepted') {
        this.onLog('install: accepted — confirming home-screen entry', 'ok');
        this._emit('accepted');
      } else {
        this.onLog('install: prompt dismissed — the manual route is in the field manual');
        this._emit('dismissed');
      }
      return outcome;
    } catch (err) {
      this.onLog(`install: prompt failed (${err && err.message})`);
      this._emit('failed');
      return 'unavailable';
    }
  }

  /* ------------------------------------------------------------ detection */

  /**
   * Running from the home screen rather than a browser tab.
   *
   * `view` exists so this can be tested with injected inputs: the browser gives
   * no way to emulate `display-mode`, so the alternatives are a false negative
   * in the suite or a testable seam here.
   */
  static isStandalone(view = {}) {
    const nav = view.navigator || (typeof navigator !== 'undefined' ? navigator : {});
    const mm = view.matchMedia || (typeof matchMedia !== 'undefined' ? matchMedia.bind(window) : null);
    try {
      if (nav.standalone === true) return true;                           // iOS home screen
      if (!mm) return false;
      return ['standalone', 'fullscreen', 'minimal-ui']
        .some((m) => mm(`(display-mode: ${m})`).matches);
    } catch {
      return false;
    }
  }

  static isSecure() {
    return typeof window !== 'undefined' && (window.isSecureContext || location.hostname === 'localhost');
  }

  static platform() {
    return Installer.platformFromUA(navigator.userAgent, navigator.maxTouchPoints || 0);
  }

  /**
   * Pure so it can be tested against real user-agent strings. iPadOS is the
   * subtle one: since iPadOS 13 Safari reports itself as an Intel Mac, and the
   * only reliable tell is that it has a touch screen.
   */
  static platformFromUA(ua = '', touchPoints = 0) {
    const s = String(ua);
    if (/iphone|ipod/i.test(s)) return 'ios';
    if (/ipad/i.test(s)) return 'ipados';
    if (/macintosh/i.test(s) && touchPoints > 1) return 'ipados';
    if (/android/i.test(s)) return (touchPoints > 1 ? 'android' : 'android-desktop');
    if (/windows|macintosh|linux|cros/i.test(s)) return 'desktop';
    return 'other';
  }
}

/**
 * Platform-exact instructions. These are the steps that actually work on each
 * platform — in particular that iOS only offers Add to Home Screen in Safari,
 * and that Chrome for Android needs the ⋮ menu when no automatic prompt appears.
 */
export function installGuide(platform) {
  switch (platform) {
    case 'ios':
    case 'ipados':
      return {
        app: 'Safari',
        headline: 'Install on iPhone / iPad',
        note: 'On iOS only Safari can install a web app. Chrome, Firefox and Edge on iOS cannot add to the home screen.',
        steps: [
          'Open this address in <b>Safari</b>.',
          'Tap the <b>Share</b> button — the square with an arrow, in the toolbar.',
          'Scroll the sheet and tap <b>Add to Home Screen</b>.',
          'Name it <b>ARGUS</b>, then tap <b>Add</b>.',
          'Launch ARGUS from the new home-screen icon: it opens full-screen, keeps the offline cache, and the camera permission is remembered.'
        ],
        after: 'iOS installs the offline cache on first launch — give it a few seconds on the boot screen once, then it works with no signal.'
      };
    case 'android':
      return {
        app: 'Chrome',
        headline: 'Install on Android',
        note: 'Chrome installs ARGUS as a real app — its own icon, no browser chrome, and a full offline cache.',
        steps: [
          'Open this address in <b>Chrome</b> (not an in-app browser).',
          'Tap <b>⋮</b> at the top right.',
          'Tap <b>Install app</b> — or <b>Add to Home screen</b> on older builds.',
          'Confirm <b>Install</b>. ARGUS appears in your app drawer and on the home screen.',
          'On the first launch, allow the camera when prompted.'
        ],
        after: 'If the ⋮ menu offers nothing, tap the <b>INSTALL TO PHONE</b> button on the ARGUS boot screen instead — Chrome raises its own prompt there.'
      };
    default:
      return {
        app: 'your phone',
        headline: 'Install on your phone',
        note: 'The app must be served over HTTPS for the phone to install it. Send yourself this address, then follow the steps for your handset.',
        steps: [
          'Open this address on the phone.',
          '<b>Android:</b> Chrome <b>⋮</b> → <b>Install app</b>.',
          '<b>iPhone / iPad:</b> <b>Safari</b> → <b>Share</b> → <b>Add to Home Screen</b>.',
          'Launch ARGUS from its new icon and allow the camera.'
        ],
        after: 'Everything runs on the handset after the first load — no account, no server, no frames leaving the device.'
      };
  }
}
