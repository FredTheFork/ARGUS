/**
 * speech.js — output voice and input voice.
 *
 * Output uses the platform speech synthesiser, which costs nothing, works
 * offline and is already tuned per device. The interesting part is the queue:
 * a worn assistant that talks over itself is worse than one that says nothing,
 * so utterances are prioritised, coalesced and dropped when stale.
 *
 * Input uses the Web Speech API where available. Recognition runs continuously
 * only when the user asks for it; otherwise it arms on press and disarms itself,
 * because an always-open microphone is both a battery and a privacy cost.
 */

const SYNTH = typeof window !== 'undefined' ? window.speechSynthesis : null;

export class Voice {
  constructor(getSettings, { onCaption = () => {}, onLog = () => {}, onSpoken = () => {} } = {}) {
    this.getSettings = getSettings;
    this.onCaption = onCaption;
    this.onLog = onLog;
    this.onSpoken = onSpoken;
    this.voice = null;
    this.queue = [];
    this.speaking = false;
    this.muted = false;
    this.voices = [];
    this._loadVoices();
    if (SYNTH) SYNTH.addEventListener?.('voiceschanged', () => this._loadVoices());
  }

  _loadVoices() {
    if (!SYNTH) return;
    this.voices = SYNTH.getVoices() || [];
    if (!this.voices.length) return;
    const wanted = this.getSettings()?.voiceURI;
    this.voice = this.voices.find((v) => v.voiceURI === wanted)
      || this.voices.find((v) => /Google UK English Male|Daniel|Alex|Microsoft Ryan|Microsoft David|en-GB/i.test(`${v.name} ${v.lang}`))
      || this.voices.find((v) => v.lang?.startsWith('en'))
      || this.voices[0];
    this.onLog?.(`voice: ${this.voices.length} synthesis voices available`);
  }

  listVoices() {
    return this.voices.map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }));
  }

  get enabled() {
    const s = this.getSettings();
    return !!(s.voiceEnabled && !this.muted);
  }

  /**
   * @param {string} text
   * @param {object} opts { tone: 'info'|'alert'|'good', priority: 0..3, once: key }
   */
  say(text, { tone = 'info', priority = 1, once = null, cooldown = 0 } = {}) {
    if (!text) return false;
    this.onCaption(text, tone);
    this.onSpoken(text, tone);
    if (!this.enabled || !SYNTH) return false;
    const settings = this.getSettings();
    const key = once || text;

    this._lastSaid = this._lastSaid || new Map();
    const now = performance.now();
    const prev = this._lastSaid.get(key);
    if (cooldown > 0 && prev && now - prev < cooldown) return false;

    // Higher priority interrupts; lower priority waits, but never queues up
    // indefinitely.
    if (priority >= 3 && this.speaking) SYNTH.cancel();
    this._lastSaid.set(key, now);

    this.queue.push({ text, priority, tone });
    this.queue.sort((a, b) => b.priority - a.priority);
    if (this.queue.length > 4) this.queue = this.queue.slice(-4);
    this._pump(settings);
    return true;
  }

  _pump(settings) {
    if (this.speaking || !this.queue.length || !SYNTH) return;
    const item = this.queue.shift();
    const u = new SpeechSynthesisUtterance(item.text);
    if (this.voice) u.voice = this.voice;
    u.rate = Number(settings.voiceRate) || 1;
    u.pitch = Number(settings.voicePitch) || 0.92;
    u.volume = Number(settings.voiceVolume ?? 1);
    u.onstart = () => { this.speaking = true; };
    u.onend = () => { this.speaking = false; setTimeout(() => this._pump(this.getSettings()), 90); };
    u.onerror = (e) => {
      this.speaking = false;
      if (e?.error && e.error !== 'interrupted' && e.error !== 'canceled') this.onLog?.(`warn: speech failed (${e.error})`);
      setTimeout(() => this._pump(this.getSettings()), 120);
    };
    try {
      SYNTH.speak(u);
    } catch (err) {
      this.speaking = false;
      this.onLog?.(`warn: speech threw (${err.message})`);
    }
  }

  flush() {
    this.queue = [];
    if (SYNTH) SYNTH.cancel();
    this.speaking = false;
  }

  setMuted(flag) {
    this.muted = !!flag;
    if (this.muted) this.flush();
    return this.muted;
  }

  pronounce(text) {
    if (text == null) return '';
    return String(text).replace(/·/g, ',').replace(/\s+/g, ' ').trim();
  }
}

/* ------------------------------------------------------------------ *
 * Speech input
 * ------------------------------------------------------------------ */

export class VoiceInput {
  constructor({ onFinal = () => {}, onInterim = () => {}, onState = () => {}, onLog = () => {} } = {}) {
    this.onFinal = onFinal;
    this.onInterim = onInterim;
    this.onState = onState;
    this.onLog = onLog;
    this.recognition = null;
    this.listening = false;
    this.continuous = false;
    this._restart = false;
    this._build();
  }

  get supported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  _build() {
    if (!this.supported) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-GB';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim() || '';
        if (result.isFinal) this.onFinal(text);
        else interim += ` ${text}`;
      }
      if (interim) this.onInterim(interim.trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.onLog?.(`warn: voice input ${event.error}`);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this._restart = false;
        this.listening = false;
        this.onState('denied');
      }
    };
    rec.onend = () => {
      this.listening = false;
      this.onState('idle');
      if (this._restart && this.continuous) {
        setTimeout(() => this.start({ continuous: true }), 350);
      }
    };
    this.recognition = rec;
  }

  start({ continuous = false } = {}) {
    if (!this.recognition) {
      this.onLog?.('voice input unsupported on this browser');
      return false;
    }
    this.continuous = continuous;
    this._restart = true;
    try {
      this.recognition.start();
      this.listening = true;
      this.onState(continuous ? 'listening' : 'armed');
      return true;
    } catch {
      // Already started — harmless.
      return false;
    }
  }

  stop() {
    this._restart = false;
    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.listening = false;
    this.onState('idle');
  }

  toggle() {
    if (this.listening || this._restart) { this.stop(); return false; }
    return this.start({ continuous: false });
  }
}

export { SYNTH };
