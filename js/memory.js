/**
 * memory.js — what ARGUS has seen, learned and been asked to watch.
 *
 * Three stores, all local:
 *
 *   taught    user-labelled examples (the TeachStore, persisted here)
 *   watchlist terms the user asked to be told about
 *   history   per-session and cumulative tallies of everything recognised
 *
 * History is what lets the assistant answer questions that are about the past
 * rather than the current frame — "how many times have you seen a van",
 * "what did I look at this morning", "have you seen my keys" — and it is the
 * substrate for the alarms: a watchlist entry fires on a novel appearance, not
 * on every frame the object remains visible.
 */

import { MEMORY_KEY } from './config.js';
import { TeachStore } from './classify.js';
import { lookup, categoryOf, tierOf } from './kb.js';

const MAX_TIMELINE = 400;
const MAX_HISTORY = 600;
const MAX_CENTROIDS = 250;

/**
 * Appearance centroids are stored as int8 with one float scale: 1280 floats per
 * object would blow a 5 MB localStorage quota after a few hundred sightings,
 * while 1280 bytes plus a scale keeps the whole memory under a megabyte and
 * still separates objects comfortably (cosine similarity is unaffected by
 * quantisation at this precision).
 */
function encodeEmbedding(vec) {
  if (!vec || !vec.length) return null;
  let scale = 0;
  for (const v of vec) scale = Math.max(scale, Math.abs(v));
  if (scale === 0) return null;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((vec[i] / scale) * 127)));
  let bin = '';
  const chunk = 4096;
  // btoa is Latin-1 only, so the signed bytes are folded to 0-255 on the way in
  // and unfolded on the way out.
  for (let i = 0; i < q.length; i += chunk) {
    const part = q.subarray(i, i + chunk);
    let s = '';
    for (let j = 0; j < part.length; j++) s += String.fromCharCode(part[j] & 0xff);
    bin += s;
  }
  return { s: scale, q: btoa(bin) };
}

function decodeEmbedding(enc) {
  if (!enc || !enc.q) return null;
  const bin = atob(enc.q);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    out[i] = ((b > 127 ? b - 256 : b) / 127) * enc.s;
  }
  return out;
}

export class Memory {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.teach = new TeachStore();
    this.watchlist = [];
    this.history = new Map();
    this.timeline = [];
    this.sessions = 0;
    this.totalObservations = 0;
    this.started = Date.now();
    this._lastSaved = 0;
    this._seenThisSession = new Map();
    this.hazards = [];
  }

  load() {
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      if (!raw) return this;
      const data = JSON.parse(raw);
      if (data.teach) this.teach = TeachStore.fromJSON(data.teach);
      this.watchlist = Array.isArray(data.watchlist) ? data.watchlist : [];
      this.history = new Map(Object.entries(data.history || {}));
      this.timeline = Array.isArray(data.timeline) ? data.timeline : [];
      this.sessions = data.sessions || 0;
      this.totalObservations = data.totalObservations || 0;
      this.hazards = Array.isArray(data.hazards) ? data.hazards : [];
      this.onLog(`memory restored — ${this.teach.examples.length} taught examples, ${this.history.size} known objects`);
    } catch (err) {
      this.onLog(`warn: memory restore failed (${err.message}) — starting fresh`);
    }
    return this;
  }

  save({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this._lastSaved < 4000) return;
    this._lastSaved = now;
    try {
      const payload = {
        version: 2,
        teach: this.teach.toJSON(),
        watchlist: this.watchlist,
        history: Object.fromEntries([...this.history].slice(-MAX_HISTORY)),
        timeline: this.timeline.slice(-MAX_TIMELINE),
        sessions: this.sessions,
        totalObservations: this.totalObservations,
        hazards: this.hazards.slice(-40)
      };
      localStorage.setItem(MEMORY_KEY, JSON.stringify(payload));
    } catch (err) {
      // Quota is the common failure here: drop thumbnails rather than the entry.
      try {
        const slim = { version: 2, teach: { version: 1, examples: this.teach.examples.map((e) => ({ ...e, thumb: null })) }, watchlist: this.watchlist, history: {}, timeline: [], sessions: this.sessions };
        localStorage.setItem(MEMORY_KEY, JSON.stringify(slim));
        this.onLog('note: memory trimmed to fit storage quota');
      } catch { this.onLog('warn: memory could not be persisted'); }
    }
  }

  beginSession() {
    this.sessions++;
    this.sessionStart = Date.now();
    this._seenThisSession = new Map();
    this.save({ force: true });
  }

  /**
   * Record one observation. Returns flags the agent uses to decide whether to
   * speak: NEW (never seen this label before), RETURNING (seen before today)
   * or routine.
   */
  observe(record, t = Date.now()) {
    const label = record.label || record.noun;
    if (!label) return { novel: false, returning: false };
    this.totalObservations++;
    const entry = this.history.get(label) || {
      label,
      category: record.category,
      tier: record.tier,
      count: 0,
      firstSeen: t,
      lastSeen: t,
      sessions: 0,
      colours: {},
      materials: {},
      centroid: null,
      centroidSamples: 0
    };
    entry.count++;
    entry.lastSeen = t;
    if (record.embeddingVec) {
      const vec = record.embeddingVec;
      if (!entry.centroid) {
        entry.centroid = encodeEmbedding(vec);
        entry.centroidSamples = 1;
      } else {
        const old = decodeEmbedding(entry.centroid);
        const n = entry.centroidSamples || 1;
        const blended = new Float32Array(vec.length);
        for (let i = 0; i < vec.length; i++) blended[i] = (old[i] * n + vec[i]) / (n + 1);
        entry.centroid = encodeEmbedding(blended);
        entry.centroidSamples = n + 1;
      }
    }
    entry.tier = Math.max(entry.tier || 1, record.tier || 1);
    if (record.attributes?.colour?.name) {
      const c = record.attributes.colour.name;
      entry.colours[c] = (entry.colours[c] || 0) + 1;
    }
    if (record.attributes?.material?.name) {
      const m = record.attributes.material.name;
      entry.materials[m] = (entry.materials[m] || 0) + 1;
    }
    const sessionKey = label;
    const sessionSeen = this._seenThisSession.get(sessionKey);
    const novel = entry.count === 1;
    if (!sessionSeen) {
      entry.sessions++;
      this._seenThisSession.set(sessionKey, { count: 0, t });
    }
    this._seenThisSession.get(sessionKey).count++;
    this.history.set(label, entry);

    if (novel && (record.tier || 1) >= 2) this.addTimeline({ kind: 'first-sight', text: `First sighting: ${label}`, label, t });
    if (record.hazard) {
      this.hazards.push({ label, kind: record.hazard.kind, note: record.hazard.note, t });
      this.addTimeline({ kind: 'hazard', text: `Hazard: ${label} — ${record.hazard.note || record.hazard.kind}`, label, t });
    }
    if (entry.centroid && this.history.size % 25 === 0) this._pruneCentroids();
    this.save();
    return { novel, returning: !novel && entry.sessions <= 1 };
  }

  addTimeline(event) {
    this.timeline.push({ t: Date.now(), ...event });
    if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE);
  }

  /* --- watchlist ---------------------------------------------------- */

  watch(term) {
    const key = String(term || '').trim().toLowerCase();
    if (!key) return null;
    const rec = lookup(key, { fuzzy: true });
    const entry = {
      id: `${Date.now().toString(36)}-${key.replace(/\W+/g, '').slice(0, 8)}`,
      term: key,
      label: rec?.name || key,
      category: rec?.category || categoryOf(key),
      created: Date.now(),
      hits: 0,
      lastHit: 0,
      fired: false
    };
    if (!this.watchlist.some((w) => w.term === key)) this.watchlist.push(entry);
    this.save({ force: true });
    return entry;
  }

  unwatch(term) {
    const key = String(term || '').trim().toLowerCase();
    const before = this.watchlist.length;
    this.watchlist = this.watchlist.filter((w) => w.term !== key && w.label !== key);
    this.save({ force: true });
    return before - this.watchlist.length;
  }

  /**
   * Match the current frame against the watchlist. A hit fires once per
   * appearance — the entry has to disappear for 10 s before it can fire again,
   * otherwise a mug on a desk would be announced every frame.
   */
  checkWatchlist(records, t = Date.now()) {
    const hits = [];
    for (const entry of this.watchlist) {
      const match = records.find((r) => {
        const label = (r.label || '').toLowerCase();
        const noun = (r.noun || '').toLowerCase();
        return label.includes(entry.term) || noun.includes(entry.term)
          || (entry.label && (label.includes(entry.label.toLowerCase()) || noun.includes(entry.label.toLowerCase())))
          || (r.category && r.category === entry.category);
      });
      if (match) {
        if (t - (entry.lastHit || 0) > 10000) {
          entry.hits++;
          entry.lastHit = t;
          hits.push({ entry, record: match });
        }
      }
    }
    if (hits.length) this.save();
    return hits;
  }

  /* --- taught examples ---------------------------------------------- */

  /**
   * Store a user-labelled example. Note the name: `this.teach` is the store
   * itself, so the verb lives here as `learn`.
   */
  learn(entry) {
    const added = this.teach.add(entry);
    if (added) {
      this.addTimeline({ kind: 'teach', text: `Learned: ${added.label}`, label: added.label });
      this.save({ force: true });
    }
    return added;
  }

  forget(label) {
    const removed = this.teach.forget(label);
    if (removed) {
      this.addTimeline({ kind: 'forget', text: `Forgot: ${label}`, label });
      this.save({ force: true });
    }
    return removed;
  }

  /* --- similarity ---------------------------------------------------- */

  /**
   * Which things I have seen before look like this?
   *
   * This is the difference between "the detector says phone" and "this is the
   * phone I logged nine times, last seen at 14:02" — it matches the object's
   * current appearance fingerprint against every remembered object, so the
   * assistant recognises its own history rather than only repeating labels.
   */
  findSimilar(embedding, { minScore = 0.74, limit = 3, exclude = null } = {}) {
    if (!embedding || !this.history.size) return [];
    let scale = 0;
    for (const v of embedding) scale = Math.max(scale, Math.abs(v));
    if (!scale) return [];
    const norm = Array.from(embedding, (v) => v / scale);
    const hits = [];
    for (const entry of this.history.values()) {
      if (!entry.centroid || entry.label === exclude) continue;
      const other = decodeEmbedding(entry.centroid);
      if (!other) continue;
      let dot = 0; let na = 0; let nb = 0;
      const step = Math.max(1, Math.floor(norm.length / 256));
      for (let i = 0; i < norm.length; i += step) {
        dot += norm[i] * other[i];
        na += norm[i] * norm[i];
        nb += other[i] * other[i];
      }
      const score = dot / Math.sqrt(Math.max(1e-6, na * nb));
      if (score >= minScore) hits.push({ label: entry.label, category: entry.category, count: entry.count, lastSeen: entry.lastSeen, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** Keep the centroid store bounded without losing frequently used entries. */
  _pruneCentroids() {
    const withCentroids = [...this.history.values()].filter((e) => e.centroid);
    if (withCentroids.length <= MAX_CENTROIDS) return;
    const stale = withCentroids
      .sort((a, b) => (a.lastSeen * 0.6 + a.count) - (b.lastSeen * 0.6 + b.count))
      .slice(0, withCentroids.length - MAX_CENTROIDS);
    for (const entry of stale) delete entry.centroid;
  }

  /* --- queries ------------------------------------------------------- */

  countOf(term) {
    const rec = lookup(term, { fuzzy: true });
    const names = new Set([String(term).toLowerCase(), (rec?.name || '').toLowerCase()]);
    for (const alias of rec?.aliases || []) names.add(alias.toLowerCase());
    let total = 0;
    let last = 0;
    for (const [label, entry] of this.history) {
      if (names.has(label.toLowerCase()) || [...names].some((n) => label.toLowerCase().includes(n))) {
        total += entry.count;
        last = Math.max(last, entry.lastSeen);
      }
    }
    return { total, last };
  }

  sessionCount() {
    return [...this._seenThisSession.values()].reduce((a, v) => a + v.count, 0);
  }

  topSeen(limit = 8) {
    return [...this.history.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  recent(limit = 12) {
    return [...this.history.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
  }

  summary() {
    const byCategory = {};
    for (const entry of this.history.values()) byCategory[entry.category || 'misc'] = (byCategory[entry.category || 'misc'] || 0) + 1;
    return {
      sessions: this.sessions,
      knownObjects: this.history.size,
      observations: this.totalObservations,
      taught: this.teach.examples.length,
      watching: this.watchlist.length,
      hazards: this.hazards.length,
      byCategory,
      top: this.topSeen(5)
    };
  }

  export() {
    return JSON.stringify({
      exported: new Date().toISOString(),
      version: 2,
      teach: this.teach.toJSON(),
      watchlist: this.watchlist,
      history: Object.fromEntries(this.history),
      timeline: this.timeline,
      sessions: this.sessions,
      totalObservations: this.totalObservations,
      hazards: this.hazards
    }, null, 2);
  }

  import(json) {
    const data = JSON.parse(json);
    if (data.teach) this.teach = TeachStore.fromJSON(data.teach);
    if (data.watchlist) this.watchlist = data.watchlist;
    if (data.history) this.history = new Map(Object.entries(data.history));
    if (data.timeline) this.timeline = data.timeline;
    this.sessions = data.sessions || this.sessions;
    this.totalObservations = data.totalObservations || this.totalObservations;
    this.hazards = data.hazards || [];
    this.save({ force: true });
    return { taught: this.teach.examples.length, known: this.history.size };
  }

  clear() {
    this.teach = new TeachStore();
    this.watchlist = [];
    this.history = new Map();
    this.timeline = [];
    this.hazards = [];
    this.totalObservations = 0;
    this.save({ force: true });
    return true;
  }
}

export { tierOf };
