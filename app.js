/* Dagelijks Nederlands — English → Dutch sentence trainer with spaced repetition.
   No build step, no server: sentences live in data/*.txt, progress lives in localStorage. */
(() => {
'use strict';

const LEVELS = ['A1', 'A2', 'B1', 'B2'];
const LEVEL_NAMES = { A1: 'Beginner', A2: 'Elementary', B1: 'Intermediate', B2: 'Upper-intermediate' };
const STORE_KEY = 'dagelijksNederlands.v1';
const DAY = 86400000;
const KNOWN_IVL = 21;          // days: interval at which a sentence counts as "known"
const ROLLOVER_H = 4;          // the "day" starts at 4am, so late-night sessions count for the evening
const IDLE_MS = 120000;        // timer pauses after 2 minutes without input

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- dates ---------------- */
function dayIndex(t = Date.now()) {
  const d = new Date(t - ROLLOVER_H * 3600000);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
const dayKey = (idx) => new Date(idx * DAY).toISOString().slice(0, 10);

/* ---------------- state ---------------- */
const DEFAULT_SETTINGS = {
  minutes: 30, newPerDay: 12, level: 'auto', requireSpeak: true,
  voiceURI: '', rate: 0.95, autoplay: true,
};
let st = load();
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* unavailable */ }
  if (!s || typeof s !== 'object' || !s.cards) s = { version: 1, created: Date.now(), cards: {}, days: {}, custom: {} };
  return normalize(s);
}
function normalize(s) {
  s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
  s.cards = s.cards || {}; s.days = s.days || {}; s.custom = s.custom || {};
  return s;
}
let saveFailed = false;
let localVersion = 0;
function save(fromSync = false) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); saveFailed = false; }
  catch (e) { if (!saveFailed) toast('Could not save progress in this browser — export a backup!'); saveFailed = true; }
  if (!fromSync) { localVersion++; if (window.DT && window.DT.onLocalSave) window.DT.onLocalSave(); }
}
function saveSettings() { st.settingsTs = Date.now(); save(); }

/* Merge two progress states (this device + cloud). Per sentence, the most recent review wins;
   daily stats take the larger value; custom accepted answers are combined. */
function mergeStates(a, b) {
  a = normalize(JSON.parse(JSON.stringify(a)));
  b = normalize(JSON.parse(JSON.stringify(b)));
  const ts = (c) => c.ts || (c.last || 0) * DAY;
  const out = a;
  for (const [id, rc] of Object.entries(b.cards)) {
    const lc = out.cards[id];
    if (!lc || ts(rc) > ts(lc)) out.cards[id] = rc;
  }
  for (const [k, rd] of Object.entries(b.days)) {
    const ld = out.days[k] || {};
    out.days[k] = {};
    for (const f of new Set([...Object.keys(ld), ...Object.keys(rd)])) out.days[k][f] = Math.max(ld[f] || 0, rd[f] || 0);
  }
  for (const [id, list] of Object.entries(b.custom)) out.custom[id] = [...new Set([...(out.custom[id] || []), ...list])];
  if ((b.settingsTs || 0) > (a.settingsTs || 0)) { out.settings = b.settings; out.settingsTs = b.settingsTs; }
  out.lastBackup = Math.max(a.lastBackup || 0, b.lastBackup || 0) || undefined;
  out.created = Math.min(a.created || Date.now(), b.created || Date.now());
  // a "reset all progress" on any device wins over older data from the other
  const resetAt = Math.max(a.resetAt || 0, b.resetAt || 0);
  if (resetAt) {
    out.resetAt = resetAt;
    for (const id in out.cards) if (ts(out.cards[id]) < resetAt) delete out.cards[id];
    const resetDay = dayKey(dayIndex(resetAt));
    for (const k in out.days) if (k < resetDay) delete out.days[k];
  }
  return out;
}
const S = () => st.settings;
function today() {
  const k = dayKey(dayIndex());
  return st.days[k] || (st.days[k] = { sec: 0, reviews: 0, newCount: 0, correct: 0 });
}

/* ---------------- sentence bank ---------------- */
let CARDS = [];
const BY_ID = new Map();
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function parseBank(level, text) {
  let topic = 'General';
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { topic = line.replace(/^#+\s*/, ''); continue; }
    const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [en, nl, ...alts] = parts;
    const id = level + '-' + hash(nl.toLowerCase());
    if (BY_ID.has(id)) continue;
    const card = { id, level, topic, en, nl, alts };
    out.push(card); BY_ID.set(id, card);
  }
  return out;
}
async function loadBanks() {
  const texts = await Promise.all(LEVELS.map((l) => fetch(`data/${l.toLowerCase()}.txt`).then((r) => {
    if (!r.ok) throw new Error(r.status); return r.text();
  })));
  LEVELS.forEach((l, i) => { CARDS.push(...parseBank(l, texts[i])); });
}

/* ---------------- scheduler (SM-2 variant) ---------------- */
function schedule(prev, r, now = dayIndex()) {
  const c = Object.assign({ ease: 2.5, ivl: 0, reps: 0, lapses: 0 }, prev || {});
  let ivl;
  if (r === 1) {
    if (c.reps > 0) c.lapses++;
    c.reps = 0; c.ease = Math.max(1.3, c.ease - 0.2); ivl = 0;
  } else {
    if (r === 2) {
      ivl = c.reps === 0 ? 1 : Math.max(c.ivl + 1, c.ivl * 1.2);
      c.ease = Math.max(1.3, c.ease - 0.15);
    } else if (r === 3) {
      ivl = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.max(c.ivl + 1, c.ivl * c.ease);
    } else {
      ivl = c.reps === 0 ? 4 : c.reps === 1 ? 7 : Math.max(c.ivl + 2, c.ivl * c.ease * 1.3);
      c.ease = Math.min(3.2, c.ease + 0.15);
    }
    c.reps++;
    ivl = Math.round(ivl);
  }
  c.ivl = ivl; c.due = now + ivl; c.last = now;
  return c;
}
function withFuzz(c) {
  if (c.ivl >= 4) {
    const f = Math.max(1, Math.round(c.ivl * 0.06));
    const d = Math.floor(Math.random() * (2 * f + 1)) - f;
    c.ivl += d; c.due += d;
  }
  return c;
}
function fmtIvl(d) {
  if (d <= 0) return 'now';
  if (d < 30) return d + 'd';
  if (d < 365) return (Math.round(d / 3)) / 10 + 'mo';
  return Math.round(d / 36.5) / 10 + 'y';
}

/* ---------------- grading ---------------- */
const UNITS = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien', 'elf', 'twaalf', 'dertien', 'veertien', 'vijftien', 'zestien', 'zeventien', 'achttien', 'negentien'];
const TENS = ['', '', 'twintig', 'dertig', 'veertig', 'vijftig', 'zestig', 'zeventig', 'tachtig', 'negentig'];
function numWord(n) {
  if (n < 20) return UNITS[n];
  if (n < 100) { const u = n % 10, t = TENS[Math.floor(n / 10)]; return u ? UNITS[u] + (u === 2 || u === 3 ? 'ën' : 'en') + t : t; }
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return (h > 1 ? UNITS[h] : '') + 'honderd' + (r ? numWord(r) : ''); }
  // years like 1953 are said "negentien(honderd)drieënvijftig"; we use the short form, the long one is listed as an alternative where it matters
  if (n >= 1100 && n < 2000 && n % 100) return numWord(Math.floor(n / 100)) + numWord(n % 100);
  if (n < 10000) { const t = Math.floor(n / 1000), r = n % 1000; return (t > 1 ? numWord(t) : '') + 'duizend' + (r ? numWord(r) : ''); }
  return String(n);
}
const CANON = { jij: 'je', jouw: 'je', wij: 'we', zij: 'ze', mij: 'me', "m'n": 'mijn', "z'n": 'zijn', "d'r": 'haar', "'t": 'het', "'n": 'een', ok: 'oke' };
function canon(raw) {
  let w = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'");
  w = w.replace(/[^a-z0-9']/g, '');
  w = w.replace(/^'+(?!(t|n|s)$)/, '').replace(/'+$/, '');
  if (/^\d+$/.test(w)) w = numWord(+w).normalize('NFD').replace(/[̀-ͯ]/g, '');
  return CANON[w] || w;
}
function tokens(s) {
  const out = [];
  for (const raw of s.replace(/[’‘`´]/g, "'").split(/[\s—–/]+/)) {
    const c = canon(raw);
    if (c) out.push({ raw: raw.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '') || raw, c });
  }
  return out;
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
/* Word-level diff: ops = eq | del (extra user word) | ins (missing ref word) | typo (near-miss) */
/* Join words the user (or speech recogniser) split apart, e.g. "goede middag" → "goedemiddag" */
function mergeSplits(user, ref) {
  const refSet = new Set(ref.map((t) => t.c));
  const out = [];
  for (let i = 0; i < user.length; i++) {
    let merged = false;
    if (!refSet.has(user[i].c)) {
      for (const span of [3, 2]) {
        if (i + span > user.length) continue;
        const parts = user.slice(i, i + span);
        const joined = parts.map((p) => p.c).join('');
        const near = joined.length >= 6 && ref.some((r) => r.c.length >= 6 && !refSet.has(parts[0].c) && lev(joined, r.c) <= 1 && !ref.some((q) => q.c === parts[parts.length - 1].c));
        if (refSet.has(joined) || near) { out.push({ raw: parts.map((p) => p.raw).join(' '), c: joined, split: true }); i += span - 1; merged = true; break; }
      }
    }
    if (!merged) out.push(user[i]);
  }
  return out;
}
function diff(user, ref, spoken = false) {
  user = mergeSplits(user, ref);
  const n = user.length, m = ref.length;
  const L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = user[i].c === ref[j].c ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (user[i].c === ref[j].c) { ops.push({ t: !spoken && user[i].split ? 'typo' : 'eq', u: user[i], r: ref[j] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ t: 'del', u: user[i++] }); }
    else ops.push({ t: 'ins', r: ref[j++] });
  }
  while (i < n) ops.push({ t: 'del', u: user[i++] });
  while (j < m) ops.push({ t: 'ins', r: ref[j++] });
  // pair up near-misses inside each run of non-equal ops
  const out = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].t === 'eq') { out.push(ops[k++]); continue; }
    const run = [];
    while (k < ops.length && ops[k].t !== 'eq') run.push(ops[k++]);
    const dels = run.filter((o) => o.t === 'del'), inss = run.filter((o) => o.t === 'ins');
    const used = new Set();
    const merged = [];
    for (const ins of inss) {
      let best = null;
      for (const d of dels) {
        if (used.has(d)) continue;
        const tol = ins.r.c.length >= 7 ? 2 : ins.r.c.length >= 4 ? 1 : 0;
        if (tol && lev(d.u.c, ins.r.c) <= tol) { best = d; break; }
      }
      if (best) { used.add(best); merged.push({ t: 'typo', u: best.u, r: ins.r, at: dels.indexOf(best) }); }
      else merged.push(ins);
    }
    // keep reading order: remaining dels, then typos/ins in ref order
    for (const d of dels) if (!used.has(d)) out.push(d);
    out.push(...merged.map((o) => { delete o.at; return o; }));
  }
  const eq = out.filter((o) => o.t === 'eq').length;
  const ty = out.filter((o) => o.t === 'typo').length;
  const score = (eq + 0.8 * ty) / Math.max(1, Math.max(n, m));
  return { ops: out, score, eq, ty, n, m };
}
function refsFor(card) { return [card.nl, ...card.alts, ...(st.custom[card.id] || [])]; }
function grade(card, answer) {
  const ut = tokens(answer);
  let best = null;
  for (const ref of refsFor(card)) {
    const d = diff(ut, tokens(ref));
    d.ref = ref;
    if (!best || d.score > best.score) best = d;
  }
  return best;
}
function renderOps(ops, mode) {
  return ops.map((o) => {
    if (o.t === 'eq') return `<span class="w eq">${esc(mode === 'pron' ? o.r.raw : o.u.raw)}</span>`;
    if (o.t === 'typo') return mode === 'pron'
      ? `<span class="w typo" title="heard “${esc(o.u.raw)}”">${esc(o.r.raw)}</span>`
      : `<span class="w typo" title="should be “${esc(o.r.raw)}”">${esc(o.u.raw)}</span>`;
    if (o.t === 'del') return mode === 'pron' ? '' : `<span class="w del">${esc(o.u.raw)}</span>`;
    return mode === 'pron'
      ? `<span class="w miss" title="not recognised">${esc(o.r.raw)}</span>`
      : `<span class="w ins" title="missing">${esc(o.r.raw)}</span>`;
  }).join(' ');
}

/* ---------------- speech: Dutch text-to-speech ---------------- */
let voices = [];
let voice = null;
function voiceScore(v) {
  const lang = v.lang.replace('_', '-').toLowerCase();
  let s = lang === 'nl-nl' ? 100 : 50;
  if (/natural|neural|online|premium|enhanced|google/i.test(v.name)) s += 20;
  if (/xander|claire|fenna|maarten|colette|ellen/i.test(v.name)) s += 5;
  if (v.localService === false) s += 2;
  return s;
}
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices()
    .filter((v) => v.lang && v.lang.replace('_', '-').toLowerCase().startsWith('nl'))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
  voice = voices.find((v) => v.voiceURI === S().voiceURI) || voices[0] || null;
  document.body.classList.toggle('no-tts', !voice);
  document.querySelectorAll('.tts-only').forEach((el) => el.classList.toggle('hidden', !voice));
  renderVoiceSettings();
  if (CARDS.length) refresh();
}
let speakingBtn = null;
function speak(text, slow = false, onEnd) {
  if (!voice) { onEnd && onEnd(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice; u.lang = voice.lang;
  u.rate = S().rate * (slow ? 0.72 : 1);
  const btn = slow ? $('playSlowBtn') : $('playBtn');
  u.onstart = () => { speakingBtn && speakingBtn.classList.remove('speaking'); btn.classList.add('speaking'); speakingBtn = btn; };
  u.onend = u.onerror = () => { btn.classList.remove('speaking'); onEnd && onEnd(); onEnd = null; };
  setTimeout(() => speechSynthesis.speak(u), 30); // Chrome drops utterances queued right after cancel()
}

/* ---------------- speech: recognition (pronunciation check) ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let srOk = !!SR;
let rec = null;
function stopRec() { if (rec) { try { rec.abort(); } catch (e) { /* ignore */ } rec = null; } setMic('idle'); }
function setMic(state) {
  const b = $('micBtn'), r = $('retryMicBtn');
  b.classList.toggle('rec', state === 'rec');
  b.classList.toggle('done', state === 'done');
  $('micLabel').textContent = state === 'rec' ? 'Listening… (tap to stop)' : state === 'done' ? 'Say it again' : 'Say it';
  r.textContent = state === 'rec' ? 'Listening…' : 'Listen, then say it again';
  r.classList.toggle('rec', state === 'rec');
}
function startRec(onDone) {
  if (!srOk) return;
  if (rec) { try { rec.stop(); } catch (e) { /* ignore */ } return; }
  speechSynthesis && speechSynthesis.cancel();
  const r = new SR();
  r.lang = 'nl-NL'; r.interimResults = true; r.maxAlternatives = 5; r.continuous = false;
  let finals = [];
  r.onresult = (e) => {
    finals = []; let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finals.push(Array.from(res).map((a) => a.transcript.trim()));
      else interim += res[0].transcript;
    }
    const live = finals.map((f) => f[0]).join(' ') + (interim ? ' ' + interim : '');
    $('heardLive').textContent = live ? '“' + live.trim() + '”' : '';
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      srOk = false; toast('Microphone blocked — allow it in your browser to get pronunciation feedback.');
      applySpeakMode();
    } else if (e.error === 'no-speech') toast('I didn’t hear anything — try again.');
    else if (e.error !== 'aborted') toast('Speech recognition error: ' + e.error);
  };
  r.onend = () => {
    if (rec !== r) return;
    rec = null;
    let heard = [];
    if (finals.length === 1) heard = finals[0];
    else if (finals.length > 1) heard = [finals.map((f) => f[0]).join(' ')];
    heard = heard.filter(Boolean);
    setMic(heard.length ? 'done' : 'idle');
    if (heard.length) onDone(heard);
  };
  rec = r;
  setMic('rec');
  try { r.start(); } catch (e) { rec = null; setMic('idle'); }
}

/* ---------------- session ---------------- */
let sess = null;   // { queue:[id], idx, reviewed, newSeen, again, correct, requeues:{}, practice:bool, goalShown }
let cur = null;    // { card, phase, heard:[], spoke, hints, dontKnow, result, suggested, isNew }
let lastActivity = Date.now();

function nextNewCards(n, exclude) {
  if (n <= 0) return [];
  const lvl = S().level;
  const pool = lvl === 'auto' ? CARDS : [...CARDS.filter((c) => c.level === lvl), ...CARDS.filter((c) => LEVELS.indexOf(c.level) > LEVELS.indexOf(lvl))];
  const out = [];
  for (const c of pool) {
    if (out.length >= n) break;
    if (!st.cards[c.id] && !exclude.has(c.id)) out.push(c.id);
  }
  return out;
}
function dueCards() {
  const t = dayIndex();
  return CARDS.filter((c) => st.cards[c.id] && st.cards[c.id].due <= t)
    .sort((a, b) => (st.cards[a.id].due - st.cards[b.id].due) || (st.cards[a.id].ivl - st.cards[b.id].ivl));
}
function interleave(reviews, news) {
  if (!news.length) return reviews;
  if (!reviews.length) return news;
  const out = []; const gap = Math.max(1, Math.floor(reviews.length / (news.length + 1)));
  let ni = 0;
  reviews.forEach((r, i) => { out.push(r); if ((i + 1) % Math.min(gap, 3) === 0 && ni < news.length) out.push(news[ni++]); });
  while (ni < news.length) out.push(news[ni++]);
  return out;
}
function newBudget(dueCount) {
  const left = Math.max(0, S().newPerDay - today().newCount);
  return dueCount > 150 ? Math.min(left, 2) : dueCount > 80 ? Math.min(left, Math.ceil(left / 2)) : left;
}
function startSession(opts = {}) {
  const due = dueCards().map((c) => c.id);
  let queue;
  if (opts.practice) {
    queue = CARDS.filter((c) => st.cards[c.id] && st.cards[c.id].ivl < KNOWN_IVL && st.cards[c.id].ivl > 0)
      .sort((a, b) => (st.cards[a.id].ease - st.cards[b.id].ease) || (st.cards[a.id].last - st.cards[b.id].last))
      .slice(0, 15).map((c) => c.id);
  } else {
    const n = opts.extraNew != null ? opts.extraNew : newBudget(due.length);
    queue = interleave(due, nextNewCards(n, new Set(due)));
  }
  if (!queue.length) {
    toast(opts.practice ? 'Nothing to practise yet.' : 'Nothing left — you’ve learned every sentence!');
    return;
  }
  const keepTime = sess && sess.goalShown;
  sess = { queue, idx: 0, reviewed: 0, newSeen: 0, again: 0, correct: 0, requeues: {}, practice: !!opts.practice, goalShown: keepTime || false };
  show('quiz');
  $('timer').classList.remove('hidden');
  showCard();
}
function show(view) {
  for (const v of ['home', 'quiz', 'summary']) $(v + 'View').classList.toggle('hidden', v !== view);
  if (view !== 'quiz') { stopRec(); 'speechSynthesis' in window && speechSynthesis.cancel(); }
  window.scrollTo(0, 0);
}
function showCard() {
  if (sess.idx >= sess.queue.length) {
    // ran out before the daily goal: keep going with anything due plus a few new sentences
    if (sess.practice || today().sec >= S().minutes * 60) return endSession();
    const extra = dueCards().map((c) => c.id);
    const news = nextNewCards(5, new Set(extra));
    if (!extra.length && !news.length) return endSession();
    sess.queue.push(...interleave(extra, news));
    toast(news.length ? 'Today’s cards are done — here are a few more new sentences.' : 'One more round of today’s tricky sentences.');
  }
  const card = BY_ID.get(sess.queue[sess.idx]);
  const isNew = !st.cards[card.id];
  cur = { card, phase: 'prompt', heard: [], spoke: false, hints: 0, dontKnow: false, isNew, warnedSpeak: false };
  stopRec();
  $('qCounter').textContent = `${sess.idx + 1} / ${sess.queue.length}` + (sess.practice ? ' · practice' : '');
  $('progressFill').style.width = (100 * sess.idx / sess.queue.length) + '%';
  $('qLevel').textContent = card.level;
  $('qTopic').textContent = card.topic;
  $('qNew').classList.toggle('hidden', !isNew);
  $('knowBtn').classList.toggle('hidden', !isNew);
  $('qEnglish').textContent = card.en;
  $('qHint').classList.add('hidden');
  $('answer').value = ''; autoGrow();
  $('heardLive').textContent = '';
  $('saidBox').checked = false;
  $('answerArea').classList.remove('hidden');
  $('feedback').classList.add('hidden');
  setMic('idle');
  applySpeakMode();
  setTimeout(() => $('answer').focus(), 30);
}
function applySpeakMode() {
  $('micBtn').classList.toggle('hidden', !srOk);
  $('saidCheck').classList.toggle('hidden', srOk || !S().requireSpeak);
  $('retryMicBtn').classList.toggle('hidden', !srOk);
}
function showHint() {
  if (!cur || cur.phase !== 'prompt') return;
  cur.hints = Math.min(2, cur.hints + 1);
  const words = cur.card.nl.split(/\s+/);
  const h = words.map((w) => {
    const letters = [...w];
    const keep = cur.hints === 1 ? 1 : Math.max(1, Math.ceil(letters.filter((ch) => /\p{L}/u.test(ch)).length / 2));
    let seen = 0;
    return letters.map((ch) => (/\p{L}/u.test(ch) ? (seen++ < keep ? ch : '_') : ch)).join('');
  }).join('  ');
  $('qHint').textContent = h;
  $('qHint').classList.remove('hidden');
  $('answer').focus();
}
function onMic() {
  if (!cur) return;
  startRec((heard) => {
    cur.heard = heard; cur.spoke = true;
    if (cur.phase === 'prompt') {
      if (!$('answer').value.trim()) { $('answer').value = heard[0]; autoGrow(); }
      $('answer').focus();
    } else renderPron();
  });
}
function check(dontKnow = false) {
  if (!cur || cur.phase !== 'prompt') return;
  const answer = $('answer').value.trim();
  if (!dontKnow && !answer) { toast('Type your translation first — or press “Show me”.'); $('answer').focus(); return; }
  const spoke = cur.spoke || (!srOk && $('saidBox').checked);
  if (!dontKnow && S().requireSpeak && !spoke && !cur.warnedSpeak) {
    cur.warnedSpeak = true;
    toast(srOk ? 'Say it out loud first (tap “Say it”). Press Check again to skip.' : 'Say it out loud and tick the box. Press Check again to skip.');
    return;
  }
  if (rec) stopRec();
  cur.dontKnow = dontKnow;
  cur.answer = answer;
  cur.phase = 'revealed';
  cur.result = answer ? grade(cur.card, answer) : null;
  reveal();
}
function reveal() {
  const { card, result } = cur;
  $('answerArea').classList.add('hidden');
  $('feedback').classList.remove('hidden');
  const target = result ? result.ref : card.nl;
  cur.target = target;
  $('target').textContent = target;
  const others = refsFor(card).filter((r) => r !== target);
  $('alts').innerHTML = others.length ? 'Also accepted: ' + others.map((o) => '<span lang="nl">' + esc(o) + '</span>').join(' · ') : '';
  $('alts').classList.toggle('hidden', !others.length);

  let v, cls, sug;
  if (cur.dontKnow || !result) { v = 'Here’s how to say it'; cls = 'shown'; sug = 1; }
  else if (result.score >= 0.999) { v = '✓ Correct'; cls = 'ok'; sug = cur.hints ? 2 : 3; }
  else if (result.score >= 0.84 || (result.ty && result.eq + result.ty === Math.max(result.n, result.m))) {
    v = 'Almost'; cls = 'close'; sug = 2;
  } else { v = 'Not quite'; cls = 'bad'; sug = 1; }
  const pct = result && !cur.dontKnow ? ` <small>${Math.round(result.score * 100)}% match</small>` : '';
  $('verdict').className = 'verdict ' + cls;
  $('verdict').innerHTML = esc(v) + pct;
  cur.suggested = sug;

  $('yourBlock').classList.toggle('hidden', !result || cur.dontKnow);
  if (result) $('yourDiff').innerHTML = renderOps(result.ops, 'answer');
  $('overrideBtn').classList.toggle('hidden', !result || cur.dontKnow || result.score >= 0.999);
  renderPron();
  renderRates();
  if (S().autoplay && voice) speak(target);
}
function renderPron() {
  const has = cur.heard && cur.heard.length;
  $('pronBlock').classList.toggle('hidden', !srOk && !has);
  if (!has) {
    $('pronDiff').innerHTML = '';
    $('pronScore').textContent = '';
    $('pronNote').textContent = srOk ? 'Say the Dutch sentence to check how clearly it comes across.' : '';
    return;
  }
  // compare against every accepted version: you may have said a different correct variant than you typed
  let best = null;
  for (const ref of [cur.target, ...refsFor(cur.card).filter((r) => r !== cur.target)]) {
    const tt = tokens(ref);
    for (const h of cur.heard) {
      const d = diff(tokens(h), tt, true); d.heard = h; d.tt = tt;
      if (!best || d.score > best.score + 1e-9) best = d;
    }
  }
  const tt = best.tt;
  $('pronDiff').innerHTML = renderOps(best.ops, 'pron') + `<br><span class="muted small">Heard: “${esc(best.heard)}”</span>`;
  const p = Math.round(100 * best.ops.filter((o) => o.t === 'eq').length / Math.max(1, tt.length));
  $('pronScore').textContent = `· ${p}% of words recognised`;
  $('pronNote').textContent = p >= 100 ? 'Every word came across clearly. Mooi!'
    : p >= 70 ? 'Mostly clear. Underlined words didn’t come across — listen to them and try again.'
    : 'Listen to the Dutch a couple of times, then say it again.';
}
function renderRates() {
  const prev = cur.card && st.cards[cur.card.id];
  for (let r = 1; r <= 4; r++) {
    const btn = document.querySelector(`.rate[data-r="${r}"]`);
    btn.classList.toggle('suggested', r === cur.suggested);
    let label;
    if (sess.practice) label = r === 1 ? 'tomorrow' : 'no change';
    else label = r === 1 ? 'repeat' : fmtIvl(schedule(prev, r).ivl);
    $('iv' + r).textContent = label;
  }
}
function override() {
  if (!cur || cur.phase !== 'revealed' || !cur.answer) return;
  const list = st.custom[cur.card.id] || (st.custom[cur.card.id] = []);
  if (!list.includes(cur.answer)) list.push(cur.answer);
  save();
  cur.result = grade(cur.card, cur.answer);
  reveal();
  $('verdict').innerHTML = '✓ Accepted <small>— saved as an alternative for next time</small>';
  $('verdict').className = 'verdict ok';
  cur.suggested = cur.hints ? 2 : 3; renderRates();
}
function rate(r) {
  if (!cur || cur.phase !== 'revealed' || !sess) return;
  cur.phase = 'rated';
  const id = cur.card.id;
  const d = today();
  const prev = st.cards[id];
  if (sess.practice) {
    if (r === 1 && prev) { prev.due = Math.min(prev.due, dayIndex() + 1); prev.ease = Math.max(1.3, prev.ease - 0.1); prev.ts = Date.now(); }
  } else {
    st.cards[id] = withFuzz(schedule(prev, r));
    st.cards[id].ts = Date.now();
    if (!prev) { d.newCount++; sess.newSeen++; }
  }
  d.reviews++; sess.reviewed++;
  if (r > 1) { d.correct++; sess.correct++; } else sess.again++;
  // in-session repetition: failures come back after a few cards; brand-new "hard" ones once more
  const reps = sess.requeues[id] || 0;
  if ((r === 1 || (r === 2 && !prev)) && reps < 4) {
    const pos = Math.min(sess.queue.length, sess.idx + 1 + (r === 1 ? 3 : 6));
    sess.queue.splice(pos, 0, id);
    sess.requeues[id] = reps + 1;
  }
  save();
  sess.idx++;
  showCard();
}
function knowIt() {
  if (!cur || !cur.isNew) return;
  const t = dayIndex();
  st.cards[cur.card.id] = { ease: 2.7, ivl: 45, reps: 3, lapses: 0, due: t + 45, last: t, skipped: true, ts: Date.now() };
  const repl = nextNewCards(1, new Set(sess.queue));
  if (repl.length) sess.queue.splice(sess.idx + 1, 0, repl[0]);
  save();
  toast('Marked as known — you’ll see it again in about 6 weeks.');
  sess.idx++;
  showCard();
}
function endSession() {
  stopRec();
  cur = null;
  if (!sess) return show('home');
  const d = today();
  const mins = Math.floor(d.sec / 60);
  const goal = S().minutes;
  $('sumTitle').textContent = mins >= goal ? 'Goed gedaan! 🎉' : sess.idx >= sess.queue.length ? 'Klaar!' : 'Tot straks!';
  const due = dueCards().length;
  const moreNew = nextNewCards(1, new Set()).length > 0;
  $('sumText').textContent = mins >= goal
    ? `You've done your ${goal} minutes for today. Same time tomorrow?`
    : (sess.idx >= sess.queue.length ? `All of today's cards are done, but you're at ${mins} of ${goal} minutes. Keep going with some extra sentences?` : `You're at ${mins} of ${goal} minutes today.`);
  $('sumStats').innerHTML = [
    [sess.reviewed, 'answers'], [sess.newSeen, 'new sentences'],
    [sess.reviewed ? Math.round(100 * sess.correct / sess.reviewed) + '%' : '–', 'recalled'], [mins + 'm', 'today'],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  const stack = document.querySelector('#summaryView .stack');
  stack.innerHTML = '';
  const add = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; stack.appendChild(b); };
  if (due) add(`Continue reviews (${due} due)`, 'primary', () => startSession());
  else if (moreNew) add('Learn 5 more new sentences', mins < goal ? 'primary' : '', () => startSession({ extraNew: 5 }));
  add('Practise weak sentences', due || mins >= goal ? 'ghost' : '', () => startSession({ practice: true }));
  add('Back to overview', 'ghost', goHome);
  sess.idx = sess.queue.length;
  show('summary');
}
function goHome() { stopRec(); show('home'); $('timer').classList.add('hidden'); renderHome(); }

/* ---------------- timer ---------------- */
function tick() {
  const quizOn = !$('quizView').classList.contains('hidden');
  if (quizOn && !document.hidden && Date.now() - lastActivity < IDLE_MS) {
    const d = today(); d.sec++;
    if (d.sec % 15 === 0) save();
    if (sess && !sess.goalShown && d.sec >= S().minutes * 60) {
      sess.goalShown = true; save();
      toast(`🎉 ${S().minutes} minutes done for today! Finish up or keep going.`, 5000);
    }
  }
  const left = S().minutes * 60 - today().sec;
  const el = $('timer');
  if (left > 0) { el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; el.classList.remove('done'); el.title = 'Time left today'; }
  else { el.textContent = '✓ ' + Math.floor(today().sec / 60) + 'm'; el.classList.add('done'); el.title = 'Daily goal reached'; }
  el.style.opacity = quizOn && Date.now() - lastActivity >= IDLE_MS ? '.5' : '';
}

/* ---------------- home ---------------- */
function streak() {
  let t = dayIndex(), n = 0;
  const active = (i) => { const d = st.days[dayKey(i)]; return d && (d.reviews > 0 || d.sec >= 60); };
  if (!active(t)) t--;
  while (active(t)) { n++; t--; }
  return n;
}
function renderHome() {
  $('loading').classList.add('hidden');
  $('homeContent').classList.remove('hidden');
  const d = today(), t = dayIndex();
  const mins = Math.floor(d.sec / 60), goal = S().minutes;
  const due = dueCards().length;
  const newToday = Math.min(newBudget(due), nextNewCards(999, new Set()).length);
  let known = 0;
  for (const id in st.cards) if (st.cards[id].ivl >= KNOWN_IVL) known++;
  const dt = new Date();
  $('todayLabel').textContent = dt.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  const fresh = !Object.keys(st.cards).length;
  $('heroTitle').textContent = fresh ? 'Welkom! Laten we beginnen.' : mins >= goal ? 'Goed gedaan vandaag!' : mins > 0 ? 'Even doorgaan?' : 'Klaar voor vandaag?';
  $('heroSub').textContent = fresh
    ? 'You’ll see an English sentence. Write it in Dutch, say it out loud, then check. Guess freely — you’ll pick up the patterns from the corrections.'
    : mins >= goal ? 'Daily goal reached. Extra practice is always welcome.' : !(due + newToday) ? `All caught up for today. You can learn extra sentences to fill your ${goal} minutes.` : `${due} review${due === 1 ? '' : 's'} and ${newToday} new sentence${newToday === 1 ? '' : 's'} waiting.`;
  const C = 2 * Math.PI * 19;
  $('ringFg').style.strokeDasharray = C;
  $('ringFg').style.strokeDashoffset = C * (1 - Math.min(1, d.sec / (goal * 60)));
  $('ringFg').style.opacity = d.sec >= 30 ? 1 : 0;
  $('ringMin').textContent = mins;
  $('ringGoal').textContent = `/${goal} min`;
  $('statDue').textContent = due;
  $('statNew').textContent = newToday;
  $('statStreak').textContent = streak();
  $('statKnown').textContent = known;
  $('startHint').textContent = voice ? '' : 'No Dutch voice was found in this browser, so audio is off — see Settings for how to add one.';
  $('startBtn').textContent = fresh ? 'Start your first session' : due + newToday ? (mins > 0 ? 'Continue today’s session' : 'Start today’s session') : 'Learn extra sentences';

  // levels
  let html = '<div class="legend"><span><i style="background:var(--ok)"></i>known</span><span><i style="background:var(--accent);opacity:.55"></i>learning</span></div>';
  for (const L of LEVELS) {
    const cs = CARDS.filter((c) => c.level === L);
    let k = 0, l = 0;
    for (const c of cs) { const s = st.cards[c.id]; if (!s) continue; if (s.ivl >= KNOWN_IVL) k++; else l++; }
    const tot = cs.length || 1;
    html += `<div class="level"><div class="level-head"><span><b>${L}</b><span class="lvl-name">${LEVEL_NAMES[L]}</span></span><span class="muted">${k} known · ${l} learning · ${cs.length} total</span></div>
      <div class="bar"><div class="k" style="width:${100 * k / tot}%"></div><div class="l" style="width:${100 * l / tot}%"></div></div></div>`;
  }
  $('levels').innerHTML = html;

  // forecast
  const fc = Array(7).fill(0);
  for (const id in st.cards) { const dd = Math.max(0, st.cards[id].due - t); if (dd < 7) fc[dd]++; }
  const max = Math.max(1, ...fc);
  $('forecast').innerHTML = fc.map((n, i) => {
    const lab = i === 0 ? 'today' : new Date((t + i) * DAY).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    return `<div class="fc-col"><b>${n || ''}</b><div class="fc-bar" style="height:${70 * n / max}%"></div><small>${lab}</small></div>`;
  }).join('');

  // heatmap: 12 weeks, Monday-first columns
  const dow = (new Date(t * DAY).getUTCDay() + 6) % 7;
  const start = t - dow - 7 * 11;
  let hm = '', total = 0;
  for (const k in st.days) total += st.days[k].sec || 0;
  for (let i = start; i <= t; i++) {
    const m = ((st.days[dayKey(i)] || {}).sec || 0) / 60;
    const c = m <= 0.5 ? '' : m < 10 ? 'h1' : m < goal * 0.85 ? 'h2' : 'h3';
    hm += `<i class="${c}${i === t ? ' today' : ''}" title="${dayKey(i)}: ${Math.round(m)} min"></i>`;
  }
  $('heatmap').innerHTML = hm;
  $('totalTime').textContent = `Total practice: ${Math.floor(total / 3600)}h ${Math.floor(total % 3600 / 60)}m · ${Object.keys(st.cards).length} of ${CARDS.length} sentences started`;

  // backup reminder
  const nCards = Object.keys(st.cards).length;
  const since = st.lastBackup ? Math.floor((Date.now() - st.lastBackup) / DAY) : null;
  const nag = $('backupNag');
  if (nCards >= 40 && (since === null || since >= 14)) {
    nag.innerHTML = `<span>💾 ${since === null ? 'You haven’t exported a backup yet.' : `Last backup was ${since} days ago.`} Your progress lives only in this browser.</span>`;
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Export backup'; b.onclick = exportBackup; nag.appendChild(b);
  } else nag.innerHTML = '';
}

/* ---------------- settings & backup ---------------- */
function renderVoiceSettings() {
  const sel = $('setVoice');
  sel.innerHTML = voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  if (voice) sel.value = voice.voiceURI;
  $('voiceBox').classList.toggle('hidden', !voice);
  $('voiceMissing').textContent = voice ? ''
    : 'No Dutch voice was found in this browser, so audio is switched off. Chrome and Edge include good Dutch voices (“Google Nederlands”, “Microsoft Fenna/Maarten Online”). On a Mac or iPhone, add one under System Settings → Accessibility → Spoken Content → System voice → Manage voices → Dutch, then reload.';
}
function openSettings() {
  $('setMinutes').value = S().minutes;
  $('setNew').value = S().newPerDay;
  $('setLevel').value = S().level;
  $('setSpeak').checked = S().requireSpeak;
  $('setRate').value = S().rate; $('rateVal').textContent = S().rate.toFixed(2) + '×';
  $('setAutoplay').checked = S().autoplay;
  $('srStatus').textContent = SR
    ? (srOk ? 'Pronunciation check: on (uses your browser’s Dutch speech recognition).' : 'Pronunciation check: microphone access was blocked. Allow it in the site settings and reload.')
    : 'Pronunciation check isn’t available in this browser. Use Chrome, Edge or Safari to have your spoken Dutch checked; you can still say each sentence aloud and tick the box.';
  renderVoiceSettings();
  $('settingsDlg').showModal();
}
function bindSettings() {
  const num = (el, key, min, max) => el.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, parseInt(el.value, 10) || DEFAULT_SETTINGS[key]));
    S()[key] = v; el.value = v; saveSettings(); refresh();
  });
  num($('setMinutes'), 'minutes', 5, 240);
  num($('setNew'), 'newPerDay', 0, 60);
  $('setLevel').addEventListener('change', (e) => { S().level = e.target.value; saveSettings(); refresh(); });
  $('setSpeak').addEventListener('change', (e) => { S().requireSpeak = e.target.checked; saveSettings(); applySpeakMode(); });
  $('setAutoplay').addEventListener('change', (e) => { S().autoplay = e.target.checked; saveSettings(); });
  $('setRate').addEventListener('input', (e) => { S().rate = parseFloat(e.target.value); $('rateVal').textContent = S().rate.toFixed(2) + '×'; saveSettings(); });
  $('setVoice').addEventListener('change', (e) => { S().voiceURI = e.target.value; saveSettings(); loadVoices(); speak('Hallo! Zo klink ik.'); });
  $('testVoice').addEventListener('click', () => speak('Goedemorgen! Ik spreek een beetje Nederlands.'));
  $('exportBtn').addEventListener('click', exportBackup);
  $('importFile').addEventListener('change', importBackup);
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Delete ALL progress in this browser? This cannot be undone (unless you have a backup).')) return;
    if (prompt('Type RESET to confirm') !== 'RESET') return;
    const settings = st.settings;
    st = { version: 1, created: Date.now(), cards: {}, days: {}, custom: {}, settings, resetAt: Date.now(), syncUid: st.syncUid };
    save(); $('settingsDlg').close(); goHome(); toast('Progress reset.');
  });
}
function refresh() { if (!$('homeView').classList.contains('hidden')) renderHome(); }
function exportBackup() {
  st.lastBackup = Date.now(); save();
  const blob = new Blob([JSON.stringify({ app: 'dagelijks-nederlands', exported: new Date().toISOString(), state: st }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dutch-progress-${dayKey(dayIndex())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  refresh(); toast('Backup downloaded.');
}
function importBackup(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const s = data.state || data;
      if (!s.cards || typeof s.cards !== 'object') throw new Error('not a backup');
      const n = Object.keys(s.cards).length;
      if (!confirm(`Replace the progress in this browser with this backup (${n} sentences started)?`)) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
      st = load(); save(); loadVoices();
      $('settingsDlg').close(); goHome(); toast('Backup restored.');
    } catch (err) { toast('That file isn’t a valid backup.'); }
  };
  reader.readAsText(f);
}

/* ---------------- misc ---------------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function autoGrow() { const a = $('answer'); a.style.height = 'auto'; a.style.height = Math.max(60, a.scrollHeight + 2) + 'px'; }

function bind() {
  $('homeBtn').onclick = () => { if (!$('quizView').classList.contains('hidden') && sess) endSession(); else goHome(); };
  $('settingsBtn').onclick = openSettings;
  $('syncBadge').onclick = openSettings;
  $('startBtn').onclick = () => {
    const due = dueCards().length;
    if (!due && !newBudget(0)) startSession({ extraNew: 5 }); else startSession();
  };
  $('checkBtn').onclick = () => check(false);
  $('dontKnowBtn').onclick = () => check(true);
  $('hintBtn').onclick = showHint;
  $('knowBtn').onclick = knowIt;
  $('micBtn').onclick = onMic;
  $('retryMicBtn').onclick = () => { if (rec) return stopRec(); if (voice) speak(cur.target, false, onMic); else onMic(); };
  $('playBtn').onclick = () => cur && speak(cur.target);
  $('playSlowBtn').onclick = () => cur && speak(cur.target, true);
  $('overrideBtn').onclick = override;
  $('endBtn').onclick = endSession;
  document.querySelectorAll('.rate').forEach((b) => { b.onclick = () => rate(+b.dataset.r); });
  $('answer').addEventListener('input', autoGrow);
  $('answer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); check(false); }
  });
  ['keydown', 'pointerdown', 'input'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, true));
  document.addEventListener('keydown', (e) => {
    if ($('settingsDlg').open || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('quizView').classList.contains('hidden') || !cur) return;
    const inText = e.target === $('answer');
    if (cur.phase === 'revealed') {
      if (/^[1-4]$/.test(e.key)) { e.preventDefault(); rate(+e.key); }
      else if (e.key === 'Enter') { e.preventDefault(); rate(cur.suggested); }
      else if (e.key === 'p' || e.key === 'P') speak(cur.target);
      else if (e.key === 's' || e.key === 'S') speak(cur.target, true);
      else if ((e.key === 'm' || e.key === 'M') && srOk) onMic();
    } else if (!inText) {
      if (e.key === 'Enter') { e.preventDefault(); check(false); }
      else if ((e.key === 'm' || e.key === 'M') && srOk) onMic();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('pagehide', save);
  bindSettings();
}

async function init() {
  bind();
  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener ? speechSynthesis.addEventListener('voiceschanged', loadVoices) : (speechSynthesis.onvoiceschanged = loadVoices);
  } else loadVoices();
  document.querySelectorAll('.tts-only').forEach((el) => el.classList.toggle('hidden', !voice));
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((ok) => {
      $('storageNote').textContent = ok ? 'This browser has agreed to keep your progress permanently.' : 'Tip: clearing site data in your browser would erase progress — keep a backup.';
    }).catch(() => {});
  }
  try { await loadBanks(); }
  catch (e) {
    $('loading').innerHTML = 'Couldn’t load the sentence files. If you opened <code>index.html</code> directly from disk, run a local server instead (e.g. <code>python3 -m http.server</code>) or use the website.';
    return;
  }
  renderHome();
  setInterval(tick, 1000);
  tick();
}
window.DT = {
  getState: () => st,
  version: () => localVersion,
  merge: mergeStates,
  replaceState(s) {
    st = normalize(s); save(true);
    if (CARDS.length && !$('homeView').classList.contains('hidden')) renderHome();
  },
  onLocalSave: null,
};
init();
})();
