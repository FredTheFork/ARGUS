/**
 * speech.js — the voice of the assistant.
 *
 * A queued Web Speech synthesiser with an English (GB) butler register:
 * priority lane for urgent callouts, per-class cooldowns so it never
 * chatters, caption callbacks so everything spoken is also readable, and
 * an "interest" model that decides what is worth saying out loud.
 */

import { CLASS_META, LINES, articleFor, pick, plural, template, titleCase } from './config.js';

const CADENCE = {
  quiet:    { minGap: 5200, requirePriority: 3, lostCalls: false, proximity: false },
  standard: { minGap: 2100, requirePriority: 2, lostCalls: true,  proximity: true  },
  chatty:   { minGap: 900,  requirePriority: 1, lostCalls: true,  proximity: true  }
};

const VOICE_PREFERENCE = [
  /daniel/i, /google uk english male/i, /arthur/i, /oliver/i, /ryan/i, /george/i,
  /british/i, /uk english/i, /en-gb/i
];

export class Voice {
  constructor(getSettings, { onCaption = () => {}, onLog = () => {} } = {}) {
    this.getSettings = getSettings;
    this.onCaption = onCaption;
    this.onLog = onLog;
    this.queue = [];
    this.speaking = false;
    this.voices = [];
    this.voice = null;
    this._cooldown = new Map();     // class -> last spoken ts
    this._lastSpoke = 0;
    this._announced = new WeakSet();
    this._warned = false;
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (this.supported) this._bindVoices();
  }

  _bindVoices() {
    const refresh = () => {
      this.voices = window.speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
      this._select();
    };
    refresh();
    window.speechSynthesis.onvoiceschanged = refresh;
    setTimeout(refresh, 800);
  }

  _select() {
    const wanted = this.getSettings().voiceURI;
    if (wanted) {
      const match = this.voices.find((v) => v.voiceURI === wanted);
      if (match) { this.voice = match; return; }
    }
    for (const pattern of VOICE_PREFERENCE) {
      const match = this.voices.find((v) => pattern.test(v.name) || pattern.test(v.lang));
      if (match) { this.voice = match; return; }
    }
    this.voice = this.voices.find((v) => v.lang === 'en-GB') || this.voices[0] || null;
  }

  get voiceName() { return this.voice ? `${this.voice.name} (${this.voice.lang})` : 'system default'; }

  say(text, { priority = 1, interrupt = false, caption = true } = {}) {
    if (!text) return;
    if (caption) this.onCaption(text);
    const settings = this.getSettings();
    if (!this.supported || !settings.voiceEnabled) return;

    if (interrupt) {
      this.queue.length = 0;
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      this.speaking = false;
    } else if (this.queue.length > 2) {
      return;                                   // never let a backlog build up
    }
    this.queue.push({ text, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    this._drain();
  }

  _drain() {
    if (this.speaking || !this.queue.length) return;
    const job = this.queue.shift();
    const s = this.getSettings();
    const u = new SpeechSynthesisUtterance(job.text);
    if (this.voice) u.voice = this.voice;
    u.lang = (this.voice && this.voice.lang) || 'en-GB';
    u.rate = s.voiceRate;
    u.pitch = s.voicePitch;
    u.volume = s.voiceVolume;
    this.speaking = true;
    this._lastSpoke = performance.now();
    const finish = () => { this.speaking = false; setTimeout(() => this._drain(), 40); };
    u.onend = finish;
    u.onerror = (e) => {
      if (!this._warned && e && e.error && e.error !== 'interrupted') {
        this._warned = true;
        this.onLog(`warn: speech synthesis reported "${e.error}"`);
      }
      finish();
    };
    try { window.speechSynthesis.speak(u); } catch (err) { this.onLog(`warn: speech failed (${err.message})`); finish(); }
  }

  stop() {
    this.queue.length = 0;
    this.speaking = false;
    if (this.supported) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
  }

  greeting() {
    const h = new Date().getHours();
    const addr = titleCase(this.getSettings().address || 'sir');
    const pool = h < 12 ? LINES.greetingMorning : h < 18 ? LINES.greetingAfternoon : h < 23 ? LINES.greetingEvening : LINES.greetingNight;
    return template(pick(pool), { addr });
  }

  /* ---------------------------------------------------------------- *
   * Narration of the live scene.
   * ---------------------------------------------------------------- */
  narrate({ live, born, lost, locked }, t = performance.now()) {
    const s = this.getSettings();
    const cadence = CADENCE[s.cadence] || CADENCE.standard;
    const addr = s.address || 'sir';

    // 1. Aggregate call-outs for objects that just appeared.
    const fresh = born.filter((tr) => CLASS_META[tr.cls] && CLASS_META[tr.cls].priority >= cadence.requirePriority);
    const byClass = new Map();
    for (const tr of fresh) byClass.set(tr.cls, (byClass.get(tr.cls) || 0) + 1);
    const spokenClasses = new Set();
    for (const [cls, count] of byClass) {
      const meta = CLASS_META[cls];
      if (t - (this._cooldown.get(cls) || 0) < cadence.minGap) continue;
      if (t - this._lastSpoke < cadence.minGap * 0.6) continue;
      this._cooldown.set(cls, t);
      if (count > 1) {
        this.say(template(pick(LINES.foundMany), { count: String(count), plural: plural(cls, count), Count: titleCase(String(count)) }));
      } else {
        this.say(template(pick(LINES.foundOne), {
          name: cls, Name: titleCase(cls), article: articleFor(cls), Article: titleCase(articleFor(cls)), addr, Addr: titleCase(addr)
        }), { priority: meta.priority === 3 ? 2 : 1 });
      }
      spokenClasses.add(cls);
    }

    // 2. Quiet classes still deserve a line when nobody else is talking.
    if (!spokenClasses.size && s.cadence === 'chatty') {
      const notable = live.find((tr) => CLASS_META[tr.cls] &&
        !this._announced.has(tr) && tr.hits > 4 && CLASS_META[tr.cls].priority === 1 && t - this._lastSpoke > cadence.minGap);
      if (notable) {
        this._announced.add(notable);
        this.say(template(pick(LINES.foundOne), { name: notable.cls, Name: titleCase(notable.cls), article: articleFor(notable.cls), Article: titleCase(articleFor(notable.cls)), addr, Addr: titleCase(addr) }));
      }
    }

    // 3. Mark everything visible as announced so we don't re-call it.
    for (const tr of live) if (tr.hits >= 3) this._announced.add(tr);
    if (locked) this._announced.add(locked);

    // 4. Proximity: an object filling a quarter of the frame is worth a warning.
    if (cadence.proximity) {
      for (const tr of live) {
        const meta = CLASS_META[tr.cls];
        if (!meta || meta.priority < 3) continue;
        const area = tr.area || 0;
        if (area > 0.24 && !tr._proximityCalled && t - this._lastSpoke > cadence.minGap) {
          tr._proximityCalled = true;
          this.say(template(pick(LINES.proximityNear), { name: titleCase(tr.cls), Name: titleCase(tr.cls), addr, Addr: titleCase(addr) }), { priority: 2 });
        }
      }
    }

    // 5. Losses — only for things that had been announced earlier.
    if (cadence.lostCalls) {
      for (const tr of lost) {
        const meta = CLASS_META[tr.cls];
        if (!meta || meta.priority < cadence.requirePriority) continue;
        if (t - (this._cooldown.get(`lost:${tr.cls}`) || 0) < 9000) continue;
        this._cooldown.set(`lost:${tr.cls}`, t);
        this.say(template(pick(LINES.lost), { name: tr.cls, Name: titleCase(tr.cls) }), { priority: 1 });
      }
    }
  }

  announceTarget(track, { reacquire = false } = {}) {
    const name = titleCase(track.cls);
    const line = reacquire
      ? template(pick(LINES.reacquired), { Name: name })
      : template(pick(LINES.targetAcquired), { name: track.cls, Name: name });
    this.say(line, { priority: 3, interrupt: reacquire === false });
  }

  announceLoss(track) {
    this.say(template(pick(LINES.targetLost), { Name: titleCase(track.cls) }), { priority: 3, interrupt: true });
  }

  statusReport({ tracks, backend, inferMs, fps, scanLabel }) {
    const addr = titleCase(this.getSettings().address || 'sir');
    const counts = new Map();
    for (const tr of tracks || []) counts.set(tr.cls, (counts.get(tr.cls) || 0) + 1);
    if (!counts.size) {
      this.say(template(pick(LINES.nothing), { addr, Addr: addr }), { priority: 3, interrupt: true });
      return;
    }
    const parts = [...counts.entries()]
      .sort((a, b) => (CLASS_META[b[0]] ? CLASS_META[b[0]].priority : 0) - (CLASS_META[a[0]] ? CLASS_META[a[0]].priority : 0))
      .slice(0, 3)
      .map(([cls, n]) => (n > 1 ? `${n} ${plural(cls, n)}` : `${articleFor(cls)} ${cls}`));
    const head = counts.size === 1 ? 'One object category in view' : `${counts.size} categories in view`;
    this.say(`${head}: ${parts.join(', ')}. Inference ${Math.round(inferMs)} milliseconds per frame, ${Math.round(fps)} frames per second, running on ${backend}. Scan resolution ${scanLabel}.`, { priority: 3, interrupt: true });
  }
}

/* ------------------------------------------------------------------ *
 * voiceinput.js behaviour is small enough to live here: a wrapper around
 * SpeechRecognition that yields interim + final transcripts.
 * ------------------------------------------------------------------ */
export class VoiceInput {
  constructor({ onFinal = () => {}, onInterim = () => {}, onState = () => {} } = {}) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!Ctor;
    this.active = false;
    this._want = false;
    if (!this.supported) return;
    this.recognition = new Ctor();
    this.recognition.lang = 'en-GB';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = (res[0] && res[0].transcript || '').trim();
        if (!text) continue;
        if (res.isFinal) onFinal(text); else onInterim(text);
      }
    };
    this.recognition.onstart = () => { this.active = true; onState(true); };
    this.recognition.onend = () => {
      this.active = false;
      onState(false);
      if (this._want) setTimeout(() => { try { this.recognition.start(); } catch { /* ignore */ } }, 350);
    };
    this.recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this._want = false; onState(false, e.error); }
    };
  }

  start() {
    if (!this.supported || this.active) return this.supported;
    this._want = true;
    try { this.recognition.start(); } catch { /* already starting */ }
    return true;
  }

  stop() {
    if (!this.supported) return;
    this._want = false;
    try { this.recognition.stop(); } catch { /* ignore */ }
  }
}
