/**
 * agent.js — the part that talks.
 *
 * Two jobs:
 *
 *   1. UNDERSTANDING. Free text (typed or spoken) is parsed into an intent plus
 *      entities, resolved against the knowledge base and the current frame. It
 *      is a pattern grammar, not a language model: deterministic, instant,
 *      offline, and good enough for the hundred or so things a worn assistant
 *      actually gets asked ("what is this", "what colour is the mug", "where are
 *      my keys", "read that sign", "watch for dogs").
 *
 *   2. GENERATION + JUDGEMENT. Frame evidence is turned into speech with the
 *      right level of detail, and — more importantly — the agent decides when to
 *      speak unprompted. Silence is a feature: it announces novel objects,
 *      hazards, watchlist hits and approaching objects, and stays quiet about
 *      the mug that has been on the desk all afternoon.
 */

import { LINES, articleFor, bearingWord, formatDistance, pick, plural, template } from './config.js';
import { lookup, hasExact, nameFor, displayName, tierOf, categoryOf, searchObjects } from './kb.js';
import { appearancePhrase } from './attributes.js';

/* ------------------------------------------------------------------ *
 * Description
 * ------------------------------------------------------------------ */

const colourWord = (record) => record.attributes?.colour?.name || '';

function materialWord(record) {
  const m = record.attributes?.material;
  if (!m) return '';
  if (m.confidence < 0.32) return '';
  return m.name;
}

/** Full spoken description of one object, hedged according to confidence. */
export function describeRecord(record, settings = {}) {
  if (!record) return '';
  const parts = [];
  const noun = record.label || record.noun || 'object';
  parts.push(`${articleFor(noun)} ${noun}`.replace(/^an ([^aeiou])/i, 'a $1'));

  const colour = colourWord(record);
  const material = settings.narrateMaterials === false ? '' : materialWord(record);
  const finish = record.attributes?.finish && record.attributes.finish !== 'matte' ? record.attributes.finish : '';
  const pattern = record.attributes?.pattern && !['solid', 'textured'].includes(record.attributes.pattern.id) ? record.attributes.pattern.label : '';
  const descriptor = [finish, colour, pattern, material].filter(Boolean).join(' ');
  if (descriptor) parts.push(`in ${descriptor}`);

  if (settings.narrateBrands !== false && record.brand?.name && !String(noun).toLowerCase().includes(String(record.brand.name).toLowerCase())) {
    parts.push(`branded ${record.brand.name}`);
  }
  if (record.text && record.source !== 'brand') parts.push(`labelled "${record.text}"`);
  if (record.posture) parts.push(record.posture);
  if (record.activity && record.activity.id !== 'standing' && record.activity.id !== 'unknown') parts.push(record.activity.label);
  if (record.distance?.metres && settings.narrateDistance !== false) {
    parts.push(`about ${formatDistance(record.distance.metres, settings.units)} away`);
  }
  if (record.motion && record.motion.id !== 'stationary') parts.push(record.motion.label);
  if (record.hazard?.note) parts.push(record.hazard.note);

  return `${parts[0]}${parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''}.`;
}

/** Short form for the HUD chip. */
export function shortLabel(record) {
  if (!record) return '';
  const colour = colourWord(record);
  const bits = [colour, record.label || record.noun].filter(Boolean);
  return bits.join(' ');
}

/* ------------------------------------------------------------------ *
 * Grammar
 * ------------------------------------------------------------------ */

const INTENTS = [
  { id: 'colour', re: /\b(what )?colou?r( is| of|s)?\b/i, term: true },
  { id: 'material', re: /\b(what('| i)?s it made (of|from)|what material|material|composition|made of)\b/i, term: true },
  { id: 'where', re: /\b(where(\s|'|’)?(is|are|s|i)?\b|locate|position of|which way)/i, term: true },
  { id: 'distance', re: /\b(how far|distance|range|how close)\b/i, term: true },
  { id: 'read', re: /\b(read|what does it say|what('| i)?s written|text|sign says|translate)\b/i },
  { id: 'count', re: /\b(how many|count|tally)\b/i, term: true },
  { id: 'watch', re: /\b(watch (for|out for)|alert me (to|when)|tell me (if|when) you see|look out for|keep an eye out for)\b/i, term: true },
  { id: 'unwatch', re: /\b(stop watching|forget watching|stop (alerting|looking) (for|out for)|cancel watch)\b/i, term: true },
  { id: 'watchlist', re: /\b(what are you watching|watch list|watchlist|what are you looking out for)\b/i },
  { id: 'teach', re: /\b(teach (this|that|it)|learn (this|that|it)|call (this|that|it)|remember (this|that|it)|this is (a|an|my))\b/i, term: true },
  { id: 'forget', re: /\b(forget|unlearn|stop recognising|remove (the )?(learning|teach))\b/i, term: true },
  { id: 'learned', re: /\b(what have you (learned|taught)|list (learned|taught)|known objects)\b/i },
  { id: 'history', re: /\b(what (have you|did you) seen|history|log|timeline|earlier|so far)\b/i },
  { id: 'seen-before', re: /\b(have you seen|do you remember|seen before)\b/i, term: true },
  { id: 'hazard', re: /\b(hazard|dangerous|is it safe|safety|warning|risk)\b/i },
  { id: 'similar', re: /\b(what else looks like|anything similar|similar to|more like this|like this one|same kind|match this)\b/i },
  { id: 'on-surface', re: /\b(what('| i)?s|what is|anything)\s+on\s+(the|my|this)\b/i, term: true },
  { id: 'find-mode', re: /\b(find|look for|search for|hunt for|seek|help me find)\b/i, term: true },
  { id: 'lock', re: /\b(lock|track|follow|focus on|pin)\b/i, term: true },
  { id: 'unlock', re: /\b(unlock|release|drop (the )?(lock|target)|clear target|stop tracking)\b/i },
  { id: 'capture', re: /\b(capture|photo|snapshot|screenshot|take a picture)\b/i },
  { id: 'status', re: /\b(status|diagnostics|how are you|systems check|report in|health)\b/i },
  { id: 'scan', re: /\b(scan|sweep|full scan|search)\b/i },
  { id: 'paused', re: /\b(pause|hold|stop watching the room|freeze|standby)\b/i },
  { id: 'resume', re: /\b(resume|continue|carry on|wake up|go)\b/i },
  { id: 'mute', re: /\b(mute|silence|be quiet|quiet mode|shush)\b/i },
  { id: 'unmute', re: /\b(unmute|speak|talk to me|audio on)\b/i },
  { id: 'theme', re: /\b(theme|palette|colou?rscheme|interface)\b/i, term: true },
  { id: 'voice', re: /\b(voice commands|listen to me|wake word|microphone)\b/i },
  { id: 'detail', re: /\b(more detail|high detail|fine detail|zoom in|accurate mode|detail mode)\b/i },
  { id: 'fast', re: /\b(faster|speed up|performance mode|quick mode|save battery)\b/i },
  { id: 'modules', re: /\b(modules|models|what can you recognise|capabilities|vocabulary)\b/i },
  { id: 'help', re: /\b(help|what can you do|commands|how do i)\b/i },
  { id: 'brightness', re: /\b(how bright|lighting|too dark|is it dark|light level)\b/i },
  { id: 'people', re: /\b(who('| i)?s (that|there|this)|how many people|any people|anyone)\b/i },
  { id: 'weather', re: /\b(weather|raining|sunny)\b/i },
  { id: 'thanks', re: /\b(thanks|thank you|cheers|nice one)\b/i },
  { id: 'stop', re: /\b(stop|halt|cancel|abort|never mind)\b/i },

  // Broad intents are matched last on purpose: "what is it made of" must reach
  // the material handler before the generic "what is this" one.
  { id: 'identify-this', re: /\b(what('| i)?s (this|that|it)|what am i (looking at|seeing)|identify (this|that|it)|what is in front of me)\b/i },
  { id: 'describe-scene', re: /\b(describe|what('s| is) (around|in (view|front of me))|what do you see|scene report|full report|survey)\b/i }
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'my', 'your',
  'his', 'her', 'its', 'our', 'their', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'for', 'about',
  'what', 'whats', 'where', 'wheres', 'which', 'how', 'far', 'much', 'many', 'colour', 'color', 'colours', 'colors',
  'made', 'material', 'composition', 'tell', 'me', 'show', 'find', 'locate', 'search', 'please', 'argus', 'can',
  'could', 'would', 'will', 'shall', 'you', 'your', 'see', 'seeing', 'any', 'anything', 'something', 'there', 'do',
  'does', 'did', 'and', 'or', 'but', 'again', 'watch', 'watching', 'alert', 'when', 'if', 'look', 'looking', 'now',
  'am', 'i', 'im', 'we', 'us', 'thing', 'object', 'item', 'front', 'behind', 'left', 'right', 'near', 'close',
  'as', 'call', 'called', 'name', 'named', 'know', 'think', 'say', 'says', 'written', 'before', 'yet',
  'already', 'ever', 'this', 'that', 'one', 'kind', 'sort'
]);

/** Pull the subject out of an utterance: "what colour is the red mug" → "mug". */
export function extractTerm(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[?.!,]/g, ' ')
    .trim();
  const words = cleaned.split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  if (!words.length) return '';
  // Try the longest phrases first ("car keys" beats "keys"), then single words
  // scanning backwards, because in English the head noun comes last — "my car
  // keys" is about the keys, not the car.
  for (let len = Math.min(3, words.length); len >= 2; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      if (hasExact(phrase)) return phrase;
    }
  }
  for (let i = words.length - 1; i >= 0; i--) if (hasExact(words[i])) return words[i];
  const adjectives = new Set(['red', 'blue', 'green', 'black', 'white', 'silver', 'gold', 'pink', 'purple', 'orange', 'yellow', 'grey', 'gray', 'brown', 'metal', 'wooden', 'plastic', 'glass', 'large', 'small', 'big', 'tiny', 'new', 'old']);
  const meaningful = words.filter((w) => !adjectives.has(w));
  return (meaningful[meaningful.length - 1] || words[words.length - 1] || '').trim();
}

export function parse(text) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'none', term: '', raw };
  for (const intent of INTENTS) {
    const m = raw.match(intent.re);
    if (m) {
      const term = intent.term ? extractTerm(raw.replace(m[0], ' ')) : '';
      return { intent: intent.id, term, match: m[0], raw };
    }
  }
  // No pattern matched: if it names something, treat it as a lookup.
  const term = extractTerm(raw);
  if (term && lookup(term, { fuzzy: true })) return { intent: 'lookup', term, raw };
  return { intent: 'unknown', term, raw };
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

export function matchRecord(records, term) {
  if (!term) return null;
  const rec = lookup(term, { fuzzy: true });
  const names = new Set([term.toLowerCase()]);
  if (rec) { names.add(rec.name.toLowerCase()); for (const a of rec.aliases) names.add(a.toLowerCase()); }
  let best = null;
  for (const r of records) {
    const label = (r.label || '').toLowerCase();
    const noun = (r.noun || '').toLowerCase();
    let score = 0;
    for (const n of names) {
      if (!n) continue;
      if (label === n || noun === n) score = Math.max(score, 3);
      else if (label.includes(n) || noun.includes(n)) score = Math.max(score, 2);
      else if (n.includes(noun) && noun.length > 3) score = Math.max(score, 1.5);
    }
    if (r.category && rec && r.category === rec.category) score += 0.6;
    if (score > (best?.score || 0)) best = { record: r, score };
  }
  return best && best.score > 0.9 ? best.record : null;
}

/**
 * Produce a reply. `ctx` carries the live frame, settings, memory and the
 * pipeline handle so intents that change state can act on it.
 */
export function respond(utterance, ctx) {
  const { intent, term } = parse(utterance);
  const { records = [], memory, settings = {}, scene, lighting, texts = [], locked } = ctx;
  const addr = settings.address || 'sir';
  const seed = Date.now() / 1000 | 0;

  switch (intent) {
    case 'identify-this': {
      const target = locked?.record || biggestOfInterest(records);
      if (!target) return { say: pick(LINES.nothing, seed).replace('{addr}', addr) };
      return { say: describeRecord(target, settings), record: target, action: 'highlight', id: target.id };
    }
    case 'describe-scene': {
      if (!records.length) return { say: pick(LINES.nothing, seed).replace('{addr}', addr) };
      const sceneWord = scene?.label ? `This looks like ${articleFor(scene.label)} ${scene.label}` : 'Here is what I have';
      const top = [...records].sort((a, b) => (b.tier - a.tier) || (b.confidence - a.confidence)).slice(0, 4);
      const list = top.map((r) => {
        const d = r.distance?.metres ? ` at ${formatDistance(r.distance.metres, settings.units)}` : '';
        const pos = r.distance ? `, ${bearingWord(r.distance.bearing)}` : '';
        return `${shortLabel(r)}${d}${pos}`;
      });
      const extras = [];
      if (lighting) extras.push(`${lighting.key}, ${Math.round(lighting.brightness * 100)} percent brightness`);
      if (texts.length) extras.push(`text reading ${texts.slice(0, 2).map((t) => `"${t.text}"`).join(', ')}`);
      return {
        say: `${sceneWord}. I have ${plural('object', records.length).replace('objects', 'objects')}: ${list.join('; ')}.${extras.length ? ` ${extras.join('; ')}.` : ''}`,
        records: top, action: 'scene'
      };
    }
    case 'colour': {
      const target = term ? matchRecord(records, term) : (locked?.record || biggestOfInterest(records));
      if (!target) return { say: term ? `I cannot see ${articleFor(term)} ${term}, ${addr}.` : 'Nothing in view to sample.' };
      const colour = target.attributes?.colour;
      if (!colour) return { say: `Colour not read yet for the ${target.label}. Give me a moment.` };
      const palette = colour.palette.filter((p) => p.weight > 12).map((p) => p.name).slice(0, 3);
      const extra = palette.length > 1 ? ` with ${palette.slice(1).join(' and ')}` : '';
      return {
        say: `The ${target.label} is ${colour.name}${extra}.`,
        record: target, action: 'highlight', id: target.id,
        detail: { colour }
      };
    }
    case 'material': {
      const target = term ? matchRecord(records, term) : (locked?.record || biggestOfInterest(records));
      if (!target) return { say: `I cannot see ${articleFor(term || 'that')} ${term || 'anything'}.` };
      const mats = target.attributes?.materials || [];
      if (!mats.length) return { say: `No material read yet for the ${target.label}.` };
      const top = mats.slice(0, 3).map((m) => `${m.name} ${Math.round(m.score * 100)} percent`);
      return {
        say: `${target.label}: mostly ${mats[0].name}, at ${Math.round(mats[0].score * 100)} percent confidence.${mats[1] ? ` Possible ${mats[1].name}.` : ''}`,
        record: target, action: 'highlight', id: target.id, detail: { materials: top }
      };
    }
    case 'where': {
      const target = matchRecord(records, term) || (term ? null : biggestOfInterest(records));
      if (!target) {
        // If the user names something, never substitute a different object —
        // check the log instead and be honest about what is and is not in view.
        const memory = ctx.memory;
        const seen = term && memory ? memory.countOf(term) : null;
        if (seen?.total) {
          const when = new Date(seen.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return { say: `${articleFor(term)} ${term} is not in view, ${addr}. Last logged at ${when}, ${seen.total} ${plural('sighting', seen.total)} today.` };
        }
        return { say: `I do not have ${term ? articleFor(term) + ' ' + term : 'that'} in view, ${addr}.` };
      }
      const pos = target.distance ? bearingWord(target.distance.bearing) : 'in the frame';
      const dist = target.distance?.metres ? `, about ${formatDistance(target.distance.metres, settings.units)} away` : '';
      return { say: `The ${target.label} is ${pos}${dist}.`, record: target, action: 'highlight', id: target.id };
    }
    case 'distance': {
      const target = term ? matchRecord(records, term) : (locked?.record || biggestOfInterest(records));
      if (!target) return { say: 'Nothing to range.' };
      if (!target.distance?.metres) return { say: `I cannot estimate the range of the ${target.label} without a known size.`, record: target };
      const { metres, min, max, method } = target.distance;
      const hedge = method === 'pose height' ? '' : ' roughly';
      return {
        say: `The ${target.label} is${hedge} ${formatDistance(metres, settings.units)} away, ${bearingWord(target.distance.bearing)}. Between ${formatDistance(min, settings.units)} and ${formatDistance(max, settings.units)}.`,
        record: target, action: 'highlight', id: target.id
      };
    }
    case 'read': {
      if (!texts.length) return { say: 'No readable text in view.' };
      const joined = texts.slice(0, 4).map((t) => t.text).join('; ');
      const signs = texts.filter((t) => t.sign?.tier >= 3);
      const prefix = signs.length ? `That is ${articleFor(signs[0].sign.say)} ${signs[0].sign.say.toLowerCase()}. ` : '';
      return { say: `${prefix}Reading: ${joined}.`, action: 'texts', texts };
    }
    case 'count': {
      const target = term ? matchRecord(records, term) : null;
      const matches = target ? records.filter((r) => r.label === target.label || r.noun === target.noun) : records;
      const noun = target ? plural(target.label, matches.length) : 'objects';
      const mem = term && memory ? memory.countOf(term) : null;
      const extra = mem && mem.total ? ` I have logged ${mem.total} in total.` : '';
      return { say: `I can see ${matches.length} ${noun}.${extra}`, records: matches, action: 'count' };
    }
    case 'watch': {
      const watchTerm = term || (locked?.record?.label) || '';
      if (!watchTerm) return { say: 'What should I watch for?' };
      const entry = memory?.watch(watchTerm);
      return { say: entry ? `Watching for ${entry.label}.` : `I am already watching for that.`, action: 'watch', entry };
    }
    case 'unwatch': {
      const removed = memory?.unwatch(term) || 0;
      return { say: removed ? `No longer watching for ${term}.` : `I was not watching for ${term}.` };
    }
    case 'watchlist': {
      const list = memory?.watchlist || [];
      if (!list.length) return { say: 'I am not watching for anything specific.' };
      return { say: `Watching for: ${list.map((w) => w.label).join(', ')}.`, action: 'watchlist' };
    }
    case 'teach': {
      const target = locked?.record || biggestOfInterest(records);
      if (!target) return { say: 'Lock onto something first, then tell me what it is.' };
      const rawLabel = String(term || '').replace(/^(my|a|an|the)\s+/i, '').trim();
      if (!rawLabel) return { say: 'What should I call it?' , action: 'teach-prompt', id: target.id };
      return { say: `Learned: ${rawLabel}. I will recognise it from now on.`, action: 'teach', id: target.id, label: rawLabel };
    }
    case 'forget': {
      const removed = memory?.forget(term) || 0;
      return { say: removed ? `Forgotten: ${term}.` : `I have no learning stored under ${term}.` };
    }
    case 'learned': {
      const list = memory?.teach.labels() || [];
      if (!list.length) return { say: 'I have not been taught anything specific yet.' };
      return { say: `I have learned ${list.length} ${plural('object', list.length)}: ${list.map((l) => l.label).join(', ')}.`, action: 'learned' };
    }
    case 'history': {
      const recent = memory?.recent(6) || [];
      if (!recent.length) return { say: 'Nothing logged yet this session.' };
      return {
        say: `Recently: ${recent.map((r) => `${r.label}${r.count > 1 ? ` times ${r.count}` : ''}`).join(', ')}.`,
        action: 'history', entries: recent
      };
    }
    case 'seen-before': {
      if (term) {
        const mem = memory ? memory.countOf(term) : null;
        if (!mem || !mem.total) return { say: `I have not logged ${term} before.` };
        const when = new Date(mem.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return { say: `Yes — ${mem.total} ${plural('sighting', mem.total)} of ${term}, the last at ${when}.` };
      }
      // No name given: compare the object's appearance against everything logged.
      const target = locked?.record || biggestOfInterest(records);
      if (!target) return { say: 'Nothing in view to compare against memory.' };
      const hits = memory?.findSimilar(target.embeddingVec, { minScore: 0.7, limit: 2 }) || [];
      const exact = memory?.countOf(target.label);
      if (!hits.length) {
        if (exact?.total) return { say: `I have logged the ${target.label} ${exact.total} times, but nothing else looks like it.` };
        return { say: `This is the first ${target.label} I have logged.` };
      }
      const best = hits[0];
      const when = new Date(best.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return {
        say: `That looks like the ${best.label} I have seen ${best.count} times before — ${Math.round(best.score * 100)} percent match, last at ${when}.`,
        record: target, action: 'highlight', id: target.id
      };
    }
    case 'similar': {
      const target = locked?.record || biggestOfInterest(records);
      if (!target) return { say: 'Nothing in view to compare.' };
      const hits = memory?.findSimilar(target.embeddingVec, { minScore: 0.7, exclude: target.label }) || [];
      if (!hits.length) return { say: `I have nothing else on file that looks like the ${target.label}.` };
      const listed = hits.map((h) => `${h.label} (${Math.round(h.score * 100)} percent match, seen ${h.count} times)`).join('; ');
      return { say: `Closest matches to the ${target.label}: ${listed}.`, action: 'history', entries: hits };
    }
    case 'on-surface': {
      const surface = term ? matchRecord(records, term) : records.find((r) => r.supports?.length);
      if (!surface) {
        const named = records.filter((r) => r.on).map((r) => `${r.label} on the ${r.on}`);
        if (!named.length) return { say: 'I cannot tell what is resting on anything yet.' };
        return { say: `I can see ${named.join(', ')}.`, records: records.filter((r) => r.on) };
      }
      if (!surface.supports?.length) return { say: `Nothing is on the ${surface.label}.`, record: surface };
      return {
        say: `On the ${surface.label}: ${surface.supports.join(', ')}.`,
        record: surface, action: 'highlight', id: surface.id,
        records: records.filter((r) => r.on === surface.label)
      };
    }
    case 'find-mode': {
      if (!term) return { say: 'What should I look for?' };
      const present = matchRecord(records, term);
      if (present) {
        const where = present.distance ? `, ${bearingWord(present.distance.bearing)}${present.distance.metres ? `, about ${formatDistance(present.distance.metres, settings.units)}` : ''}` : '';
        return { say: `The ${present.label} is in view${where}.`, action: 'highlight', id: present.id };
      }
      return { say: `Looking for ${term}. I will guide you.`, action: 'find', term };
    }
    case 'hazard': {
      const hazards = records.filter((r) => r.hazard);
      if (!hazards.length) return { say: 'Nothing hazardous in view.', action: 'clear-hazard' };
      return {
        say: hazards.map((h) => `${h.label}: ${h.hazard.note || h.hazard.kind}`).join('. '),
        records: hazards, action: 'highlight', id: hazards[0].id, tone: 'alert'
      };
    }
    case 'lock': {
      const target = term ? matchRecord(records, term) : biggestOfInterest(records);
      if (!target) return { say: 'Nothing to lock onto.' };
      return { say: `Locked onto ${target.label}.`, action: 'lock', id: target.id };
    }
    case 'unlock': return { say: LINES.targetCleared[0], action: 'unlock' };
    case 'capture': return { say: 'Capture stored.', action: 'capture' };
    case 'status': return { action: 'status', say: null };
    case 'scan': return { say: 'Running a full sweep.', action: 'scan' };
    case 'paused': return { say: 'Standing by. Optics paused.', action: 'pause' };
    case 'resume': return { say: 'Optics engaged.', action: 'resume' };
    case 'mute': return { say: 'Audio muted.', action: 'mute' };
    case 'unmute': return { say: 'Audio restored.', action: 'unmute' };
    case 'theme': {
      const wanted = String(term || '').toLowerCase();
      return { say: `Switching palette${wanted ? ` to ${wanted}` : ''}.`, action: 'theme', theme: wanted };
    }
    case 'voice': return { say: 'Opening the voice command channel.', action: 'voice' };
    case 'detail': return { say: 'Detail mode on. Slower, but it sees small things.', action: 'detail' };
    case 'fast': return { say: 'Performance mode. Lower resolution, higher frame rate.', action: 'fast' };
    case 'modules': return { action: 'modules', say: null };
    case 'help': return { say: pick(LINES.help, seed), action: 'help' };
    case 'brightness': {
      if (!lighting) return { say: 'No light reading yet.' };
      return { say: `Light is ${lighting.key} at about ${lighting.kelvin} kelvin, ${Math.round(lighting.brightness * 100)} percent brightness. The brightest area is the ${lighting.direction}.` };
    }
    case 'people': {
      const people = records.filter((r) => r.category === 'person');
      if (!people.length) return { say: 'No people in view.' };
      const described = people.map((p) => `${p.activity?.label || p.posture || 'standing'}${p.distance?.metres ? ` at ${formatDistance(p.distance.metres, settings.units)}` : ''}`);
      return { say: `${people.length} ${plural('person', people.length)}: ${described.join(', ')}.`, records: people, action: 'highlight', id: people[0].id };
    }
    case 'weather': return { say: 'I have no weather feed — only optics. The sky is not in my vocabulary.', action: 'noop' };
    case 'thanks': return { say: `Any time, ${addr}.` };
    case 'stop': return { say: 'Standing by.', action: 'stop' };
    case 'lookup': {
      const target = matchRecord(records, term);
      if (!target) return { say: `I do not have ${articleFor(term)} ${term} in view.` };
      return { say: describeRecord(target, settings), record: target, action: 'highlight', id: target.id };
    }
    default:
      return { say: `I did not catch a command in that, ${addr}.`, action: 'unknown' };
  }
}

function biggestOfInterest(records) {
  if (!records.length) return null;
  // Interest = tier first (a bus beats a clipboard), then confidence, then size.
  const area = (r) => Math.max(1, (r.box[2] - r.box[0]) * (r.box[3] - r.box[1]));
  const maxArea = Math.max(...records.map(area));
  return [...records].sort((a, b) => {
    const score = (r) => (r.tier || 1) * 2 + (r.confidence || 0) + 0.6 * (area(r) / maxArea);
    return score(b) - score(a);
  })[0];
}

/* ------------------------------------------------------------------ *
 * Proactive narration
 * ------------------------------------------------------------------ */

export class Narrator {
  constructor({ onSay = () => {}, onLog = () => {} } = {}) {
    this.onSay = onSay;
    this.onLog = onLog;
    this.lastSpoke = 0;
    this.announced = new Map();       // label → timestamp, to stop repeats
    this.recentHazards = new Map();
    this.sceneAnnounced = null;
    this.lastFrame = null;
  }

  cadenceMs(settings) {
    switch (settings.narration) {
      case 'quiet': return 9000;
      case 'chatty': return 1200;
      default: return 3200;
    }
  }

  /**
   * Decide whether anything in this frame deserves speech. Returns an array of
   * utterances (usually 0 or 1) so the caller can queue them in order.
   */
  evaluate(frame, { settings, memory, paused = false } = {}) {
    const out = [];
    if (paused || !settings.voiceEnabled) return out;
    const t = Date.now();
    const gap = this.cadenceMs(settings);
    if (t - this.lastSpoke < gap) return out;
    const records = frame.records || [];

    // 1. Hazards and safety signage always win.
    if (settings.hazardAlerts !== false) {
      const hazard = records.find((r) => r.hazard && (t - (this.recentHazards.get(r.label) || 0) > 45000));
      if (hazard) {
        this.recentHazards.set(hazard.label, t);
        const note = hazard.hazard.note || hazard.note || `${hazard.label} in view.`;
        out.push({ text: `Caution: ${note}`, tone: 'alert', record: hazard });
        this.lastSpoke = t;
        return out;
      }
    }

    // 2. Watchlist hits.
    if (memory) {
      const hits = memory.checkWatchlist(records, t);
      if (hits.length) {
        const hit = hits[0];
        out.push({ text: `${hit.record.label} in view, ${settings.address || 'sir'}.`, tone: 'alert', record: hit.record });
        this.lastSpoke = t;
        return out;
      }
    }

    // 3. Approaching objects — the single most useful unprompted callout when
    //    you are walking.
    const closing = records
      .filter((r) => r.motion?.id === 'approaching' && r.tier >= 2 && r.confidence > 0.42)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (closing && t - (this.announced.get(`approaching:${closing.label}`) || 0) > 30000) {
      this.announced.set(`approaching:${closing.label}`, t);
      out.push({ text: `${closing.label} approaching${closing.distance?.metres ? `, ${formatDistance(closing.distance.metres, settings.units)}` : ''}.`, tone: 'alert', record: closing });
      this.lastSpoke = t;
      return out;
    }

    // 4. New objects of interest.
    const threshold = Number(settings.minTierToSpeak) || 3;
    const candidates = records.filter((r) => r.tier >= threshold && r.confidence >= 0.4 && r.age > 250);
    for (const rec of candidates) {
      const key = rec.label;
      const last = this.announced.get(key) || 0;
      const isNew = rec.age < 2500 || !last;
      if (!isNew || t - last < 25000) continue;
      this.announced.set(key, t);
      const text = describeRecord(rec, settings);
      out.push({ text, tone: rec.hazard ? 'alert' : 'info', record: rec });
      this.lastSpoke = t;
      return out;
    }

    // 5. Scene change — only in chatty mode, and only when the setting moves.
    if (settings.narration === 'chatty' && frame.scene && frame.scene.id !== this.sceneAnnounced) {
      this.sceneAnnounced = frame.scene.id;
      const count = records.length;
      if (count > 2) {
        out.push({ text: `${frame.scene.label}. ${count} objects in view.`, tone: 'info' });
        this.lastSpoke = t;
      }
    }
    return out;
  }

  statusLine({ records = [], scene, lighting, stats = {}, memory }) {
    const bits = [];
    bits.push(`${records.length} objects`);
    if (scene?.label) bits.push(scene.label);
    if (lighting) bits.push(`${Math.round(lighting.brightness * 100)} percent light`);
    if (stats.frameMs) bits.push(`${stats.frameMs} ms frame`);
    if (memory) bits.push(`${memory.teach.examples.length} taught`);
    return `${bits.join('. ')}.`;
  }

  forget(label) {
    this.announced.delete(label);
  }
  reset() {
    this.announced.clear();
    this.recentHazards.clear();
    this.sceneAnnounced = null;
  }
}

export { appearancePhrase, nameFor, displayName, tierOf, categoryOf, searchObjects };
