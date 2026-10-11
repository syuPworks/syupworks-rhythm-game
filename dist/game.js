'use strict';
/* syuP音ゲー — game runtime.
 * Sections: constants · storage · audio · clock · chart loading · judgement · rendering · screens · input · bridge
 */

// ───────────────────────────── constants ─────────────────────────────
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LANES = 4;
const LANE_COLORS = ['#62e8ff', '#638dff', '#af78ff', '#ff79bf'];
const HOLD_COLOR = '#ffd86b';
// Difficulty registry. A song shows a difficulty when it has a chart for it; "advanced" ones stay hidden until that song's
// HARD is cleared (see isUnlocked). SPECIAL / CHAOS are registered so future charts only need data, not code.
const DIFFICULTY_DEFS = [
  { id: 'easy', label: 'EASY', color: '#5aefc2', tier: 'standard' },
  { id: 'normal', label: 'NORMAL', color: '#68a9ff', tier: 'standard' },
  { id: 'hard', label: 'HARD', color: '#ff6fa5', tier: 'standard' },
  { id: 'extreme', label: 'EXTREME', color: '#c48cff', tier: 'advanced', unlockAfter: 'hard' },
  { id: 'special', label: 'SPECIAL', color: '#ffb347', tier: 'advanced', unlockAfter: 'hard' },
  { id: 'chaos', label: 'CHAOS', color: '#ff4d6d', tier: 'advanced', unlockAfter: 'hard' }
];
const DIFFS = DIFFICULTY_DEFS.map(d => d.id);
const DIFF_COLORS = Object.fromEntries(DIFFICULTY_DEFS.map(d => [d.id, d.color]));
const diffDef = id => DIFFICULTY_DEFS.find(d => d.id === id) || DIFFICULTY_DEFS[0];
const GAME_VERSION = 'Ver.2';
const JUDGE_COLORS = { PERFECT: '#ffd95a', GREAT: '#57e6ff', GOOD: '#a48cff', MISS: '#ff5d8a' };
const WINDOWS = { PERFECT: 0.05, GREAT: 0.1, GOOD: 0.15 };
const HOLD_RELEASE_GRACE = 0.12;            // releasing this close to the tail still completes the hold
const JUDGE_WEIGHT = { PERFECT: 1, GREAT: 0.7, GOOD: 0.4, MISS: 0 };
const MAX_SCORE = 1000000;
const RANKS = [['S+', 0.98], ['S', 0.95], ['AA', 0.9], ['A', 0.8], ['B', 0.7], ['C', 0.6], ['D', 0]];
const LAMPS = ['NO PLAY', 'FAILED', 'CLEAR', 'FULL COMBO', 'ALL PERFECT'];
const HP_RULES = {
  max: 100,
  missDamage: { easy: 5, normal: 8, hard: 10, extreme: 12, special: 6, chaos: 7 },
  comboRecovery: { easy: { every: 8, amount: 8 }, normal: { every: 12, amount: 6 }, hard: { every: 18, amount: 8 }, extreme: { every: 25, amount: 8 }, special: { every: 10, amount: 6 }, chaos: { every: 12, amount: 6 } },
  hitRecovery: { easy: { PERFECT: 2, GREAT: 1, GOOD: 0 }, normal: { PERFECT: 1, GREAT: 1, GOOD: 0 }, hard: { PERFECT: 1, GREAT: 1, GOOD: 0 }, extreme: { PERFECT: 1, GREAT: 0, GOOD: 0 }, special: { PERFECT: 2, GREAT: 1, GOOD: 0 }, chaos: { PERFECT: 1, GREAT: 1, GOOD: 0 } }
};
const hpKey = diff => (HP_RULES.missDamage[diff] !== undefined ? diff : 'extreme');   // future difficulties inherit EXTREME's HP rules
const KEY_PRESETS = { asdf: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], dfjk: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], sdkl: ['KeyS', 'KeyD', 'KeyK', 'KeyL'] };
const SAVE_KEY = 'syupworks-rhythm-save-v2', LEGACY_SAVE_KEY = 'syupworks-rhythm-save-v1', SETTINGS_KEY = 'syupworks-rhythm-settings-v1';
const DEFAULT_SETTINGS = { speed: 3.5, offsetMs: 0, keys: 'asdf', customKeys: KEY_PRESETS.asdf, hitVolume: 5, musicVolume: 8, timingDisplay: true, noFail: false, effects: 'full', barLines: true };
const LEAD_IN = 2.2;                        // seconds of falling notes before the music starts (at minimum)

// ───────────────────────────── storage ─────────────────────────────
const storage = {
  read(key) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
};
let settings = { ...DEFAULT_SETTINGS, ...(storage.read(SETTINGS_KEY) || {}) };
const saveSettings = () => storage.write(SETTINGS_KEY, settings);

function createDefaultSave() { return { version: 2, songs: {} }; }
function loadSave() {
  const current = storage.read(SAVE_KEY);
  if (current && current.version === 2 && current.songs && typeof current.songs === 'object') return current;
  // v1 records belong to the old (drifting) charts: keep play/clear history so BONUS TRACK stays unlocked, drop the scores.
  const save = createDefaultSave(), legacy = storage.read(LEGACY_SAVE_KEY);
  for (const [songId, songRecord] of Object.entries(legacy?.songs || {}))
    for (const [diff, r] of Object.entries(songRecord?.difficulties || {}))
      if (Number(r?.playCount) > 0) recordFor(save, songId, diff, { plays: Number(r.playCount) || 0, clears: Number(r.clearCount) || 0, lamp: r.cleared ? 2 : 1, legacy: true });
  return save;
}
function recordFor(save, songId, diff, init) {
  const songRecord = save.songs[songId] ||= {};
  return songRecord[diff] ||= { best: 0, rank: '', lamp: 0, plays: 0, clears: 0, maxCombo: 0, bestAccuracy: 0, ...init };
}
let saveData = loadSave();
// a record made on an older revision of a chart (e.g. EXTREME v2 before the v3 redesign) is archived, not compared
function migrateRecords() {
  let changed = false;
  for (const song of songs) for (const [diff, rev] of Object.entries(song.chartRevs || {})) {
    const rec = saveData.songs?.[song.id]?.[diff];
    if (!rec || (rec.rev || 2) === rev) continue;
    if (rec.plays > 0) { const { archived = [], ...old } = rec; saveData.songs[song.id][diff] = { best: 0, rank: '', lamp: 0, plays: 0, clears: 0, maxCombo: 0, bestAccuracy: 0, rev, archived: [...archived, old] }; }
    else rec.rev = rev;
    changed = true;
  }
  if (changed) persist();
}
// advanced difficulties open once the song's HARD is cleared for real (AUTO PLAY / syuP MODE never write records)
function isUnlocked(song, id) {
  const d = diffDef(id);
  if (d.tier !== 'advanced' || syuPMode) return true;
  return (getRecord(song.id, d.unlockAfter)?.lamp || 0) >= 2;
}
const visibleDiffs = song => DIFFICULTY_DEFS.filter(d => song?.charts?.[d.id] && isUnlocked(song, d.id)).map(d => d.id);
const lockedDiffs = song => DIFFICULTY_DEFS.filter(d => song?.charts?.[d.id] && !isUnlocked(song, d.id)).map(d => d.id);
const unlockSeen = (songId, diff) => !!saveData.unlockSeen?.[songId]?.[diff];
function markUnlockSeen(songId, diff) { if (syuPMode || diffDef(diff).tier !== 'advanced' || unlockSeen(songId, diff)) return; ((saveData.unlockSeen ||= {})[songId] ||= {})[diff] = true; persist(); }

// ───────────────────────────── syuP MODE (developer) ─────────────────────────────
// Same commands as Ver.1: title "109109" (or 20 taps on the character) → ON, "1111" → OFF, "0000" → reset save;
// in play "109" → force clear. While ON every difficulty is visible and nothing is recorded or unlocked.
let syuPMode = (() => { try { return sessionStorage.getItem('syupworks-syup-mode') === '1' || new URLSearchParams(location.search).get('syupmode') === '1'; } catch { return false; } })();
const dev = { buffer: '', taps: 0, tapAt: 0 };
const getRecord = (songId, diff) => saveData.songs?.[songId]?.[diff] || null;
const persist = () => storage.write(SAVE_KEY, saveData);

// ───────────────────────────── audio ─────────────────────────────
const audio = $('#audio'), preview = $('#preview');
const sound = { ctx: null, source: null, analyser: null, musicGain: null, hitGain: null, hitBuffer: null, freq: null };

function ensureAudio() {
  if (!sound.ctx) {
    // iPhone: music runs through Web Audio, which the silent switch would mute; declare it as media playback (Safari 17+)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null;
    sound.ctx = new Ctx({ latencyHint: 'interactive' });
    sound.hitGain = sound.ctx.createGain(); sound.hitGain.connect(sound.ctx.destination);
    sound.hitBuffer = makeHitBuffer(sound.ctx);
  }
  if (sound.ctx.state === 'suspended') sound.ctx.resume().catch(() => {});
  applyVolumes();
  return sound.ctx;
}
function connectMusic() {
  const ctx = ensureAudio(); if (!ctx || sound.source) return;
  try {
    sound.source = ctx.createMediaElementSource(audio);
    sound.analyser = ctx.createAnalyser(); sound.analyser.fftSize = 128; sound.analyser.smoothingTimeConstant = 0.8;
    sound.freq = new Uint8Array(sound.analyser.frequencyBinCount);
    sound.musicGain = ctx.createGain();
    sound.source.connect(sound.analyser); sound.analyser.connect(sound.musicGain); sound.musicGain.connect(ctx.destination);
  } catch (error) { console.warn('Music routing unavailable; using element volume.', error); sound.source = null; }
  applyVolumes();
}
function applyVolumes() {
  const music = settings.musicVolume / 10;
  if (sound.musicGain) { sound.musicGain.gain.value = music; audio.volume = 1; } else audio.volume = music;
  preview.volume = Math.min(1, music);
  if (sound.hitGain) sound.hitGain.gain.value = (settings.hitVolume / 10) * 0.55;
}
function makeHitBuffer(ctx) {
  // a short, soft "tock": pitched click with a filtered noise transient — reads as a key press, not a melody note
  const sr = ctx.sampleRate, len = Math.round(sr * 0.06), buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
  let seed = 7, lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr, env = Math.exp(-t * 70), noiseEnv = Math.exp(-t * 260);
    seed = (seed * 16807) % 2147483647; const noise = seed / 1073741823.5 - 1; lp += (noise - lp) * 0.35;
    d[i] = 0.55 * Math.sin(2 * Math.PI * 1320 * t) * env + 0.35 * Math.sin(2 * Math.PI * 660 * t) * env + 0.5 * lp * noiseEnv;
  }
  return buf;
}
function playHitSound() {
  if (!settings.hitVolume || !sound.ctx || sound.ctx.state !== 'running') return;
  const src = sound.ctx.createBufferSource(); src.buffer = sound.hitBuffer; src.connect(sound.hitGain); src.start();
}
function playPartnerTick() {   // syuP's notes: a softer, higher "pon" so the duet is audible
  if (!settings.hitVolume || !sound.ctx || sound.ctx.state !== 'running') return;
  const ctx = sound.ctx, now = ctx.currentTime, o = ctx.createOscillator(), gn = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(1760, now); o.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
  gn.gain.setValueAtTime(0.0001, now); gn.gain.exponentialRampToValueAtTime((settings.hitVolume / 10) * 0.18, now + 0.005); gn.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  o.connect(gn).connect(ctx.destination); o.start(now); o.stop(now + 0.13);
}
function playChime(freqs, gainValue = 0.12, duration = 0.5) {
  const ctx = sound.ctx; if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  freqs.forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = now + i * 0.07;
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gainValue, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + duration + 0.02);
  });
}
function outputLatency() {
  const ctx = sound.ctx; if (!ctx || !sound.source) return 0;
  return Math.min(0.5, (Number(ctx.outputLatency) || 0) + (Number(ctx.baseLatency) || 0));
}

// ───────────────────────────── song clock ─────────────────────────────
// Song time = chart time. It runs on performance.now() and is continuously nudged toward the audio element,
// so notes move smoothly even though audio.currentTime updates in coarse steps.
const clock = { running: false, base: 0, perf: 0, rate: 1, audioLocked: false, frozenAt: 0, waitAt: 0, audioStartPos: 0 };
const offsetSec = () => settings.offsetMs / 1000;
function clockNow(perf = performance.now()) { return clock.running ? clock.base + (perf - clock.perf) / 1000 * clock.rate : clock.frozenAt; }
function clockSet(t, perf = performance.now()) { clock.base = t; clock.perf = perf; }
function clockStart(t) { clock.running = true; clock.rate = 1; clock.lastT = t; clockSet(t); }
function clockStop() { clock.frozenAt = clockNow(); clock.running = false; }
function audioSongTime() { return audio.currentTime - outputLatency() - offsetSec(); }
function syncClock(perf) {
  if (!clock.running || audio.paused || audio.readyState < 2) return;
  const target = audioSongTime(), est = clockNow(perf), diff = target - est;
  if (!clock.audioLocked) {
    // waiting for the music to actually start: hold the clock at the start point instead of jumping back
    if (audio.currentTime > clock.audioStartPos + 0.02) { clock.audioLocked = true; if (Math.abs(diff) > 0.06) clockSet(target, perf); }
    return;
  }
  if (Math.abs(diff) > 0.06) { clockSet(target, perf); clock.lastT = target; return; }
  // gentle correction, but never let the song run backwards between frames
  const next = Math.max(est + diff * 0.08, clock.lastT ?? -Infinity);
  clockSet(next, perf); clock.lastT = next;
}

// ───────────────────────────── data ─────────────────────────────
let data = null, songs = [];
const chartCache = new Map();
function loadChart(path) {
  if (!chartCache.has(path)) chartCache.set(path, fetch(path).then(r => { if (!r.ok) throw new Error(`chart ${path}: ${r.status}`); return r.json(); }).catch(error => { chartCache.delete(path); throw error; }));
  return chartCache.get(path);
}
function resolveSong(raw) {
  const defaults = data.defaults || {};
  return { ...raw, title: raw.title || (raw.audio || '').split('/').pop().replace(/\.[^.]+$/, ''), jacket: raw.jacket || defaults.jacket || 'backgrounds/no-image.svg', artist: raw.artist || defaults.artist || 'syuPworks', genre: raw.genre || defaults.genre || '', description: raw.description || defaults.description || '' };
}
const levelOf = (song, diff) => song.levels?.[diff] ?? '?';
// ★ + Lv. At most five stars: every five levels the stars are promoted to the next grade, filling from the left
// (gold → rose → crystal → nova → prism). Lv.6 = one rose star + four gold, Lv.20 = five nova stars.
// Levels past the last grade stay prism with an extra "over" sheen, so the scale can keep growing.
const STAR_GRADES = ['gold', 'rose', 'crystal', 'nova', 'prism'];
function starMarkup(level, { lv = true } = {}) {
  const L = Math.max(0, Math.floor(Number(level) || 0));
  if (!L) return `<span class="level-stars"><span class="stars"><i class="g-gold empty">☆</i></span>${lv ? '<small>Lv.<b>?</b></small>' : ''}</span>`;
  const grade = Math.floor((L - 1) / 5), filled = (L - 1) % 5 + 1, slots = Math.min(5, L), last = STAR_GRADES.length - 1;
  const top = STAR_GRADES[Math.min(grade, last)], under = STAR_GRADES[Math.min(Math.max(grade - 1, 0), last)], over = grade > last ? ' over' : '';
  const stars = Array.from({ length: slots }, (_, i) => `<i class="g-${i < filled || grade === 0 ? top : under}${over}">★</i>`).join('');
  return `<span class="level-stars grade-${top}" title="LEVEL ${L} · ${top.toUpperCase()}" aria-label="難易度 Lv.${L}"><span class="stars">${stars}</span>${lv ? `<small>Lv.<b>${L}</b></small>` : ''}</span>`;
}
const formatTime = s => !Number.isFinite(s) || s < 0 ? '--:--' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const rankOf = ratio => RANKS.find(([, min]) => ratio >= min)[0];
const keyLabel = code => ({ Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Space: '␣', BracketLeft: '[', BracketRight: ']', Quote: "'" }[code] || code.replace(/^Key|^Digit|^Numpad/, '').replace(/^Arrow/, ''));
const laneKeys = () => settings.keys === 'custom' ? settings.customKeys : KEY_PRESETS[settings.keys] || KEY_PRESETS.asdf;

// ───────────────────────────── run state & judgement ─────────────────────────────
const PENDING = 0, HOLDING = 1, DONE = 2;
let run = null;                 // the song being played
let screen = 'intro';
const heldLanes = [false, false, false, false];
const laneLight = [0, 0, 0, 0]; // perf timestamp of last press (key beam fade)
const pointerLanes = new Map();

function buildRun(song, diff, chart, { autoPlay = false, promo = false } = {}) {
  const notes = chart.notes.map((n, i) => {
    const duration = Number(n.duration) > 0 ? Number(n.duration) : 0;
    return { id: i, time: Number(n.time), lane: n.lane, duration, end: Number(n.time) + duration, state: PENDING, head: null, tail: null, release: !!(duration && n.release), echo: !!n.echo, partner: !!n.partner, hop: n.hop, from: n.from, swapAt: n.swapAt, raw: n };   // raw: the chart note as written (rule plugins read their own fields from it)
  }).sort((a, b) => a.time - b.time || a.lane - b.lane);
  const lanes = Array.from({ length: LANES }, () => []);
  const mine = notes.filter(n => !n.partner), partnerNotes = notes.filter(n => n.partner);
  mine.forEach(n => lanes[n.lane].push(n));
  const objects = mine.length + mine.filter(n => n.duration).length;
  const cards = Array.isArray(chart.cards) ? chart.cards : [];
  if (cards.length) notes.forEach(n => { n.card = cards.find(c => n.time >= c.start - 1e-3 && n.time < c.end - 1e-3) || null; });
  const firstNote = notes[0]?.time ?? 0, lastEnd = notes.reduce((m, n) => Math.max(m, n.end), 0);
  const milestoneSet = new Set(comboMilestones(objects));
  return {
    song, diff, chart, notes, lanes, laneHead: [0, 0, 0, 0], objects, firstNote, lastEnd,
    bpm: Number(chart.bpm) || Number(song.bpm) || 120, offset: Number(chart.offset) || 0, beatsPerBar: Number(chart.beatsPerBar) || 4,
    approach: 6 / settings.speed,
    weight: 0, judged: 0, combo: 0, maxCombo: 0, counts: { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 }, fast: 0, slow: 0,
    deltas: [], events: [], hp: HP_RULES.max, hpLog: [[0, HP_RULES.max]], failed: false, noFailUsed: false,
    autoPlay, promo, started: false, musicStarted: false, ended: false, paused: false, finishing: false, effects: [], lastHitAt: -1,
    dev: syuPMode, mechanics: chart.mechanics || [], character: chart.character || null, scroll: makeScroll(chart.speed, Number(chart.bpm) || 120), speedIdx: 0,
    milestoneSet, milestones: [],
    partnerNotes, partnerHead: 0, turns: chart.turns || [], turnIdx: 0, cards, cardIdx: 0, dealIdx: 0, canvasSpec: chart.canvas || null
  };
}
// SURGE: piecewise-linear scroll speed. S(t) is the distance travelled by time t; a note sits at depth
// (S(note) − S(now)) / approach. Speed eases over the beat before each change point; judgement timing never changes.
function makeScroll(changes, bpm) {
  if (!Array.isArray(changes) || !changes.length) return { S: t => t, speedAt: () => 1, minSpeed: 1, changes: [] };
  const ramp = Math.min(0.6, 60 / bpm), knots = [{ t: -1e5, v: 1 }];
  let v = 1;
  for (const c of changes) { knots.push({ t: c.time - ramp, v }, { t: c.time, v: c.speed }); v = c.speed; }
  knots.push({ t: 1e5, v });
  knots[0].S = knots[0].t;
  for (let i = 1; i < knots.length; i++) { const a = knots[i - 1], b = knots[i]; b.S = a.S + (a.v + b.v) / 2 * (b.t - a.t); }
  const seg = t => { let lo = 0, hi = knots.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (knots[m].t <= t) lo = m; else hi = m - 1; } return lo; };
  const S = t => { const i = seg(t), a = knots[i], b = knots[i + 1], dt = t - a.t, acc = b.t > a.t ? (b.v - a.v) / (b.t - a.t) : 0; return a.S + a.v * dt + 0.5 * acc * dt * dt; };
  const speedAt = t => { const i = seg(t), a = knots[i], b = knots[i + 1]; return b.t > a.t ? a.v + (b.v - a.v) * Math.min(1, (t - a.t) / (b.t - a.t)) : b.v; };
  return { S, speedAt, minSpeed: Math.min(1, ...changes.map(c => c.speed)), changes };
}
const depthOf = (r, time, t) => (r.scroll.S(time) - r.scroll.S(t)) / r.approach;
const hasCard = (n, c) => !!n.card && n.card.cards.includes(c);
// MARCH: notes advance in steps on the beat (pause, then stride) and still arrive exactly on time
function marchWarp(x, P) { const k = Math.floor(x / P), f = x / P - k, s = f * f * (3 - 2 * f); return (k + s) * P; }
function noteDepth(r, n, time, t) { return hasCard(n, 'march') && time - t > 0 ? marchWarp(time - t, 60 / r.bpm) / r.approach : depthOf(r, time, t); }
const ease = k => k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
// HOP / SHUFFLE: the lane a note is *shown* in; it always lands in its real lane (n.lane) well before the hit
function laneShown(r, n, t) {
  if (n.from !== undefined) { const k = ease((t - n.swapAt) / 0.3); return n.from + (n.lane - n.from) * k; }
  if (n.hop !== undefined) { const at = n.time - Math.min(0.55, r.approach * 0.6), k = ease((t - at) / 0.22); return n.hop + (n.lane - n.hop) * k; }
  return n.lane;
}
function hopLift(r, n, t) { if (n.hop === undefined) return 0; const at = n.time - Math.min(0.55, r.approach * 0.6), k = (t - at) / 0.22; return k > 0 && k < 1 ? Math.sin(Math.PI * k) : 0; }
const activeCard = (r, t) => r.cards.find(c => t >= c.start && t < c.end) || null;
// combo milestones worth celebrating, scaled to the chart: a 180-note EASY gets 50/100/150, a 1000-note EXTREME gets 100…1000
function comboMilestones(objects) {
  const base = objects < 260 ? [50, 100, 150, 200] : [100, 200, 300, 500, 750, 1000, 1500, 2000];
  return base.filter(m => m <= objects);
}
const scoreOf = r => Math.round(MAX_SCORE * r.weight / Math.max(1, r.objects));
const accuracyOf = r => r.weight / Math.max(1, r.objects);

function judgeKind(delta) { const a = Math.abs(delta); return a <= WINDOWS.PERFECT ? 'PERFECT' : a <= WINDOWS.GREAT ? 'GREAT' : 'GOOD'; }

function applyJudgement(kind, lane, t, { delta = null, tail = false, release = false, note = null } = {}) {
  const r = run;
  if (note && art.active) artJudge(note, tail, kind);
  if (note && r.rule) ruleCall('judge', note, kind, { delta, tail, release });
  r.counts[kind]++; r.judged++; r.weight += JUDGE_WEIGHT[kind];
  r.events.push({ t, kind });
  if (kind === 'MISS') {
    r.combo = 0;
    changeHP(-Math.round(HP_RULES.missDamage[hpKey(r.diff)] * (tail ? 0.5 : 1)), t);
    r.effects.push({ type: 'miss', lane, t0: t });
  } else {
    r.combo++; r.maxCombo = Math.max(r.maxCombo, r.combo);
    if (r.milestoneSet.has(r.combo) && !r.milestones.some(m => m.combo === r.combo)) r.milestones.push({ combo: r.combo, t });
    if (delta !== null) {
      r.deltas.push(delta);
      if (kind !== 'PERFECT') delta < 0 ? r.fast++ : r.slow++;
    }
    const heal = HP_RULES.hitRecovery[hpKey(r.diff)][kind] || 0, rule = HP_RULES.comboRecovery[hpKey(r.diff)];
    changeHP(heal + (r.combo % rule.every === 0 ? rule.amount : 0), t);
    r.effects.push({ type: release ? 'release' : 'hit', kind, lane, t0: t, tail });
    r.lastHitAt = t;
    if (r.combo > 0 && r.combo % 100 === 0) {
      playChime(r.combo % 1000 === 0 ? [659, 784, 988, 1319, 1568] : r.combo % 500 === 0 ? [784, 988, 1175, 1568] : [784, 988, 1319], 0.07, r.combo % 500 === 0 ? 0.6 : 0.45);
      showComboMilestone(r.combo);
    }
  }
  showJudgement(kind, tail && !release ? null : delta, release);
  updateHud();
}

function changeHP(amount, t) {
  const r = run; if (!amount) return;
  const before = r.hp;
  r.hp = Math.max(0, Math.min(HP_RULES.max, r.hp + amount));
  if (r.hp !== before) r.hpLog.push([t, r.hp]);
  if (r.hp === 0 && before > 0) {
    r.failed = true;
    if (settings.noFail || r.autoPlay) { r.noFailUsed = true; return; }
    if (!r.promo) gameOver();
  }
}

function hitHead(note, delta, t) {
  const kind = judgeKind(delta);
  note.head = kind;
  if (note.duration) { note.state = HOLDING; } else note.state = DONE;
  applyJudgement(kind, note.lane, t, { delta, note });
}
function missNote(note, t) {
  if (note.state === PENDING) {
    note.head = 'MISS'; applyJudgement('MISS', note.lane, t, { note });
    if (note.duration) { note.tail = 'MISS'; applyJudgement('MISS', note.lane, t, { tail: true, note }); }
  } else if (note.state === HOLDING) { note.tail = 'MISS'; applyJudgement('MISS', note.lane, t, { tail: true, note }); }
  note.state = DONE;
}
function completeHold(note, t) { note.state = DONE; note.tail = 'PERFECT'; applyJudgement('PERFECT', note.lane, t, { tail: true, note }); }
// RELEASE holds: letting go is a timed hit of its own, with the same windows as a press
function judgeRelease(note, delta, t) { const kind = judgeKind(delta); note.state = DONE; note.tail = kind; applyJudgement(kind, note.lane, t, { delta, tail: true, release: true, note }); }

function nextPending(lane) {
  const q = run.lanes[lane]; let i = run.laneHead[lane];
  while (i < q.length && q[i].state === DONE) i++;
  run.laneHead[lane] = i;
  for (let j = i; j < q.length; j++) if (q[j].state === PENDING) return q[j];
  return null;
}

function pressLane(lane, perf = performance.now()) {
  if (screen !== 'play' || !run || run.paused || run.ended) return;
  heldLanes[lane] = true; laneLight[lane] = perf;
  playHitSound();
  if (run.autoPlay || !run.started) return;
  const t = clockNow(perf), note = nextPending(lane);
  if (!note) return;
  const delta = t - note.time;
  if (delta < -WINDOWS.GOOD) return;          // too early: a free "ghost" press, no penalty
  if (delta > WINDOWS.GOOD) return;           // the update loop will mark it missed
  hitHead(note, delta, t);
}
function releaseLane(lane, perf = performance.now()) {
  heldLanes[lane] = false;
  if (!run || run.autoPlay || run.paused || run.ended) return;
  const t = clockNow(perf);
  for (const note of run.lanes[lane]) {
    if (note.state !== HOLDING) continue;
    if (note.release) { const delta = t - note.end; if (delta < -WINDOWS.GOOD) missNote(note, t); else judgeRelease(note, delta, t); }
    else if (t >= note.end - HOLD_RELEASE_GRACE) completeHold(note, t); else missNote(note, t);
  }
}

// SPECIAL: syuP plays the partner notes on time (never judged, never scored)
function updatePartner(t) {
  const r = run;
  for (let i = r.partnerHead; i < r.partnerNotes.length; i++) {
    const n = r.partnerNotes[i]; if (n.time > t) break;
    if (n.state === PENDING && n.silent) { n.state = DONE; continue; }
    if (n.state === PENDING) { n.state = n.duration ? HOLDING : DONE; r.effects.push({ type: 'partner', lane: n.lane, t0: n.time }); playPartnerTick(); r.partnerLastHit = n.time; (r.portraitNotes ||= []).push({ t0: n.time, lane: n.lane }); if (r.portraitNotes.length > 12) r.portraitNotes.shift(); }
    if (n.state === HOLDING && t >= n.end) { n.state = DONE; r.effects.push({ type: 'partner', lane: n.lane, t0: n.end }); }
  }
  while (r.partnerHead < r.partnerNotes.length && r.partnerNotes[r.partnerHead].state === DONE) r.partnerHead++;
}
function updateJudgements(t) {
  const r = run;
  if (r.partnerNotes.length) updatePartner(t);
  for (let lane = 0; lane < LANES; lane++) {
    const q = r.lanes[lane];
    while (r.laneHead[lane] < q.length && q[r.laneHead[lane]].state === DONE) r.laneHead[lane]++;
    for (let i = r.laneHead[lane]; i < q.length; i++) {
      const n = q[i];
      if (n.time > t + 0.2) break;
      if (n.state === PENDING) {
        if (r.autoPlay && t >= n.time) { hitHead(n, 0, n.time); laneLight[lane] = performance.now(); }
        else if (t - n.time > WINDOWS.GOOD) missNote(n, n.time + WINDOWS.GOOD);
      }
      if (n.state === HOLDING) {
        if (r.autoPlay) laneLight[lane] = performance.now();
        if (n.release) {
          if (r.autoPlay) { if (t >= n.end) judgeRelease(n, 0, n.end); }
          else if (t > n.end + WINDOWS.GOOD) missNote(n, n.end + WINDOWS.GOOD);   // held past the release point
          else if (!heldLanes[lane] && t < n.end - WINDOWS.GOOD && t > Math.max(n.time + 0.08, r.regrabUntil || 0)) missNote(n, t);
        } else if (t >= n.end) completeHold(n, n.end);
        else if (!r.autoPlay && !heldLanes[lane] && t > Math.max(n.time + 0.08, r.regrabUntil || 0)) missNote(n, t);   // let go without a keyup (e.g. focus loss)
      }
      if (r.ended) return;
    }
  }
}

// ───────────────────────────── board rendering ─────────────────────────────
const board = { canvas: $('#board'), ctx: null, W: 1, H: 1, dpr: 1, judgeY: 0, topY: 0, horizonY: 0, nearW: 0, cx: 0, far: 0.56 };
board.ctx = board.canvas.getContext('2d', { alpha: true });
const vizLevels = new Float32Array(16);
let vizLast = 0;
const coarsePointer = matchMedia('(pointer:coarse)');

function resizeBoard() {
  const rect = board.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(rect.width * dpr), H = Math.round(rect.height * dpr);
  if (board.canvas.width !== W || board.canvas.height !== H) { board.canvas.width = W; board.canvas.height = H; }
  Object.assign(board, { W, H, dpr, cx: W / 2, judgeY: H * 0.85, topY: H * 0.035 });
  board.nearW = Math.min(W * 0.9, H * (W > H * 1.8 ? 1.3 : 1.05));
  board.horizonY = (board.topY - board.judgeY * board.far) / (1 - board.far);
}
// Real plane perspective: depth d (0 = judge line, 1 = spawn) → scale s → screen y. Lane edges stay straight lines.
const scaleAt = d => 1 / (1 + d * (1 / board.far - 1));
const yAt = s => board.horizonY + (board.judgeY - board.horizonY) * s;
const edgeX = (i, s) => board.cx - board.nearW * s / 2 + board.nearW * s * i / LANES;
const sAtY = y => (y - board.horizonY) / (board.judgeY - board.horizonY);
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function rand01(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

function lanePath(ctx, i, s0, s1, inset = 0) {
  ctx.beginPath();
  ctx.moveTo(edgeX(i, s0) + inset * s0, yAt(s0)); ctx.lineTo(edgeX(i + 1, s0) - inset * s0, yAt(s0));
  ctx.lineTo(edgeX(i + 1, s1) - inset * s1, yAt(s1)); ctx.lineTo(edgeX(i, s1) + inset * s1, yAt(s1)); ctx.closePath();
}

function drawBoard(t, perf) {
  const { ctx, W, H, judgeY, dpr } = board, r = run; if (!r) return;
  const lite = settings.effects === 'lite', far = board.far, sBottom = sAtY(H);
  ctx.clearRect(0, 0, W, H);
  const wobble = wobbleAngle(r, t);
  if (wobble) { ctx.save(); ctx.translate(board.cx, judgeY); ctx.rotate(wobble); ctx.translate(-board.cx, -judgeY); }
  const P = 60 / r.bpm, beatPos = (t - r.offset) / P, beatPhase = beatPos - Math.floor(beatPos);
  const onBar = ((Math.floor(beatPos + 1e-6) % r.beatsPerBar) + r.beatsPerBar) % r.beatsPerBar === 0;
  const pulse = t > r.firstNote - 4 && !r.paused ? Math.exp(-beatPhase * 5) * (onBar ? 1 : 0.6) : 0;

  drawVisualizer(ctx, perf);

  // lanes
  const fever = Math.min(1, r.combo / 150);
  for (let i = 0; i < LANES; i++) {
    lanePath(ctx, i, far, sBottom);
    const g = ctx.createLinearGradient(0, board.topY, 0, judgeY);
    g.addColorStop(0, 'rgba(10,18,44,0.55)'); g.addColorStop(1, rgba(LANE_COLORS[i], 0.05 + 0.1 * fever));
    ctx.fillStyle = g; ctx.fill();
  }
  ctx.lineWidth = Math.max(1, dpr);
  for (let i = 0; i <= LANES; i++) {
    const outer = i === 0 || i === LANES;
    ctx.strokeStyle = outer ? `rgba(169,221,255,${0.45 + 0.35 * pulse})` : `rgba(169,221,255,${0.16 + 0.12 * pulse})`;
    ctx.beginPath(); ctx.moveTo(edgeX(i, far), yAt(far)); ctx.lineTo(edgeX(i, sBottom), yAt(sBottom)); ctx.stroke();
  }

  // key beams
  for (let i = 0; i < LANES; i++) {
    const since = (perf - laneLight[i]) / 1000, a = heldLanes[i] ? 1 : Math.max(0, 1 - since / 0.18);
    if (a <= 0) continue;
    lanePath(ctx, i, Math.max(far, 0.62), 1);
    const g = ctx.createLinearGradient(0, yAt(0.62), 0, judgeY);
    g.addColorStop(0, rgba(LANE_COLORS[i], 0)); g.addColorStop(1, rgba(LANE_COLORS[i], 0.34 * a));
    ctx.fillStyle = g; ctx.fill();
  }

  // bar lines: let the eye read the measure
  if (settings.barLines) {
    const bar = P * r.beatsPerBar, k = Math.ceil((t - r.offset) / bar);
    for (let bt = r.offset + k * bar; bt < t + r.approach / r.scroll.minSpeed; bt += bar) {
      const d = depthOf(r, bt, t); if (d < 0 || d > 1) continue;
      const s = scaleAt(d), y = yAt(s);
      ctx.strokeStyle = `rgba(200,230,255,${0.2 * (1 - d * 0.6)})`; ctx.lineWidth = Math.max(1, 1.5 * dpr * s);
      ctx.beginPath(); ctx.moveTo(edgeX(0, s), y); ctx.lineTo(edgeX(LANES, s), y); ctx.stroke();
    }
  }

  // SURGE: the change point arrives as a coloured line with chevrons, and the outer rails tint while the board runs fast
  for (const c of r.scroll.changes) {
    if (c.time < t) continue;
    const d = depthOf(r, c.time, t); if (d > 1) break;
    const s = scaleAt(d), y = yAt(s), up = c.speed > r.scroll.speedAt(c.time - 0.7);
    ctx.strokeStyle = up ? 'rgba(255,123,216,0.85)' : 'rgba(127,232,255,0.85)'; ctx.lineWidth = Math.max(2, 3 * dpr * s);
    ctx.beginPath(); ctx.moveTo(edgeX(0, s), y); ctx.lineTo(edgeX(LANES, s), y); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.font = `900 ${Math.round(16 * dpr * s)}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(up ? '▲▲ SURGE' : '▼ BREATH', edgeX(LANES, s) + 6 * dpr, y);
  }
  const speedNow = r.scroll.speedAt(t);
  if (Math.abs(speedNow - 1) > 0.05) {
    ctx.strokeStyle = speedNow > 1 ? `rgba(255,123,216,${0.35 + 0.3 * pulse})` : `rgba(127,232,255,${0.3 + 0.2 * pulse})`; ctx.lineWidth = Math.max(2, 3 * dpr);
    for (const i of [0, LANES]) { ctx.beginPath(); ctx.moveTo(edgeX(i, far), yAt(far)); ctx.lineTo(edgeX(i, sBottom), yAt(sBottom)); ctx.stroke(); }
  }

  drawNotes(ctx, t, lite);
  if (r.cards.length) drawVisit(ctx, t, P);
  if (r.turns.length) drawPartnerTurn(ctx, t, pulse);
  ruleCall('draw', ctx, t);

  // judge line
  const jl = ctx.createLinearGradient(edgeX(0, 1), 0, edgeX(LANES, 1), 0);
  jl.addColorStop(0, '#62e8ff'); jl.addColorStop(0.25, '#ffffff'); jl.addColorStop(0.75, '#ffffff'); jl.addColorStop(1, '#ff79bf');
  ctx.save();
  if (!lite) { ctx.shadowColor = `rgba(117,230,218,${0.55 + 0.45 * pulse})`; ctx.shadowBlur = (14 + 16 * pulse) * dpr; }
  ctx.fillStyle = jl; const lh = Math.max(3, H * 0.008 + pulse * 2 * dpr);
  ctx.fillRect(edgeX(0, 1), judgeY - lh / 2, board.nearW, lh);
  ctx.restore();

  // key caps below the judge line
  const capTop = judgeY + H * 0.022, sCap = sAtY(capTop), labels = laneKeys().map(keyLabel);
  for (let i = 0; i < LANES; i++) {
    const pressed = heldLanes[i] || (perf - laneLight[i]) < 90;
    lanePath(ctx, i, sCap, sBottom, 5 * dpr);
    ctx.fillStyle = pressed ? rgba(LANE_COLORS[i], 0.42) : 'rgba(8,17,40,0.82)'; ctx.fill();
    ctx.strokeStyle = rgba(LANE_COLORS[i], pressed ? 0.95 : 0.4); ctx.lineWidth = Math.max(1, dpr); ctx.stroke();
    if (!coarsePointer.matches) {
      const midS = (sCap + sBottom) / 2;
      ctx.fillStyle = pressed ? '#ffffff' : 'rgba(223,255,250,0.78)';
      ctx.font = `800 ${Math.round(Math.min(H * 0.042, board.nearW * 0.05))}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(labels[i] || '', (edgeX(i, midS) + edgeX(i + 1, midS)) / 2, yAt(midS));
    }
  }

  drawEffects(ctx, t, lite);
  if (wobble) ctx.restore();

  // song progress
  const dur = r.song.duration || r.chart.duration || audio.duration || 1, prog = Math.max(0, Math.min(1, t / dur));
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(0, 0, W, 3 * dpr);
  const pg = ctx.createLinearGradient(0, 0, W, 0); pg.addColorStop(0, '#62e8ff'); pg.addColorStop(1, '#ff79bf');
  ctx.fillStyle = pg; ctx.fillRect(0, 0, W * prog, 3 * dpr);
}

// CHAOS "wobble": a slow sway around the judge line (so the hit area barely moves); off with LITE / reduced motion
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function wobbleAngle(r, t) {
  if (!r.cards.length || settings.effects === 'lite' || reducedMotion.matches) return 0;
  const c = activeCard(r, t); if (!c || !c.cards.includes('wobble')) return 0;
  const fade = Math.min(1, (t - c.start) / 1, (c.end - t) / 1), bar = 60 / r.bpm * r.beatsPerBar;
  return 0.045 * fade * Math.sin(2 * Math.PI * (t - c.start) / (bar * 2));
}
// syuP's portrait (SPECIAL session + CHAOS visit). The picture is data, not code: songs.json `settings.partnerImage`
// (or a song's own `partnerImage`) can point at a higher-resolution drawing later. Blank margins are trimmed
// automatically, the aspect ratio is always kept, and it is never blown up past ~1.6× its real pixels.
const PORTRAIT_DEFAULT = 'title-assets/title-character.png';
const portrait = { src: '', img: null, w: 1, h: 1, ready: false };
function trimImage(img) {
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const full = { canvas: c, w: c.width, h: c.height };
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  try {
    const d = x.getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y++) for (let X = 0; X < c.width; X++) {
      const i = (y * c.width + X) * 4;
      if (d[i + 3] > 40 && d[i] + d[i + 1] + d[i + 2] < 690) { if (X < x0) x0 = X; if (X > x1) x1 = X; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  } catch { return full; }
  if (x1 < 0) return full;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.12);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return { canvas: o, w: o.width, h: o.height };
}
function loadPortrait(src) {
  src = src || PORTRAIT_DEFAULT;
  if (portrait.src === src) return;
  Object.assign(portrait, { src, ready: false });
  const img = new Image();
  img.onload = () => { if (portrait.src !== src) return; const t = trimImage(img); Object.assign(portrait, { img: t.canvas, w: t.w, h: t.h, ready: true }); };
  img.onerror = () => { if (portrait.src === src && src !== PORTRAIT_DEFAULT) { portrait.src = ''; loadPortrait(PORTRAIT_DEFAULT); } };
  img.src = src;
}
// the portrait in a white rounded card; (x, y) = top-left, h = card height in device px. Returns the card width.
function drawPortraitCard(ctx, x, y, h, ring, alpha = 1) {
  const w = h * portrait.w / portrait.h, rad = Math.min(w, h) * 0.16;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff'; roundRect(ctx, x, y, w, h, rad); ctx.fill();
  ctx.save(); roundRect(ctx, x, y, w, h, rad); ctx.clip(); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(portrait.img, x, y, w, h); ctx.restore();
  if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = Math.max(2, 3 * board.dpr); roundRect(ctx, x, y, w, h, rad); ctx.stroke(); }
  ctx.restore();
  return w;
}
// CHAOS "visit": syuP sits on the far half of one lane (notes come out from behind; the near half always stays clear)
function drawVisit(ctx, t, P) {
  const c = run.cards.find(x => x.cards.includes('visit') && t >= x.start - P && t < x.end + P); if (!c || !portrait.ready) return;
  const inK = ease((t - (c.start - P)) / P), outK = ease((t - c.end) / P), lane = c.lane ?? 0;
  const s = scaleAt(0.78), box = (edgeX(lane + 1, s) - edgeX(lane, s)) * 1.15, a = portrait.w / portrait.h;
  const hgt = a >= 1 ? box / a : box, w = hgt * a;
  const home = (edgeX(lane, s) + edgeX(lane + 1, s)) / 2, startX = lane < 2 ? -w : board.W + w;
  const x = startX + (home - startX) * inK + (outK > 0 ? (startX - home) * outK : 0);
  const bob = Math.abs(Math.sin(Math.PI * (t / P))) * hgt * 0.06, y = yAt(scaleAt(0.55)) - hgt - bob;
  drawPortraitCard(ctx, x - w / 2, y, hgt, rgba(LANE_COLORS[lane], 0.9), 0.97);
}
// SPECIAL: whose turn it is. While syuP plays, the portrait is big, bright, pink-ringed and bounces on every syuP note
// (♪ float up from it); on your turn it shrinks and dims. It lives in the empty corner left of the far lanes and is
// sized so it never overlaps a lane, the judge line or the touch area.
function partnerTurnAt(r, t) { const P = 60 / r.bpm; let who = 'you'; for (const tr of r.turns) { if (tr.time <= t + P) who = tr.who; else break; } return who; }
function drawPartnerTurn(ctx, t, pulse) {
  const r = run, who = partnerTurnAt(r, t), dpr = board.dpr;
  if (who === 'partner') { for (let i = 0; i < LANES; i++) { lanePath(ctx, i, board.far, 1); ctx.fillStyle = 'rgba(255,170,215,0.07)'; ctx.fill(); } }
  if (!portrait.ready) return;
  const goal = who === 'you' ? 0 : 1; r.portraitK = r.portraitK === undefined ? goal : r.portraitK + (goal - r.portraitK) * 0.18;
  const k = r.portraitK, a = portrait.w / portrait.h;
  const pad = Math.max(8 * dpr, board.W * 0.015), top = Math.max(pad, board.topY * 0.6 + pad * 0.5), label = Math.round(Math.max(11 * dpr, Math.min(16 * dpr, board.H * 0.024)));
  // the biggest card whose right edge (label row included) stays left of lane 0; capped by the picture's own resolution
  const fullH = Math.min(board.H * 0.3, 200 * dpr, portrait.h * 1.6);
  const fits = h => pad + h * a + pad * 0.5 <= edgeX(0, Math.max(board.far, sAtY(top + h + label * 1.6)));
  let maxH = fullH; while (maxH > 30 * dpr && !fits(maxH)) maxH *= 0.94;
  const h = maxH * (0.62 + 0.38 * k);
  const hitAge = t - (r.partnerLastHit ?? -9), bounce = who === 'you' || reducedMotion.matches ? 0 : Math.max(0, 1 - hitAge / 0.16);
  const y = top - bounce * h * 0.05;
  if (k > 0.05 && settings.effects !== 'lite') {   // soft glow behind the card while syuP plays
    ctx.save(); ctx.globalAlpha = 0.35 * k; ctx.shadowColor = '#ff8fd8'; ctx.shadowBlur = 24 * dpr; ctx.fillStyle = '#ff8fd8';
    roundRect(ctx, pad, y, h * a, h, Math.min(h * a, h) * 0.16); ctx.fill(); ctx.restore();
  }
  const ring = who === 'partner' ? '#ff8fd8' : who === 'both' ? '#ffe27a' : 'rgba(200,220,255,0.55)';
  const w = drawPortraitCard(ctx, pad, y, h, ring, 0.55 + 0.45 * k);
  if (who !== 'you' && !reducedMotion.matches) {   // ♪ rising from the card for each recent syuP note
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `900 ${Math.round(h * 0.18)}px system-ui, sans-serif`;
    for (const e of r.portraitNotes || []) {
      const age = t - e.t0; if (age < 0 || age > 0.7) continue;
      ctx.globalAlpha = 1 - age / 0.7; ctx.fillStyle = LANE_COLORS[e.lane];
      ctx.fillText('♪', pad + w * (0.78 + 0.08 * Math.sin(e.lane * 2.1)), y + h * 0.15 - age * h * 0.5);
    }
    ctx.restore();
  }
  const text = r.rule?.labels?.[who] || (who === 'partner' ? '♪ syuP 演奏中' : who === 'both' ? '♪ TOGETHER' : 'YOUR TURN');
  ctx.save(); ctx.font = `900 ${label}px system-ui, sans-serif`;
  const maxW = Math.max(w, edgeX(0, Math.max(board.far, sAtY(y + h + label * 1.6))) - pad * 1.5), tw = ctx.measureText(text).width;
  if (tw > maxW) ctx.font = `900 ${Math.floor(label * maxW / tw)}px system-ui, sans-serif`;
  ctx.fillStyle = who === 'partner' ? '#ffd6f0' : who === 'both' ? '#fff0b8' : '#9fe9ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4 * dpr; ctx.fillText(text, pad, y + h + label * 0.35);
  ctx.restore();
}
const RELEASE_COLOR = '#ff8fd8';
// ECHO: far away an echo note is only an outline; it solidifies between depth 0.55 and 0.3 (≈ the last third of its fall)
const echoGhost = d => Math.max(0, Math.min(1, (d - 0.3) / 0.25));
function drawNotes(ctx, t, lite) {
  const r = run, noteH = Math.max(6, board.H * 0.03), visibleEnd = t + r.approach / r.scroll.minSpeed, inset = (board.nearW / LANES) * 0.2;
  // hold bodies first so heads sit on top
  for (let lane = 0; lane < LANES; lane++) {
    const q = r.lanes[lane];
    for (let i = r.laneHead[lane]; i < q.length; i++) {
      const n = q[i]; if (n.time > visibleEnd) break;
      if (n.state === DONE || !n.duration) continue;
      const holding = n.state === HOLDING, color = n.release ? RELEASE_COLOR : HOLD_COLOR;
      const dHead = holding ? 0 : Math.max(0, noteDepth(r, n, n.time, t)); if (dHead > 1) continue;
      const dTail = Math.min(1, Math.max(0, noteDepth(r, n, n.end, t)));
      const s0 = scaleAt(dHead), s1 = scaleAt(dTail), ghost = n.echo && !holding ? echoGhost(dHead) : 0;
      // CHAOS looks (tiny / big / faces) apply to the whole hold — head, body and tail — so one hold never looks half-changed.
      // Only the look changes: it is still the same hold, held and released exactly as before.
      const look = n.card ? { tiny: hasCard(n, 'tiny'), big: hasCard(n, 'big'), face: hasCard(n, 'faces') } : null, laneW = board.nearW / LANES;
      lanePath(ctx, lane, s1, s0, look?.tiny ? laneW * 0.34 : look?.big ? laneW * 0.07 : inset);
      const g = ctx.createLinearGradient(0, yAt(s1), 0, yAt(s0));
      const glow = holding ? 0.78 + 0.22 * Math.sin(performance.now() / 55) : 0.5;
      g.addColorStop(0, rgba(color, 0.32 * (1 - ghost))); g.addColorStop(1, rgba(color, glow * (1 - ghost * 0.85)));
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = rgba(n.release ? '#ffe0f4' : '#fff4c2', holding ? 0.95 : 0.5); ctx.lineWidth = Math.max(1, board.dpr); ctx.stroke();
      if (dTail < 1) n.release ? drawReleaseCap(ctx, lane, s1, noteH, holding && n.end - t < 0.4, ghost) : drawNoteBar(ctx, lane, s1, noteH * 0.6, HOLD_COLOR, lite, 0.9, false, 0, look && { tiny: look.tiny, big: look.big, face: look.face && 'tail' });
    }
  }
  for (let lane = 0; lane < LANES; lane++) {
    const q = r.lanes[lane];
    for (let i = r.laneHead[lane]; i < q.length; i++) {
      const n = q[i]; if (n.time > visibleEnd) break;
      if (n.state === DONE) continue;
      const d = n.state === HOLDING ? 0 : noteDepth(r, n, n.time, t);
      if (d < -0.12 || d > 1) continue;
      const deco = n.card ? { tiny: hasCard(n, 'tiny'), big: hasCard(n, 'big'), face: hasCard(n, 'faces'), lift: hopLift(r, n, t) } : null;
      drawNoteBar(ctx, laneShown(r, n, t), scaleAt(Math.max(d, -0.12)), noteH, n.duration ? (n.release ? RELEASE_COLOR : HOLD_COLOR) : LANE_COLORS[lane], lite, 1, n.state === HOLDING, n.echo && n.state !== HOLDING ? echoGhost(d) : 0, deco);
    }
  }
  if (r.partnerNotes.length) drawPartnerNotes(ctx, t, lite, noteH, inset);
}
const PARTNER_COLOR = '#ffc6e8';
function drawPartnerNotes(ctx, t, lite, noteH, inset) {
  const r = run, end = t + r.approach;
  for (let i = r.partnerHead; i < r.partnerNotes.length; i++) {
    const n = r.partnerNotes[i]; if (n.time > end) break;
    if (n.state === DONE || n.hidden) continue;
    const holding = n.state === HOLDING, dHead = holding ? 0 : Math.max(0, depthOf(r, n.time, t));
    if (n.duration) {
      const s0 = scaleAt(dHead), s1 = scaleAt(Math.min(1, Math.max(0, depthOf(r, n.end, t))));
      lanePath(ctx, n.lane, s1, s0, inset); ctx.fillStyle = rgba(PARTNER_COLOR, holding ? 0.45 : 0.25); ctx.fill();
    }
    if (!holding) drawNoteBar(ctx, n.lane, scaleAt(dHead), noteH, PARTNER_COLOR, true, n.silent ? 0.3 : 0.75, false, 0, { partner: n.mark || true });
  }
}
function drawNoteBar(ctx, lane, s, h, color, lite, alpha = 1, active = false, ghost = 0, deco = null) {
  const x0 = edgeX(lane, s), x1 = edgeX(lane + 1, s), widthK = deco?.tiny ? 0.45 : deco?.big ? 1 : 0.9, heightK = deco?.tiny ? 0.55 : deco?.big ? 2.3 : 1;
  const w = (x1 - x0) * widthK, x = (x0 + x1) / 2 - w / 2, hh = Math.max(4, h * s * heightK), y = yAt(s) - hh / 2 - (deco?.lift || 0) * (x1 - x0) * 0.45;
  ctx.save(); ctx.globalAlpha = alpha;
  if (ghost < 1) {
    ctx.globalAlpha = alpha * (1 - ghost);
    if (!lite) { ctx.shadowColor = color; ctx.shadowBlur = (active ? 22 : 10) * s * board.dpr; }
    const g = ctx.createLinearGradient(0, y, 0, y + hh);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, color); g.addColorStop(1, rgba(color, 0.85));
    ctx.fillStyle = g; roundRect(ctx, x, y, w, hh, hh * 0.45); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.85)'; roundRect(ctx, x + w * 0.08, y + hh * 0.3, w * 0.84, Math.max(1.5, hh * 0.18), hh * 0.1); ctx.fill();
  }
  if (deco?.face === 'tail' && ghost < 1) {   // CHAOS "faces" on a hold's end: relaxed ^ ^ eyes, no mouth — "and… let go"
    const cx = x + w / 2, cy = y + hh / 2, e = Math.max(2, Math.min(w * 0.06, hh * 0.32));
    ctx.globalAlpha = alpha; ctx.strokeStyle = '#1b2440'; ctx.lineWidth = Math.max(1, e * 0.45); ctx.lineCap = 'round';
    for (const dx of [-0.12, 0.12]) { ctx.beginPath(); ctx.moveTo(cx + w * dx - e, cy + e * 0.45); ctx.lineTo(cx + w * dx, cy - e * 0.45); ctx.lineTo(cx + w * dx + e, cy + e * 0.45); ctx.stroke(); }
  } else if (deco?.face && ghost < 1) {   // CHAOS "faces": purely decorative
    const cx = x + w / 2, cy = y + hh / 2, e = Math.max(1.2, hh * 0.13);
    ctx.globalAlpha = alpha; ctx.fillStyle = '#1b2440';
    ctx.beginPath(); ctx.arc(cx - w * 0.12, cy - hh * 0.05, e, 0, Math.PI * 2); ctx.arc(cx + w * 0.12, cy - hh * 0.05, e, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1b2440'; ctx.lineWidth = Math.max(1, e * 0.7); ctx.beginPath(); ctx.arc(cx, cy + hh * 0.02, Math.max(2, w * 0.07), 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
  if (deco?.partner) {   // syuP's note: white rim and a ♪
    ctx.globalAlpha = alpha; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, 1.5 * board.dpr * s); roundRect(ctx, x, y, w, hh, hh * 0.45); ctx.stroke();
    ctx.fillStyle = '#8a2c6a'; ctx.font = `900 ${Math.max(8, Math.round(hh * 0.95))}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(typeof deco.partner === 'string' ? deco.partner : '♪', x + w / 2, y + hh / 2 + 1);
  }
  if (ghost > 0) {   // echo outline
    ctx.globalAlpha = alpha * (0.35 + 0.4 * ghost); ctx.setLineDash([5 * board.dpr * s, 4 * board.dpr * s]);
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, 2 * board.dpr * s); roundRect(ctx, x, y, w, hh, hh * 0.45); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}
// RELEASE tail: a hollow cap with chevrons — "let go here"
function drawReleaseCap(ctx, lane, s, h, soon, ghost = 0) {
  const x0 = edgeX(lane, s), x1 = edgeX(lane + 1, s), w = (x1 - x0) * 0.94, x = (x0 + x1) / 2 - w / 2, hh = Math.max(6, h * 0.9 * s), y = yAt(s) - hh / 2;
  const pulse = soon ? 0.6 + 0.4 * Math.sin(performance.now() / 45) : 0;
  ctx.save(); ctx.globalAlpha = 1 - ghost * 0.6;
  ctx.fillStyle = rgba(RELEASE_COLOR, 0.28 + 0.3 * pulse); roundRect(ctx, x, y, w, hh, hh * 0.45); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, 2.5 * board.dpr * s); ctx.stroke();
  ctx.strokeStyle = rgba('#ffe0f4', 0.9); ctx.lineWidth = Math.max(1.5, 2 * board.dpr * s);
  const cx = x + w / 2, ch = hh * 0.55;
  for (const k of [0, 1]) { const cy = y - hh * 0.25 - k * ch * 0.9; ctx.beginPath(); ctx.moveTo(cx - w * 0.12, cy); ctx.lineTo(cx, cy - ch * 0.6); ctx.lineTo(cx + w * 0.12, cy); ctx.stroke(); }
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// Effects live in song time, so they freeze with pause and can be re-created deterministically for promo capture.
// 100-combo sparkles (board canvas, behind the number): a burst flying out to the ring in the first 0.9 s, then motes
// that keep drifting and twinkling around the number for the whole afterglow. Nothing is drawn near the judge line.
// LITE halves them; reduced motion draws none (the CSS glow alone carries it).
const MILE_PALETTE = { c: ['#fff7ae', '#ffe765', '#75e6da', '#ffffff'], v: ['#ffd2eb', '#ff79bf', '#fff7ae', '#ffffff'], k: ['#fff8c9', '#ffe765', '#ff79bf', '#75e6da', '#af78ff', '#ffffff'] };
const MILE_COUNT = { c: [36, 30], v: [54, 44], k: [76, 60] };   // [burst, afterglow motes]
function drawMilestoneSparkles(ctx, e, a, lite) {
  if (reducedMotion.matches || a > e.dur) return;
  const pal = MILE_PALETTE[e.grade], seed = Math.round(e.t0 * 1000), k = lite ? 0.5 : 1, R = e.r, floor = board.judgeY - (board.judgeY - e.y) * 0.45;
  const fadeAll = Math.min(1, (e.dur - a) / 0.5);
  const star = (x, y, sz, rot, color, alpha) => {
    if (alpha <= 0.01 || y > floor) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath(); ctx.moveTo(0, -sz * 1.7); ctx.lineTo(sz * 0.45, 0); ctx.lineTo(0, sz * 1.7); ctx.lineTo(-sz * 0.45, 0); ctx.closePath(); ctx.fill();
    ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(0, -sz * 1.1); ctx.lineTo(sz * 0.3, 0); ctx.lineTo(0, sz * 1.1); ctx.lineTo(-sz * 0.3, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  // burst
  const nb = Math.round(MILE_COUNT[e.grade][0] * k), life = 0.95;
  if (a < life) for (let i = 0; i < nb; i++) {
    const ang = (i / nb) * Math.PI * 2 + rand01(seed + i) * 0.4, sp = 0.45 + rand01(seed + i * 7) * 0.55, q = a / life;
    const d = R * sp * (1 - Math.pow(1 - q, 3)), x = e.x + Math.cos(ang) * d, y = e.y + Math.sin(ang) * d * 0.75 + R * 0.12 * q * q;
    const sz = (3 + rand01(seed + i * 3) * 4) * board.dpr * (1 - q * 0.4), alpha = (1 - q) * Math.min(1, q / 0.05 + 0.2);
    star(x, y, sz, q * 5 + i, pal[i % pal.length], alpha);
  }
  // afterglow motes: each lives 1 s, spawned through the celebration, drifting up around the number
  const nm = Math.round(MILE_COUNT[e.grade][1] * k), span = Math.max(0.1, e.dur - 1.0);
  for (let i = 0; i < nm; i++) {
    const born = 0.25 + (i / nm) * span, age = a - born; if (age < 0 || age > 1) continue;
    const ang = rand01(seed + 100 + i) * Math.PI * 2, rr = R * (0.25 + rand01(seed + 200 + i) * 0.7);
    const x = e.x + Math.cos(ang) * rr + Math.sin(age * 3 + i) * 6 * board.dpr, y = e.y + Math.sin(ang) * rr * 0.7 - age * R * 0.25;
    const tw = 0.55 + 0.45 * Math.sin(age * 14 + i * 1.7), alpha = Math.sin(Math.PI * age) * tw * fadeAll;
    star(x, y, (2.2 + rand01(seed + 300 + i) * 3) * board.dpr, age * 2 + i, pal[(i + 1) % pal.length], alpha);
  }
}
function drawEffects(ctx, t, lite) {
  const r = run, jy = board.judgeY, laneW = board.nearW / LANES;
  r.effects = r.effects.filter(e => t - e.t0 < (e.type === 'milestone' ? e.dur + 0.1 : 0.7) && t - e.t0 > -0.05);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let lane = 0; lane < LANES; lane++) {
    const q = r.lanes[lane];
    for (let i = r.laneHead[lane]; i < q.length && q[i].time <= t; i++) {
      if (q[i].state !== HOLDING) continue;
      const cx = (edgeX(lane, 1) + edgeX(lane + 1, 1)) / 2, k = 0.75 + 0.25 * Math.sin(t * 40), g = ctx.createRadialGradient(cx, jy, 0, cx, jy, laneW * 0.5);
      g.addColorStop(0, `rgba(255,250,220,${0.6 * k})`); g.addColorStop(0.4, rgba(HOLD_COLOR, 0.32 * k)); g.addColorStop(1, rgba(HOLD_COLOR, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, jy, laneW * 0.5, laneW * 0.2, 0, 0, Math.PI * 2); ctx.fill();
      for (let s = 0; s < 5; s++) { const ph = (t * 3 + s / 5) % 1, x = cx + (rand01(Math.floor(t * 3 + s / 5) * 13 + s + lane * 7) - 0.5) * laneW * 0.7, y = jy - ph * board.H * 0.14, sz = 2.5 * board.dpr * (1 - ph); ctx.fillStyle = `rgba(255,236,160,${1 - ph})`; ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz); }
    }
  }
  for (const e of r.effects) {
    const a = Math.max(0, t - e.t0), cx = (edgeX(e.lane, 1) + edgeX(e.lane + 1, 1)) / 2, color = LANE_COLORS[e.lane];
    if (e.type === 'milestone') { drawMilestoneSparkles(ctx, e, a, lite); continue; }
    if (e.type === 'miss') {
      const k = 1 - a / 0.35; if (k <= 0) continue;
      lanePath(ctx, e.lane, 0.82, 1);
      const g = ctx.createLinearGradient(0, yAt(0.82), 0, jy); g.addColorStop(0, 'rgba(255,49,95,0)'); g.addColorStop(1, `rgba(255,49,95,${0.45 * k})`);
      ctx.fillStyle = g; ctx.fill(); continue;
    }
    if (e.type === 'partner') {
      const k = 1 - a / 0.4; if (k <= 0) continue;
      ctx.strokeStyle = rgba(PARTNER_COLOR, 0.8 * k); ctx.lineWidth = Math.max(1.5, 2.5 * board.dpr * k); ctx.beginPath(); ctx.ellipse(cx, jy, laneW * (0.15 + a), laneW * (0.06 + a * 0.35), 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = rgba('#ffe6f5', k); ctx.font = `900 ${Math.round(laneW * 0.28)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('♪', cx, jy - a * board.H * 0.35 - laneW * 0.1);
      continue;
    }
    if (e.type === 'release') {
      const k = 1 - a / 0.45; if (k <= 0) continue;
      ctx.strokeStyle = rgba(RELEASE_COLOR, k); ctx.lineWidth = Math.max(2, 3 * board.dpr * k);
      for (let j = 0; j < 3; j++) { const yy = jy - (a * board.H * 0.5) - j * board.H * 0.035; ctx.beginPath(); ctx.moveTo(cx - laneW * 0.28, yy + laneW * 0.12); ctx.lineTo(cx, yy); ctx.lineTo(cx + laneW * 0.28, yy + laneW * 0.12); ctx.stroke(); }
    }
    const perfect = e.kind === 'PERFECT', strength = perfect ? 1 : e.kind === 'GREAT' ? 0.75 : 0.45, k = 1 - a / 0.42;
    if (k <= 0) continue;
    if (a < 0.2) {
      const h = board.H * (0.22 + 0.1 * strength) * (1 - a / 0.2);
      const g = ctx.createLinearGradient(0, jy - h, 0, jy); g.addColorStop(0, rgba(color, 0)); g.addColorStop(1, rgba(perfect ? '#fff6c8' : color, 0.5 * strength));
      ctx.fillStyle = g; ctx.fillRect(cx - laneW * 0.42, jy - h, laneW * 0.84, h);
    }
    const rad = laneW * (0.2 + a * 1.05) * (e.tail ? 1.25 : 1);
    ctx.strokeStyle = rgba(perfect ? '#fff3b0' : color, 0.9 * k * strength); ctx.lineWidth = Math.max(1.5, 3.5 * board.dpr * k);
    ctx.beginPath(); ctx.ellipse(cx, jy, rad, rad * 0.36, 0, 0, Math.PI * 2); ctx.stroke();
    if (a < 0.12) {
      const f = 1 - a / 0.12, g = ctx.createRadialGradient(cx, jy, 0, cx, jy, laneW * 0.55);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * f})`); g.addColorStop(0.4, rgba(color, 0.5 * f)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, jy, laneW * 0.55, laneW * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (!lite || perfect) {
      const n = lite ? 5 : perfect ? 12 : 7, seed = e.t0 * 977 + e.lane * 31;
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + (rand01(seed + i) - 0.5) * 2.4, sp = (0.5 + rand01(seed + i * 7) * 0.9) * board.H * 0.9;
        const x = cx + Math.cos(ang) * sp * a, y = jy + Math.sin(ang) * sp * a + board.H * 1.1 * a * a;
        const size = (1.5 + rand01(seed + i * 3) * 2.5) * board.dpr * k;
        ctx.fillStyle = i % 3 === 0 ? `rgba(255,255,255,${k})` : rgba(color, k);
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
  }
  ctx.restore();
}

function drawVisualizer(ctx, perf) {
  if (!sound.analyser || !sound.freq || run.paused) return;
  if (perf - vizLast > 33) {
    vizLast = perf; sound.analyser.getByteFrequencyData(sound.freq);
    for (let side = 0; side < 2; side++) for (let i = 0; i < 8; i++) {
      const band = side === 0 ? 0.01 + i / 7 * 0.25 : 0.05 + i / 7 * 0.3, v = sound.freq[Math.floor(band * (sound.freq.length - 1))] / 255;
      const idx = side * 8 + i; vizLevels[idx] = v > vizLevels[idx] ? v : vizLevels[idx] * 0.86;
    }
  }
  const { W, H } = board;
  for (let side = 0; side < 2; side++) for (let i = 0; i < 8; i++) {
    const level = vizLevels[side * 8 + i], depth = i / 7, s = 1 - depth * 0.38;
    const laneEdge = side === 0 ? edgeX(0, s) : edgeX(LANES, s), room = side === 0 ? laneEdge : W - laneEdge;
    if (room < 14) continue;
    const bw = Math.max(3, room * 0.14 * s), x = side === 0 ? laneEdge - room * 0.2 - bw : laneEdge + room * 0.2;
    const y0 = yAt(s), h = Math.min(H, W * 1.1) * (0.04 + level * 0.36) * s;
    const g = ctx.createLinearGradient(0, y0 - h, 0, y0);
    g.addColorStop(0, side ? 'rgba(255,220,250,0.9)' : 'rgba(195,255,255,0.9)'); g.addColorStop(0.3, side ? 'rgba(255,104,210,0.7)' : 'rgba(83,231,255,0.7)'); g.addColorStop(1, 'rgba(60,60,200,0.05)');
    ctx.fillStyle = g; ctx.globalAlpha = 0.5 * (1 - depth * 0.4); ctx.fillRect(x, y0 - h, bw, h); ctx.globalAlpha = 1;
  }
}

// ───────────────────────────── play flow ─────────────────────────────
let rafId = 0, shownScore = 0, playTimers = [];
const later = (fn, ms) => { const id = setTimeout(fn, ms); playTimers.push(id); return id; };
const promoParams = new URLSearchParams(location.search);
const promoMode = promoParams.get('promo') === '1';

function updateHud() {
  if (!run) return;
  const combo = run.combo, display = $('#combo-display');
  const celebrating = display.classList.contains('milestone');   // the number stays on 100 / 200 / … meanwhile
  if (celebrating && combo === 0) return endComboMilestone();   // a MISS ends the celebration at once
  display.hidden = combo < 5;
  if (combo >= 5 && !celebrating) {
    $('#combo-number').textContent = combo;
    display.classList.remove('pop'); void display.offsetWidth; display.classList.add('pop');
    display.dataset.tier = combo >= 300 ? '3' : combo >= 200 ? '2' : combo >= 100 ? '1' : '0';
  }
  const hp = run.hp, fill = $('#hp-fill');
  fill.style.width = `${hp}%`; $('#hp-value').textContent = hp;
  $('#hp-widget').classList.toggle('danger', hp <= 25);
  $('#hp-widget').classList.toggle('nofail', run.noFailUsed);
}
function tickScore() {
  if (!run) return;
  const target = scoreOf(run);
  if (shownScore !== target) { shownScore = target - shownScore < 30 ? target : Math.round(shownScore + (target - shownScore) * 0.3); $('#hud-score').textContent = shownScore.toLocaleString('en-US'); }
}
function showJudgement(kind, delta, release = false) {
  const el = $('#judgement');
  el.querySelector('b').textContent = kind;
  const small = el.querySelector('small');
  if (settings.timingDisplay && delta !== null && kind !== 'PERFECT' && kind !== 'MISS') {
    small.textContent = `${release ? 'RELEASE ' : ''}${delta < 0 ? 'FAST' : 'SLOW'} ${delta < 0 ? '-' : '+'}${Math.round(Math.abs(delta) * 1000)}ms`; small.className = delta < 0 ? 'fast' : 'slow';
  } else if (release && kind !== 'MISS') { small.textContent = 'RELEASE'; small.className = 'release'; }
  else { small.textContent = ''; small.className = ''; }
  el.className = 'judgement'; void el.offsetWidth; el.className = `judgement show ${kind.toLowerCase()}`;
}
const CHAOS_CARDS = {
  hop: { icon: '⤴', name: 'ぴょんぴょん', text: '一部のノーツが途中で隣のレーンへ跳ねる。着地したレーンで叩く' },
  shuffle: { icon: '⇄', name: 'シャッフル', text: '「SHUFFLE!」の合図で、流れてくるノーツがレーンを入れ替える' },
  march: { icon: '♩', name: 'マーチ', text: 'ノーツが拍に合わせて行進する（止まって、進む）。叩く時刻はいつも通り' },
  tiny: { icon: '・', name: 'ちびノーツ', text: 'ノーツが小さくなる' },
  big: { icon: '■', name: 'でかノーツ', text: 'ノーツが大きくなる' },
  faces: { icon: '☺', name: 'かおノーツ', text: 'ノーツに顔がつく。それだけ' },
  wobble: { icon: '〜', name: 'ゆらゆら', text: '盤面がゆったり揺れる（判定ラインはほぼ動かない）' },
  visit: { icon: '♥', name: 'syuPが来た', text: 'syuPがレーンに座り込む。ノーツは後ろから出てくる' },
  rest: { icon: '☕', name: 'ひとやすみ', text: '何も起きない。深呼吸' }
};
function announceCard(card) {
  const el = $('#chaos-card'); if (!el) return;
  const items = card.cards.map(c => CHAOS_CARDS[c] || CHAOS_CARDS.rest);
  el.innerHTML = `<small>${card.cards.length > 1 ? 'CHAOS PARTY!' : 'CHAOS CARD'}</small>${items.map(i => `<div><b><i>${i.icon}</i>${i.name}</b><span>${i.text}</span></div>`).join('')}`;
  el.hidden = false; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(el.timer); el.timer = setTimeout(() => { el.hidden = true; }, 2600);
}
function showCue(text, kind) { const c = $('#stage-cue'); if (!c) return; c.textContent = text; c.className = `stage-cue ${kind}`; void c.offsetWidth; c.classList.add('show'); }
// 100-combo milestones — impact, then afterglow. The counter shows "100 COMBO!" (200, 300 …) for the whole celebration
// while the real combo keeps counting underneath (updateHud leaves the number alone while .milestone is on); then the
// latest combo takes over. Rings and a halo live in their own layer (#mile-fx) BEHIND the number; sparkles are drawn on
// the board canvas. One duration per grade drives the CSS (--mile-dur) and the JS timer, so they cannot drift apart.
// Size: up to ×2.2 / ×2.5 / ×2.8, but never wider than the board nor reaching down towards the judge line (rings stop
// at 40 % of the distance to it). A MISS ends everything at once.
const MILESTONE = { c: { ms: 1800, scale: 2.2 }, v: { ms: 2200, scale: 2.5 }, k: { ms: 2600, scale: 2.8 } };
const mileGrade = combo => combo % 1000 === 0 ? 'k' : combo % 500 === 0 ? 'v' : 'c';
function mileLayer() {
  let fx = $('#mile-fx');
  if (!fx) { fx = document.createElement('div'); fx.id = 'mile-fx'; fx.className = 'mile-fx'; fx.innerHTML = '<i class="halo"></i><i class="ring r1"></i><i class="ring r2"></i><i class="ring r3"></i>'; $('#game').insertBefore(fx, $('#combo-display')); }
  return fx;
}
function mileGeometry(grade) {
  const game = $('#game').getBoundingClientRect(), b = $('#combo-number'), d = $('#combo-display');
  const prev = d.style.transform; d.style.transform = 'none';   // measure the number at its normal size
  const nb = b.getBoundingClientRect(), db = d.getBoundingClientRect(); d.style.transform = prev;
  const cx = nb.left + nb.width / 2 - game.left, cy = (db.top + db.height / 2) - game.top, judge = board.judgeY / board.dpr;
  const room = Math.max(40, judge - cy);                                   // vertical room between the number and the judge line
  // caps (the burst overshoots the peak by 10 %): board width, room above the judge line, and a per-device height limit
  const wCap = game.width * 0.9 / Math.max(1, nb.width) / 1.1, hCap = (room * 0.7) / Math.max(1, db.height / 2) / 1.1;
  const sizeCap = (game.width < 600 ? 0.24 : 0.3) * game.height / Math.max(1, nb.height) / 1.1;   // phone / PC
  const peak = Math.max(1.3, Math.min(MILESTONE[grade].scale, wCap, hCap, sizeCap));
  const ring = Math.max(120, Math.min(game.width * 0.96, room * 2 * 0.8, game.height * 0.9));
  return { cx, cy, peak, ring };
}
function showComboMilestone(combo, t0 = clockNow()) {
  const d = $('#combo-display'), grade = mileGrade(combo), m = MILESTONE[grade], fx = mileLayer();
  if (d.classList.contains('milestone') && d.dataset.mileCombo === String(combo)) return run.mileGeo;   // already on (frame capture)
  d.hidden = false; d.classList.remove('pop', 'milestone'); fx.classList.remove('on');
  $('#combo-number').textContent = combo; d.querySelector('span').textContent = 'COMBO!';
  const g = mileGeometry(grade); run.mileGeo = g;
  for (const el of [d, fx]) { el.dataset.mile = grade; el.style.setProperty('--mile-dur', `${m.ms}ms`); }
  d.dataset.mileCombo = combo; d.style.setProperty('--mile-peak', g.peak.toFixed(2));
  fx.classList.toggle('lite', settings.effects === 'lite');
  fx.style.left = `${g.cx}px`; fx.style.top = `${g.cy}px`; fx.style.setProperty('--ring', `${Math.round(g.ring)}px`);
  void d.offsetWidth; d.classList.add('milestone'); fx.classList.add('on');
  if (!run.capture) {   // live play: the timer ends it; sparkles go on the board
    clearTimeout(d.mileTimer); d.mileTimer = setTimeout(endComboMilestone, m.ms);
    run.effects.push({ type: 'milestone', grade, lane: 0, t0, dur: m.ms / 1000, x: g.cx * board.dpr, y: g.cy * board.dpr, r: g.ring / 2 * board.dpr });
  }
  return g;
}
function endComboMilestone() {
  const d = $('#combo-display'), fx = $('#mile-fx'); clearTimeout(d.mileTimer);
  d.classList.remove('milestone'); delete d.dataset.mileCombo; d.querySelector('span').textContent = 'COMBO';
  if (fx) fx.classList.remove('on');
  if (run) { run.effects = run.effects.filter(e => e.type !== 'milestone'); updateHud(); }
}
// frame capture (promo video): put every part of the celebration at age a (seconds)
function seekComboMilestone(a) {
  for (const root of [$('#combo-display'), $('#mile-fx')]) if (root) for (const an of root.getAnimations({ subtree: true })) { an.pause(); an.currentTime = a * 1000; }
}
function showBanner(html, kind = '', ms = 0) {
  const b = $('#stage-banner'); b.innerHTML = html; b.className = `stage-banner ${kind}`; b.hidden = false;
  if (ms) later(() => { b.hidden = true; }, ms);
}

const art = { active: false, canvas: null, ctx: null, color: null, gray: null, C: 8, R: 24, size: 360, cells: [], dur: 1, rowsDone: -1 };
function artCell(lane, time) {
  const row = Math.max(0, Math.min(art.R - 1, Math.floor(time / art.dur * art.R)));
  return art.cells[row * art.C + lane * 2 + (Math.floor(time * 4) % 2)];
}
function artSetup(r) {
  art.active = false;
  const canvas = $('#work-canvas'); canvas.hidden = true; $('#work-jacket').hidden = false;
  if (!r.canvasSpec) return;
  Object.assign(art, { C: r.canvasSpec.cols || 8, R: r.canvasSpec.rows || 24, dur: r.song.duration || r.chart.duration || 1, rowsDone: -1, canvas, ctx: canvas.getContext('2d') });
  canvas.width = canvas.height = art.size;
  art.cells = Array.from({ length: art.C * art.R }, (_, i) => ({ i, need: 0, got: 0 }));
  for (const n of r.notes) { if (n.partner) continue; artCell(n.lane, n.time).need++; if (n.duration) artCell(n.lane, n.end).need++; }
  // SPECIAL art: a song may name its own hidden illustration (songs.json "specialArt"); without one — or if it fails to
  // load — the normal jacket is painted instead. The jacket itself is never changed anywhere else.
  const img = new Image(); let usedSrc = r.song.specialArt || r.song.jacket;
  img.onload = () => {
    if (run !== r) return;
    const c = document.createElement('canvas'); c.width = c.height = art.size; const x = c.getContext('2d');
    const side = Math.min(img.naturalWidth, img.naturalHeight);   // cover-crop: non-square pictures are centred, never squashed
    x.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, art.size, art.size);
    art.color = c; art.src = usedSrc; art.hiddenArt = usedSrc === r.song.specialArt;
    const g2 = document.createElement('canvas'); g2.width = g2.height = art.size; const gx = g2.getContext('2d');
    try {
      if (art.hiddenArt) {   // a picture nobody has seen yet: only a dark, coarse mosaic hint until it is played into view
        const m = document.createElement('canvas'); m.width = m.height = 12; m.getContext('2d').drawImage(c, 0, 0, 12, 12);
        gx.imageSmoothingEnabled = false; gx.drawImage(m, 0, 0, art.size, art.size);
        const d = gx.getImageData(0, 0, art.size, art.size), p = d.data;
        for (let i = 0; i < p.length; i += 4) { const v = (p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11) * 0.22 + 22; p[i] = v * 0.9; p[i + 1] = v * 0.92; p[i + 2] = v * 1.25; }
        gx.putImageData(d, 0, 0);
      } else {
        const d = x.getImageData(0, 0, art.size, art.size), p = d.data; for (let i = 0; i < p.length; i += 4) { const v = (p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11) * 0.45 + 18; p[i] = p[i + 1] = p[i + 2] = v; } gx.putImageData(d, 0, 0);
      }
    }
    catch { gx.fillStyle = '#1c2236'; gx.fillRect(0, 0, art.size, art.size); }
    art.gray = g2;
    art.ctx.drawImage(g2, 0, 0); art.active = true; canvas.hidden = false; $('#work-jacket').hidden = true;
    for (const cell of art.cells) if (cell.got || cell.i < (art.rowsDone + 1) * art.C) artPaintCell(cell);   // anything judged before the picture arrived
  };
  img.onerror = () => { if (run === r && usedSrc !== r.song.jacket) { usedSrc = r.song.jacket; img.src = usedSrc; } };
  img.src = usedSrc;
}
function artPaintCell(cell) {
  if (!art.color) return;
  const cw = art.size / art.C, ch = art.size / art.R, col = cell.i % art.C, row = Math.floor(cell.i / art.C), x = col * cw, y = (art.R - 1 - row) * ch;
  const k = cell.need ? Math.min(1, cell.got / cell.need) : 1;
  art.ctx.drawImage(art.gray, x, y, cw, ch, x, y, cw, ch);
  art.ctx.globalAlpha = k; art.ctx.drawImage(art.color, x, y, cw, ch, x, y, cw, ch); art.ctx.globalAlpha = 1;
}
function artJudge(note, tail, kind) {
  const cell = artCell(note.lane, tail ? note.end : note.time); if (!cell) return;
  cell.got += JUDGE_WEIGHT[kind]; cell.judged = (cell.judged || 0) + 1; artPaintCell(cell);
}
function artTick(t) {   // rows the song has passed: cells nobody had to play are filled in for free
  const row = Math.floor(t / art.dur * art.R) - 1;
  while (art.rowsDone < Math.min(row, art.R - 1)) { art.rowsDone++; for (let c = 0; c < art.C; c++) { const cell = art.cells[art.rowsDone * art.C + c]; if (!cell.need) artPaintCell(cell); } }
}
const artPercent = () => art.cells.length ? art.cells.reduce((s, c) => s + (c.need ? Math.min(1, c.got / c.need) : 1), 0) / art.cells.length : 0;
function fillWorkPanel(song, diff) {
  $('#work-jacket').src = song.jacket;
  $('#work-title').textContent = song.title;
  $('#work-description').textContent = song.description;
  $('#work-artist').textContent = song.artist;
  $('#work-genre').textContent = song.genre;
  $('#work-bpm').textContent = `${song.bpm} BPM`;
  $('#work-chart').innerHTML = `${diff.toUpperCase()} ${starMarkup(levelOf(song, diff))}`;
  $('#hud-difficulty').textContent = diff.toUpperCase();
  $('#hud-difficulty').dataset.diff = diff;
  $('#hud-level').textContent = `Lv.${levelOf(song, diff)}`;
  const rec = getRecord(song.id, diff);
  $('#work-best').textContent = rec?.best ? `${rec.best.toLocaleString('en-US')}  ${rec.rank}  ${rec.lamp >= 3 ? LAMPS[rec.lamp] : ''}` : '—';
  setAmbient(song.jacket, true);
}

let starting = false;
async function startGame() {
  const song = songs[sel.song], diff = currentDiff(song);
  if (!song || !diff || starting) return;
  starting = true;
  stopPreview();
  let chart, rulePlugin = null;
  try { chart = await loadChart(song.charts[diff]); rulePlugin = await loadRule(chart.rule); } catch (error) { console.error(error); toast('譜面を読み込めませんでした'); starting = false; return; }
  finally { setTimeout(() => { starting = false; }, 0); }
  if (!promoMode) { ensureAudio(); connectMusic(); }
  cleanupRun();
  run = buildRun(song, diff, chart, { autoPlay: sel.autoPlay || promoMode, promo: promoMode });
  run.rule = rulePlugin;
  artSetup(run);
  ruleCall('setup');
  if (run.turns.length || run.cards.length) loadPortrait(song.partnerImage || data.settings?.partnerImage);
  gameEvents.runStart.forEach(fn => fn({ songId: song.id, difficultyId: diff, autoPlay: run.autoPlay }));
  shownScore = 0; $('#hud-score').textContent = '0';
  if (!audio.src.endsWith(song.audio)) audio.src = song.audio;
  audio.playbackRate = 1; if ('preservesPitch' in audio) audio.preservesPitch = true;
  try { audio.currentTime = 0; } catch {}
  applyVolumes();
  fillWorkPanel(song, diff);
  $('#pause-menu').hidden = true; $('#countdown').hidden = true; $('#judgement').className = 'judgement';
  show('play');
  resizeBoard(); updateHud();
  const lead = Math.max(LEAD_IN, run.approach + 0.6 - run.firstNote);
  clock.running = false; clock.audioLocked = false; clock.frozenAt = -lead;
  if (promoMode) return startPromo();
  const thisRun = run;
  const totalPlays = Object.values(saveData.songs).reduce((sum, s) => sum + Object.values(s).reduce((a, r) => a + (r.plays || 0), 0), 0);
  const howTo = totalPlays < 3 && !run.autoPlay ? `<p class="howto">${coarsePointer.matches ? 'レーンをタップ' : `${laneKeys().map(keyLabel).join(' ')} キー`}でノーツを叩く ／ <span>黄色いノーツ</span>は離さず押し続ける</p>` : '';
  const mech = mechanicsIntro(run);
  const hold = mech ? (mech.long ? 3600 : 2000) : howTo ? 2600 : 1300;
  showBanner(`<small>${diffDef(diff).label}${run.autoPlay ? ' · AUTO' : ''}${run.dev ? ' · syuP MODE' : ''}</small>${starMarkup(levelOf(song, diff))}<b>${escapeHtml(song.title)}</b><em>READY</em>${mech ? mech.html : howTo}`, `intro${mech?.long ? ' long' : ''}`, hold);
  later(() => { if (run === thisRun) { run.started = true; clockStart(-lead); } }, hold - 400);
  cancelAnimationFrame(rafId); rafId = requestAnimationFrame(frame);
}
// ───────── rule plugins (future SPECIAL / CHAOS formats) ─────────
// The built-in formats (SESSION = turns/partner/canvas, ROULETTE = cards) are driven by chart data and need no plugin.
// A new format is one file in mod/rules/<id>.js plus its generator in mod-tools/rules/<id>.js; a chart opts in with
// "rule": "<id>". Hooks only ever see/alter that run, so one song's rule can never leak into another chart.
// Plugin shape (every hook optional):
//   intro: { key: { label, text } }          rule-explanation chips shown before play (key listed in chart.mechanics)
//   labels / cues: { partner, you, both }     texts for the SPECIAL turn portrait / turn cues
//   setup(api)  update(api, t)  draw(api, ctx, t)  cleanup(api)
//   judge(api, note, kind, { delta, tail, release })      after the normal judgement (cannot change it)
//   result(api, res) → { small, title, ja, em, celebrate (0-5), party, bloom }      the mode panel on the result screen
//   save(api, rec, res)   persistent per-song stats; put what BONUS TRACK should show in rec.ruleStats = { label: value }
const BUILTIN_RULES = new Set(['session', 'roulette']);
const SyupRules = window.SyupRules = { plugins: {}, register(id, plugin) { this.plugins[id] = plugin; Object.assign(MECHANICS, plugin.intro || {}); } };
const ruleLoads = {};
function loadRule(id) {
  if (!id || BUILTIN_RULES.has(id)) return Promise.resolve(null);
  if (!/^[a-z0-9-]+$/.test(id)) return Promise.reject(new Error(`bad rule id ${id}`));
  if (SyupRules.plugins[id]) return Promise.resolve(SyupRules.plugins[id]);
  return ruleLoads[id] ||= new Promise((resolve, reject) => {
    const el = document.createElement('script'); el.src = `rules/${id}.js`;
    el.onload = () => SyupRules.plugins[id] ? resolve(SyupRules.plugins[id]) : reject(new Error(`rule ${id} did not register`));
    el.onerror = () => { delete ruleLoads[id]; reject(new Error(`rule ${id} not found`)); };
    document.head.appendChild(el);
  });
}
const ruleApi = {
  get run() { return run; }, LANES, LANE_COLORS, board, edgeX, yAt, scaleAt, sAtY, lanePath, roundRect, rgba, ease,
  depthOf: (time, t) => depthOf(run, time, t), drawNoteBar, drawPortraitCard, portrait, showCue,
  lite: () => settings.effects === 'lite', reduced: () => reducedMotion.matches, effect: e => run && run.effects.push(e)
};
function ruleCall(name, ...args) { const p = run?.rule; if (!p || typeof p[name] !== 'function') return undefined; try { return p[name](ruleApi, ...args); } catch (e) { console.warn(`rule hook ${name}`, e); return undefined; } }
const MECHANICS = {
  duet: { label: 'DUET', text: 'ピンクの♪ノーツは syuP が演奏。「YOUR TURN!」であなたの番、サビは一緒に' },
  canvas: { label: 'CANVAS', text: 'あなたが叩いた音がジャケットを塗っていく。ミスした所だけ色が抜ける' },
  roulette: { label: 'CHAOS CARD', text: '曲の区間ごとにカードが1枚。1小節前に予告される。叩くタイミングは常にいつも通り' },
  release: { label: 'RELEASE', text: '桃色のロングは「離す瞬間」も判定。終点の印で指を離す' },
  echo: { label: 'ECHO', text: '少し前と同じフレーズは輪郭だけで流れ、手前で実体化する' },
  surge: { label: 'SURGE', text: '曲の盛り上がりで流れる速さが変わる（タイミングは同じ）' }
};
function mechanicsIntro(r) {
  if (!r.mechanics.length) return null;
  const seenMap = (saveData.mechSeenBy ||= {}), seen = r.diff === 'extreme' ? (saveData.mechSeen || 0) : (seenMap[r.diff] || 0), long = seen < 3;
  if (!r.autoPlay && !r.dev) { if (r.diff === 'extreme') saveData.mechSeen = seen + 1; else seenMap[r.diff] = seen + 1; persist(); }
  const chips = r.mechanics.filter(m => MECHANICS[m]).map(m => `<span class="mech-chip${m === (r.character || '').toLowerCase() ? ' lead' : ''}"><b>${MECHANICS[m].label}</b>${long ? `<i>${MECHANICS[m].text}</i>` : ''}</span>`).join('');
  return { long, html: `<div class="mech-intro">${r.character ? `<p>この曲の ${diffDef(r.diff).label} は <b>${r.character}</b>${r.diff === 'chaos' ? ' デッキ' : ' 型'}</p>` : ''}${chips}</div>` };
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function startMusic(fromSongTime) {
  const r = run; r.musicStarted = true;
  clock.audioLocked = false; clock.waitAt = fromSongTime; clock.audioStartPos = audio.currentTime;
  const p = audio.play();
  if (p) p.catch(error => {
    if (run !== r) return;
    console.warn('Playback blocked', error);
    pauseGame(); toast('タップまたはキーで再開してください');
  });
}

function frame(perf) {
  if (screen !== 'play' || !run || run.capture) return;
  rafId = requestAnimationFrame(frame);
  const r = run;
  if (r.started && !r.paused && !r.ended) {
    const zero = -outputLatency() - offsetSec();
    if (!r.musicStarted && clockNow(perf) >= zero) startMusic(zero);
    if (r.musicStarted && !clock.audioLocked && clockNow(perf) > clock.waitAt) clockSet(clock.waitAt, perf);   // wait for the first audio frames
    syncClock(perf);
    const t = clockNow(perf);
    updateJudgements(t);
    ruleCall('update', t);
    const ch = r.scroll.changes[r.speedIdx];
    const beat = 60 / r.bpm, bar = beat * r.beatsPerBar;
    const tn = r.turns[r.turnIdx];
    if (tn && t >= tn.time - beat) { r.turnIdx++; showCue(r.rule?.cues?.[tn.who] || (tn.who === 'partner' ? '♪ syuP の番' : tn.who === 'both' ? 'TOGETHER!' : 'YOUR TURN!'), `turn-${tn.who}`); }
    const cd = r.cards[r.cardIdx];
    if (cd && t >= cd.start - bar) { r.cardIdx++; announceCard(cd); }
    const cur = activeCard(r, t);
    if (cur?.deals) { const dl = cur.deals.find(x => x > (r.lastDeal ?? -1) && t >= x); if (dl !== undefined) { r.lastDeal = dl; showCue('SHUFFLE!', 'shuffle'); } }
    if (art.active) artTick(t);
    if (ch && t >= ch.time) { r.speedIdx++; showCue(ch.speed > 1.01 ? `SURGE ×${ch.speed}` : ch.speed < 0.99 ? `BREATH ×${ch.speed}` : 'FLOW ×1', ch.speed > 1.01 ? 'surge' : 'breath'); }
    if (!r.ended && r.judged >= r.objects && t > r.lastEnd + 0.9) finishSong();
    else if (!r.ended && audio.ended && t > r.lastEnd) finishSong();
  }
  if (r.ended && r.finishing && !audio.paused) syncClock(perf);
  tickScore();
  drawBoard(clockNow(perf), perf);
}

function finishSong() {
  const r = run; r.ended = true; r.finishing = true;
  const lamp = r.failed ? 1 : r.counts.MISS === 0 ? (r.counts.PERFECT === r.objects ? 4 : 3) : 2;
  r.lamp = lamp;
  const label = { 1: 'FAILED', 2: 'CLEAR!', 3: 'FULL COMBO!', 4: 'ALL PERFECT!' }[lamp];
  showBanner(`<b>${label}</b>`, `finish lamp-${lamp}`);
  if (lamp >= 2) playChime(lamp === 4 ? [784, 988, 1175, 1568] : lamp === 3 ? [659, 880, 1109, 1319] : [523, 659, 784], 0.09, 0.8);
  fadeMusic(2.2);
  later(() => showResult(), 2600);
}
function gameOver() {
  const r = run; if (r.ended) return;
  r.ended = true; r.lamp = 1;
  releaseAllLanes();
  showBanner('<b>GAME OVER</b>', 'finish gameover');
  // tape-stop: the song winds down instead of cutting out
  if ('preservesPitch' in audio) audio.preservesPitch = false;
  const t0 = performance.now(), stop = () => { const k = (performance.now() - t0) / 900; if (run !== r) return; if (k >= 1) { audio.pause(); clockStop(); return; } const rate = Math.max(0.25, 1 - k * 0.75); audio.playbackRate = rate; clockSet(clockNow()); clock.rate = rate; requestAnimationFrame(stop); };
  stop();
  later(() => showResult(), 2000);
}
function fadeMusic(seconds) {
  if (sound.musicGain && sound.ctx) { const g = sound.musicGain.gain, now = sound.ctx.currentTime; g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0.0001, now + seconds); }
  else { const v0 = audio.volume, t0 = performance.now(), step = () => { const k = (performance.now() - t0) / (seconds * 1000); audio.volume = Math.max(0, v0 * (1 - k)); if (k < 1 && !audio.paused) requestAnimationFrame(step); }; step(); }
}

function pauseGame() {
  const r = run; if (!r || r.paused || r.ended || screen !== 'play') return;
  r.paused = true; clockStop(); audio.pause(); releaseAllLanes();
  $('#countdown').hidden = true;
  playTimers.forEach(clearTimeout); playTimers = [];
  if (!r.started) { r.started = true; clock.running = false; }
  $('#stage-banner').hidden = true;
  $('#pause-menu').hidden = false; menuFocus($('#pause-menu'), 0);
}
function resumeGame() {
  const r = run; if (!r || !r.paused) return;
  $('#pause-menu').hidden = true;
  const steps = ['3', '2', '1'], el = $('#countdown'); let i = 0;
  const tick = () => {
    if (run !== r || !r.paused) return;
    if (i === steps.length) {
      el.hidden = true; r.paused = false;
      const t = clock.frozenAt, audioPos = t + outputLatency() + offsetSec();
      r.regrabUntil = t + 0.35;   // holds interrupted by the pause can be grabbed again
      clockStart(t);
      if (r.musicStarted) { try { audio.currentTime = Math.max(0, audioPos); } catch {} startMusic(t); }
      return;
    }
    el.textContent = steps[i++]; el.hidden = false; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    later(tick, 650);
  };
  tick();
}
function releaseAllLanes() { for (let i = 0; i < LANES; i++) heldLanes[i] = false; pointerLanes.clear(); }
function cleanupRun() {
  playTimers.forEach(clearTimeout); playTimers = [];
  cancelAnimationFrame(rafId);
  audio.pause(); audio.playbackRate = 1;
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  if (sound.musicGain && sound.ctx) { const g = sound.musicGain.gain; g.cancelScheduledValues(sound.ctx.currentTime); }
  applyVolumes();
  releaseAllLanes();
  clock.running = false; clock.audioLocked = false;
  $('#stage-banner').hidden = true; $('#pause-menu').hidden = true; $('#countdown').hidden = true; $('#combo-display').hidden = true;
  { const d = $('#combo-display'); clearTimeout(d.mileTimer); d.classList.remove('milestone'); delete d.dataset.mileCombo; d.querySelector('span').textContent = 'COMBO'; $('#mile-fx')?.classList.remove('on'); }   // no celebration carries over
  const card = $('#chaos-card'); if (card) { card.hidden = true; clearTimeout(card.timer); }
  if (run?.rule) ruleCall('cleanup');
  run = null;
}

// ── promo capture (?promo=1&song=N&difficulty=hard&start=S&duration=D): autoplay, portrait, no UI chrome
function startPromo() {
  const song = run.song, start = Math.max(0, Number(promoParams.get('start') ?? song.promoStart ?? 0) || 0), duration = Math.max(1, Number(promoParams.get('duration') ?? song.promoDuration ?? 30) || 30);
  const r = run;
  const go = () => {
    r.started = true; r.musicStarted = true; clock.audioLocked = false; clock.waitAt = start; clock.audioStartPos = start; clockStart(start);
    audio.play().then(() => later(() => { if (run === r) { r.ended = true; audio.pause(); } }, duration * 1000)).catch(() => {
      r.started = false; const resume = () => { document.removeEventListener('pointerdown', resume); document.removeEventListener('keydown', resume); go(); };
      document.addEventListener('pointerdown', resume); document.addEventListener('keydown', resume);
    });
  };
  for (const n of r.notes) if (n.end < start) n.state = DONE;   // skip what came before the excerpt
  const seek = () => { try { audio.currentTime = start; } catch {} };
  if (audio.readyState >= 1) seek(); else audio.addEventListener('loadedmetadata', seek, { once: true });
  audio.addEventListener('seeked', go, { once: true });
  cancelAnimationFrame(rafId); rafId = requestAnimationFrame(frame);
}
// Deterministic frame for offline video capture: state and effects are pure functions of t.
function renderFrameAt(t, { deterministic = false, promoStart = null } = {}) {
  if (!run) return null;
  if (deterministic) {
    // offline capture owns the board from now on: stop the live loop and the music so frames are not overdrawn
    if (!run.capture) { run.capture = true; cancelAnimationFrame(rafId); audio.pause(); clockStop(); playTimers.forEach(clearTimeout); playTimers = []; }
    const from = Number.isFinite(promoStart) ? promoStart : t, r = run;
    let hits = 0;
    r.effects = [];
    for (const n of r.notes) {
      if (n.end < t && n.time < t) { n.state = DONE; } else if (n.duration && n.time <= t) n.state = HOLDING; else n.state = n.time <= t ? DONE : PENDING;
      if (n.time >= from && n.time <= t) { hits++; if (t - n.time < 0.5) r.effects.push({ type: 'hit', kind: 'PERFECT', lane: n.lane, t0: n.time }); }
      if (n.duration && n.end >= from && n.end <= t) { hits++; if (t - n.end < 0.5) r.effects.push({ type: 'hit', kind: 'PERFECT', lane: n.lane, t0: n.end, tail: true }); }
    }
    r.laneHead = [0, 0, 0, 0]; r.combo = hits; r.maxCombo = hits; r.counts = { PERFECT: hits, GREAT: 0, GOOD: 0, MISS: 0 }; r.weight = hits; r.judged = hits; r.hp = HP_RULES.max;
    for (let i = 0; i < LANES; i++) heldLanes[i] = r.notes.some(n => n.lane === i && n.state === HOLDING);
    shownScore = scoreOf(r); $('#hud-score').textContent = shownScore.toLocaleString('en-US');
    updateHud();
    const latest = r.notes.filter(n => n.time <= t && t - n.time < 0.3).at(-1);
    if (latest) showJudgement('PERFECT', null);
    // combo milestone at this t (the k-th judged hit since the capture start reached 100 / 200 / …)
    const times = []; for (const n of r.notes) { if (n.time >= from && n.time <= t) times.push(n.time); if (n.duration && n.end >= from && n.end <= t) times.push(n.end); }
    times.sort((a, b) => a - b);
    const mile = Math.floor(hits / 100) * 100, d = $('#combo-display');
    const tm = mile >= 100 ? times[mile - 1] : null, live = tm !== null && t - tm < MILESTONE[mileGrade(mile)].ms / 1000;
    if (live) {
      const g = showComboMilestone(mile, tm); seekComboMilestone(t - tm);
      r.effects.push({ type: 'milestone', grade: mileGrade(mile), lane: 0, t0: tm, dur: MILESTONE[mileGrade(mile)].ms / 1000, x: g.cx * board.dpr, y: g.cy * board.dpr, r: g.ring / 2 * board.dpr });
    } else if (d.classList.contains('milestone')) endComboMilestone();
  } else updateJudgements(t);
  resizeBoard(); drawBoard(t, performance.now());
  return { time: t };
}

// ───────────────────────────── screens ─────────────────────────────
const SCREENS = ['intro', 'title', 'select', 'options', 'calibrate', 'bonus', 'play', 'result'];
const gameEvents = { screen: [], runStart: [] };
const sel = { song: Math.max(0, Number(settings.lastSong) || 0), diffId: typeof settings.lastDiff === 'string' ? settings.lastDiff : DIFFS[Number(settings.lastDiff) || 0] || 'easy', autoPlay: false };
// the chosen difficulty if this song shows it, otherwise the nearest lower one that is visible
function currentDiff(song = songs[sel.song]) { const v = visibleDiffs(song); if (v.includes(sel.diffId)) return sel.diffId; const want = DIFFS.indexOf(sel.diffId); return [...v].reverse().find(d => DIFFS.indexOf(d) <= want) || v[0]; }
let optionsReturn = 'title';

function show(name) {
  if (screen === 'play' && name !== 'play') cleanupRun();
  if (screen === 'calibrate' && name !== 'calibrate') stopCalibration();
  if (screen === 'result' && name !== 'result') { window.ResultFX?.stop(); $('#result-screen').dataset.celebrate = 0; }
  screen = name;
  for (const id of SCREENS) { const el = $(`#${id}-screen`); const on = id === name; el.hidden = !on; el.classList.toggle('active', on); }
  document.body.dataset.screen = name;
  // every screen opens at its top (iOS Safari can keep an old scroll offset, or leave the page itself scrolled)
  if (name !== 'play') { const el = $(`#${name}-screen`); if (el) el.scrollTop = 0; if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }
  if (name !== 'select') stopPreview();
  if (name === 'title') renderTitle();
  if (name === 'select') renderSelect(true);
  if (name === 'options') renderOptions();
  if (name === 'bonus') renderBonus();
  if (name === 'calibrate') resetCalibration();
  $('#ambient').classList.toggle('on', ['select', 'play', 'result', 'bonus'].includes(name));
  $('#ambient').dataset.screen = name;
  gameEvents.screen.forEach(fn => fn(name));
}
// The ambient wash is the jacket at 240px, lightly pre-blurred and stretched: recognisable, and far cheaper than a full-screen CSS blur.
const ambientCache = new Map();
// some engines accept ctx.filter but ignore it: test by blurring a single pixel
let filterSupport = null;
function canvasFilterWorks() {
  if (filterSupport !== null) return filterSupport;
  try { const c = document.createElement('canvas'); c.width = c.height = 5; const x = c.getContext('2d'); x.filter = 'blur(1px)'; x.fillStyle = '#fff'; x.fillRect(2, 2, 1, 1); filterSupport = x.getImageData(0, 2, 1, 1).data[3] > 0; } catch { filterSupport = false; }
  return filterSupport;
}
// Select / BONUS TRACK: the full-resolution jacket itself, softened by CSS (blur + dim + vignette) and cross-faded
// between two layers. Nothing is downscaled, so the art stays crisp-looking and recognisable on every screen.
function setSharpAmbient(src) {
  const amb = $('#ambient'), a = $('#ambient-a'), b = $('#ambient-b');
  amb.dataset.mode = 'sharp';
  const front = a.classList.contains('show') ? a : b.classList.contains('show') ? b : null;
  if (front && front.dataset.src === src) return;
  const back = front === a ? b : a;
  back.dataset.src = src;
  back.onload = () => { if (back.dataset.src !== src) return; back.classList.add('show'); if (front) front.classList.remove('show'); };
  back.decoding = 'async'; back.src = src;
  if (back.complete && back.naturalWidth) back.onload();
}
function setAmbient(src, soft = false) {
  if (!soft) return setSharpAmbient(src);
  $('#ambient').dataset.mode = 'soft';
  const img = $('#ambient-image'), key = soft ? src + '#soft' : src; if (img.dataset.src === key) return;
  img.dataset.src = key; img.classList.remove('show');
  const apply = url => { if (img.dataset.src !== key) return; img.onload = () => img.classList.add('show'); img.src = url; };
  if (ambientCache.has(key)) return apply(ambientCache.get(key));
  const source = new Image();
  source.onload = () => {
    // select/bonus: 240px, light blur → the jacket stays recognisable. gameplay: 40px wash so the board stays the focus.
    const size = soft ? 40 : 240, c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d'); x.filter = soft ? 'blur(2px) saturate(1.3)' : 'blur(3px) saturate(1.15)';
    if (canvasFilterWorks()) x.drawImage(source, -size * 0.025, -size * 0.025, size * 1.05, size * 1.05);
    else {
      // no canvas filters (older Safari): blur by resampling through a quarter-size canvas instead
      const small = document.createElement('canvas'); small.width = small.height = Math.max(8, size / 4);
      const sx = small.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(source, 0, 0, small.width, small.height);
      x.imageSmoothingQuality = 'high'; x.drawImage(small, 0, 0, size, size);
    }
    let url = src; try { url = c.toDataURL('image/png'); } catch {}
    ambientCache.set(key, url); apply(url);
  };
  source.onerror = () => apply(src);
  source.src = src;
}
let toastTimer = 0;
function toast(message, ms = 2400) { const t = $('#toast'); t.textContent = message; t.hidden = false; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms); }

// generic keyboard menus: a container of buttons with one highlighted
function menuButtons(container) { return [...container.querySelectorAll('button')].filter(b => !b.hidden && !b.disabled && b.offsetParent !== null); }
function menuFocus(container, index) {
  const buttons = menuButtons(container); if (!buttons.length) return;
  const i = ((index % buttons.length) + buttons.length) % buttons.length;
  buttons.forEach((b, k) => b.classList.toggle('selected', k === i));
  container.dataset.index = i;
}
function menuMove(container, delta) { menuFocus(container, (Number(container.dataset.index) || 0) + delta); }
function menuActivate(container) { menuButtons(container)[Number(container.dataset.index) || 0]?.click(); }

// ── title
const hasBonusUnlocked = () => Object.values(saveData.songs).some(s => Object.values(s).some(r => r.lamp >= 2));
function renderTitle() { $('#title-bonus').hidden = !hasBonusUnlocked(); menuFocus($('.title-menu'), 0); }

// ── select
function cyclicOffset(i, center, n) { let o = ((i - center) % n + n) % n; if (o > n / 2) o -= n; return o; }
function buildSongCards() {
  $('#song-cards').innerHTML = songs.map((s, i) => `<button type="button" class="song-card" data-song="${i}" tabindex="-1"><span class="jacket"><img src="${s.jacket}" alt="" loading="lazy"></span><span class="card-title">${escapeHtml(s.title)}</span></button>`).join('');
}
function lampBadge(lamp) { return lamp >= 2 ? `<i class="lamp lamp-${lamp}">${['', '', 'CLEAR', 'FC', 'AP'][lamp]}</i>` : lamp === 1 ? '<i class="lamp lamp-1">FAILED</i>' : ''; }
function renderSelect(entering = false) {
  const n = songs.length; sel.song = ((sel.song % n) + n) % n;
  const song = songs[sel.song];
  $$('#song-cards .song-card').forEach(card => {
    const off = cyclicOffset(Number(card.dataset.song), sel.song, n), visible = Math.abs(off) <= 3;
    card.style.setProperty('--off', off);
    card.classList.toggle('selected', off === 0);
    card.classList.toggle('hidden-card', !visible);
    const cardSong = songs[Number(card.dataset.song)], rec = getRecord(cardSong.id, currentDiff(cardSong));
    card.dataset.lamp = rec?.lamp || 0;
  });
  $('#select-position').textContent = `${String(sel.song + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
  $('#select-title').textContent = song.title;
  $('#select-meta').textContent = [song.artist, song.genre, `${song.bpm} BPM`, formatTime(song.duration)].filter(Boolean).join('  ·  ');
  $('#select-description').textContent = song.description;
  const diffNow = currentDiff(song), tabs = visibleDiffs(song);
  if (diffNow) markUnlockSeen(song.id, diffNow);
  $('#difficulty-tabs').style.setProperty('--tabs', tabs.length); $('#difficulty-tabs').dataset.count = tabs.length;
  $('#difficulty-tabs').innerHTML = tabs.map(d => {
    const rec = getRecord(song.id, d), played = rec && rec.plays > 0, legacyOnly = played && rec.legacy && !rec.best, def = diffDef(d);
    const best = played && rec.best ? rec.best.toLocaleString('en-US') : played ? '—' : 'NO PLAY', isNew = def.tier === 'advanced' && !syuPMode && !unlockSeen(song.id, d);
    const character = song.mechanics?.[d]?.character;
    return `<button type="button" role="radio" aria-checked="${d === diffNow}" class="diff-tab diff-${d}${d === diffNow ? ' active' : ''}" data-diff="${d}">
      <span class="diff-name">${def.label}${character ? `<em class="diff-character">${character}</em>` : ''}</span><span class="diff-level">${starMarkup(levelOf(song, d))}</span>
      <span class="diff-best">${best}</span><span class="diff-rank">${rec?.rank || ''}</span>${lampBadge(rec?.lamp || 0)}${legacyOnly ? '<i class="legacy">旧譜面プレイ済</i>' : ''}${isNew ? '<i class="new-diff">NEW</i>' : ''}</button>`;
  }).join('');
  const auto = $('#autoplay-toggle'); auto.setAttribute('aria-pressed', String(sel.autoPlay)); auto.querySelector('b').textContent = sel.autoPlay ? 'ON' : 'OFF'; auto.classList.toggle('on', sel.autoPlay);
  setAmbient(song.jacket);
  if (diffNow) drawChartGraph(song, diffNow);
  settings.lastSong = sel.song; settings.lastDiff = sel.diffId; saveSettings();
  schedulePreview(song, entering);
}
function moveSong(delta) { sel.song += delta; renderSelect(); }
// note-density sparkline of the selected chart: shows where the song peaks before you play it
let graphToken = 0;
function drawChartGraph(song, diff) {
  const token = ++graphToken, canvas = $('#chart-graph');
  loadChart(song.charts[diff]).then(chart => {
    if (token !== graphToken || screen !== 'select') return;
    const { ctx, w, h } = prepCanvas(canvas), dur = Math.max(1, Number(chart.duration) || song.duration || 1), bins = Math.max(24, Math.round(w / 6)), counts = new Array(bins).fill(0);
    chart.notes.forEach(n => { counts[Math.min(bins - 1, Math.floor(n.time / dur * bins))]++; });
    const peak = Math.max(1, ...counts), color = DIFF_COLORS[diff];
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, h);
    counts.forEach((c, i) => ctx.lineTo((i + 0.5) / bins * w, h - 1 - c / peak * (h - 3)));
    ctx.lineTo(w, h); ctx.closePath(); ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
    const p = (Number(song.previewStart) || 0) / dur * w; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(p, 0, 1, h);
    $('#chart-notes').textContent = `${song.noteCounts?.[diff] ?? chart.notes.length} NOTES`;
  }).catch(() => {});
}
function setDifficulty(id) { sel.diffId = id; renderSelect(); }
function moveDifficulty(step) { const v = visibleDiffs(songs[sel.song]), i = v.indexOf(currentDiff()); setDifficulty(v[Math.max(0, Math.min(v.length - 1, i + step))]); }

// preview: loop the chorus with fades
const pv = { timer: 0, fadeTimer: 0, song: null, start: 0, token: 0, blocked: false };
// a browser may refuse to start audio before the first gesture: retry the preview on the next key / tap
['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, () => { if (screen === 'select' && pv.blocked && pv.song) { pv.blocked = false; const s = pv.song; pv.song = null; startPreview(s); } }, true));
function schedulePreview(song, immediate) {
  clearTimeout(pv.timer);
  if (pv.song === song && !preview.paused) return;
  fadePreview(0, 150);
  pv.timer = setTimeout(() => startPreview(song), immediate ? 50 : 320);
}
function startPreview(song) {
  if (screen !== 'select') return;
  pv.song = song; pv.start = Number(song.previewStart) || 0;
  const token = ++pv.token;
  preview.preload = 'auto'; preview.src = song.audio; preview.volume = 0; preview.load();
  const begin = () => {
    if (token !== pv.token || screen !== 'select') return;
    try { preview.currentTime = pv.start; } catch {}
    preview.play().then(() => { pv.blocked = false; fadePreview(Math.min(1, settings.musicVolume / 10), 700); }).catch(() => { pv.blocked = true; });
  };
  preview.addEventListener('loadedmetadata', begin, { once: true });
}
function fadePreview(target, ms) {
  clearInterval(pv.fadeTimer);
  const from = preview.volume, t0 = performance.now();
  pv.fadeTimer = setInterval(() => { const k = Math.min(1, (performance.now() - t0) / ms); try { preview.volume = from + (target - from) * k; } catch {} if (k >= 1) { clearInterval(pv.fadeTimer); if (target === 0 && screen !== 'select') preview.pause(); } }, 30);
}
function stopPreview() { clearTimeout(pv.timer); clearInterval(pv.fadeTimer); pv.token++; preview.pause(); pv.song = null; }
preview.addEventListener('timeupdate', () => {
  const span = 18, pos = preview.currentTime - pv.start;
  $('#preview-fill').style.width = `${Math.max(0, Math.min(100, pos / span * 100))}%`;
  if (pos > span && !pv.looping) { pv.looping = true; fadePreview(0, 600); setTimeout(() => { pv.looping = false; if (screen === 'select' && pv.song) { try { preview.currentTime = pv.start; } catch {} fadePreview(Math.min(1, settings.musicVolume / 10), 600); } }, 650); }
});
preview.addEventListener('ended', () => { if (screen === 'select' && pv.song) { try { preview.currentTime = pv.start; } catch {} preview.play().catch(() => {}); } });

// ── options
const range = (a, b, step) => { const out = []; for (let v = a; v <= b + 1e-9; v += step) out.push(+v.toFixed(2)); return out; };
const onOff = v => v ? 'ON' : 'OFF';
const OPTION_ROWS = [
  { key: 'speed', label: 'NOTE SPEED', desc: 'ノーツの落下速度。大きいほど速く、間隔が読みやすくなります', values: range(1.5, 10, 0.5), fmt: v => v.toFixed(1) },
  { key: 'offsetMs', label: 'TIMING OFFSET', desc: '音と判定のずれを補正。音が遅れて聞こえる環境（Bluetooth等）ではプラスへ', values: range(-300, 300, 5), fmt: v => `${v > 0 ? '+' : ''}${v} ms` },
  { key: 'calibrate', label: 'TIMING CHECK', desc: 'クリック音に合わせて押すだけで OFFSET を自動測定します', action: () => show('calibrate'), fmt: () => '測定する ▶' },
  { key: 'keys', label: 'KEYS', desc: 'レーンに割り当てるキー。CUSTOM で ENTER を押すと好きなキーを登録できます', values: ['asdf', 'dfjk', 'sdkl', 'custom'], fmt: v => (v === 'custom' ? settings.customKeys : KEY_PRESETS[v]).map(keyLabel).join(' ') + (v === 'custom' ? '  (CUSTOM)' : '') },
  { key: 'hitVolume', label: 'HIT SOUND', desc: 'キーを押したときのタップ音', values: range(0, 10, 1), fmt: v => v ? `${v}` : 'OFF' },
  { key: 'musicVolume', label: 'MUSIC VOLUME', desc: '楽曲の音量', values: range(0, 10, 1), fmt: v => `${v}` },
  { key: 'timingDisplay', label: 'FAST / SLOW', desc: '早押し・遅押しを判定の下に表示します', values: [true, false], fmt: onOff },
  { key: 'barLines', label: 'BAR LINES', desc: '小節線を表示してリズムを読みやすくします', values: [true, false], fmt: onOff },
  { key: 'effects', label: 'EFFECTS', desc: '処理が重いときは LITE に', values: ['full', 'lite'], fmt: v => v.toUpperCase() },
  { key: 'noFail', label: 'NO FAIL', desc: 'HPが0になっても最後まで演奏できます（クリア扱いにはなりません）', values: [false, true], fmt: onOff }
];
let optionIndex = 0, keyCapture = null;
function renderOptions() {
  $('#options-list').innerHTML = OPTION_ROWS.map((row, i) => {
    const value = row.values ? row.fmt(settings[row.key]) : row.fmt();
    const capture = keyCapture && row.key === 'keys' ? `KEY ${keyCapture.length + 1} / 4 を押してください` : null;
    return `<div class="option-row${i === optionIndex ? ' selected' : ''}" data-row="${i}">
      <div class="option-label"><b>${row.label}</b><small>${row.desc}</small></div>
      <div class="option-value">${row.values ? `<button type="button" class="opt-step" data-step="-1" aria-label="${row.label} を下げる">‹</button>` : ''}
        <button type="button" class="opt-main" data-main="${i}">${capture || value}</button>
        ${row.values ? `<button type="button" class="opt-step" data-step="1" aria-label="${row.label} を上げる">›</button>` : ''}</div></div>`;
  }).join('');
}
function stepOption(i, delta) {
  const row = OPTION_ROWS[i]; if (!row.values) return;
  const idx = row.values.findIndex(v => v === settings[row.key]), next = row.values[Math.max(0, Math.min(row.values.length - 1, (idx < 0 ? 0 : idx) + delta))];
  settings[row.key] = next; saveSettings(); applyVolumes();
  if (row.key === 'hitVolume') { ensureAudio(); playHitSound(); }
  renderOptions();
}
function activateOption(i) {
  const row = OPTION_ROWS[i]; optionIndex = i;
  if (row.action) return row.action();
  if (row.key === 'keys' && settings.keys === 'custom') { keyCapture = []; renderOptions(); return; }
  if (row.values && row.values.length === 2) return stepOption(i, settings[row.key] === row.values[0] ? 1 : -1);
  renderOptions();
}
function captureKey(e) {
  if (['Escape', 'Enter', 'Tab'].includes(e.key) || e.code.startsWith('Arrow')) { keyCapture = null; renderOptions(); return; }
  if (keyCapture.includes(e.code)) return;
  keyCapture.push(e.code);
  if (keyCapture.length === 4) { settings.customKeys = keyCapture; keyCapture = null; saveSettings(); toast(`KEYS: ${settings.customKeys.map(keyLabel).join(' ')}`); }
  renderOptions();
}

// ── timing check (calibration)
const calib = { running: false, clicks: [], deltas: [], timers: [], result: null };
const CALIB_BEAT = 0.6, CALIB_LEADIN = 4, CALIB_TAPS = 16;
function resetCalibration() { stopCalibration(); $('#calibrate-count').textContent = 'READY'; $('#calibrate-result').innerHTML = '&nbsp;'; $('#calibrate-apply').hidden = true; $('#calibrate-start').textContent = 'START'; menuFocus($('.calibrate-actions'), 0); }
function stopCalibration() { calib.running = false; calib.timers.forEach(clearTimeout); calib.timers = []; }
function startCalibration() {
  const ctx = ensureAudio(); if (!ctx) { toast('このブラウザでは測定できません'); return; }
  stopCalibration(); calib.running = true; calib.deltas = []; calib.result = null; calib.clicks = [];
  $('#calibrate-apply').hidden = true; $('#calibrate-result').innerHTML = '&nbsp;';
  const t0 = ctx.currentTime + 0.6, total = CALIB_LEADIN + CALIB_TAPS + 2;
  for (let i = 0; i < total; i++) {
    const at = t0 + i * CALIB_BEAT, o = ctx.createOscillator(), g = ctx.createGain(), accent = i < CALIB_LEADIN;
    o.frequency.value = accent ? 1760 : 1320; o.type = 'square';
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.18, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.06);
    calib.clicks.push(at);
    if (accent) calib.timers.push(setTimeout(() => { if (!calib.running) return; $('#calibrate-count').textContent = String(CALIB_LEADIN - i); pulseCalibration(); }, (at - ctx.currentTime) * 1000));
  }
  calib.timers.push(setTimeout(() => { if (calib.running && !calib.deltas.length) $('#calibrate-count').textContent = 'TAP!'; }, (t0 + CALIB_LEADIN * CALIB_BEAT - ctx.currentTime) * 1000));
  calib.timers.push(setTimeout(finishCalibration, (t0 + total * CALIB_BEAT - ctx.currentTime + 0.3) * 1000));
  $('#calibrate-start').textContent = 'RESTART';
}
function pulseCalibration() { const p = $('#calibrate-pulse'); p.classList.remove('beat'); void p.offsetWidth; p.classList.add('beat'); }
function calibrationTap(perf) {
  if (!calib.running || !sound.ctx) return;
  const pressCtx = sound.ctx.currentTime - (performance.now() - perf) / 1000;
  const targets = calib.clicks.slice(CALIB_LEADIN), nearest = targets.reduce((b, c) => Math.abs(c - pressCtx) < Math.abs(b - pressCtx) ? c : b, Infinity);
  const delta = pressCtx - nearest; if (Math.abs(delta) > CALIB_BEAT * 0.45) return;
  calib.deltas.push(delta); pulseCalibration();
  $('#calibrate-count').textContent = `${calib.deltas.length} / ${CALIB_TAPS}`;
  if (calib.deltas.length >= CALIB_TAPS) finishCalibration();
}
function finishCalibration() {
  if (!calib.running) return; stopCalibration();
  if (calib.deltas.length < 8) { $('#calibrate-count').textContent = 'RETRY'; $('#calibrate-result').textContent = '入力が少なすぎました。もう一度試してください。'; return; }
  const sorted = [...calib.deltas].sort((a, b) => a - b), trimmed = sorted.slice(2, -2), median = trimmed[Math.floor(trimmed.length / 2)];
  const spread = Math.sqrt(trimmed.reduce((s, d) => s + (d - median) ** 2, 0) / trimmed.length);
  const autoLat = (Number(sound.ctx.outputLatency) || 0) + (Number(sound.ctx.baseLatency) || 0);
  const suggested = Math.max(-300, Math.min(300, Math.round((median - autoLat) * 1000 / 5) * 5));
  calib.result = suggested;
  $('#calibrate-count').textContent = `${suggested > 0 ? '+' : ''}${suggested} ms`;
  $('#calibrate-result').innerHTML = `平均のずれ ${Math.round(median * 1000)}ms（ばらつき ±${Math.round(spread * 1000)}ms）<br>推奨 OFFSET: <b>${suggested > 0 ? '+' : ''}${suggested} ms</b>（現在 ${settings.offsetMs} ms）`;
  $('#calibrate-apply').hidden = false; menuFocus($('.calibrate-actions'), 1);
}
function applyCalibration() { if (calib.result === null) return; settings.offsetMs = calib.result; saveSettings(); toast(`TIMING OFFSET を ${calib.result} ms にしました`); show('options'); }

// ── bonus track (record book)
let bonusIndex = 0;
function renderRuleResult(res) {   // a plugin's panel; the painting (if the rule uses CANVAS) is shown as before
  const el = $('#result-mode'), artEl = $('#result-art'), jacket = $('#result-jacket'), rr = res.ruleResult;
  artEl.hidden = res.paint === undefined; jacket.hidden = res.paint !== undefined;
  $('#result-screen').classList.toggle('mode-special', res.paint !== undefined);
  if (res.paint !== undefined) { artEl.width = artEl.height = 360; artEl.getContext('2d').drawImage(res.artCanvas, 0, 0); }
  el.hidden = false; el.dataset.mode = res.diff;
  el.innerHTML = `<small>${escapeHtml(rr.small || '')}</small><b>${escapeHtml(rr.title || '')}</b><span>${escapeHtml(rr.ja || '')}</span>${rr.em ? `<em>${escapeHtml(rr.em)}</em>` : ''}${res.paint !== undefined ? `<em>ARTWORK ${(res.paint * 100).toFixed(1)}%</em>` : ''}`;
}
function renderBonus() {
  const n = songs.length; bonusIndex = ((bonusIndex % n) + n) % n;
  const song = songs[bonusIndex], records = saveData.songs[song.id] || {}, found = Object.values(records).some(r => r.plays > 0);
  $('#bonus-title').textContent = found ? song.title : '???';
  $('#bonus-meta').textContent = found ? `${song.artist}  ·  ${song.genre}` : '???';
  $('#bonus-description').textContent = found ? song.description : 'まだ出会っていない曲です。選曲画面でプレイすると記録が開きます。';
  const jacket = $('#bonus-jacket'); jacket.hidden = !found; if (found) jacket.src = song.jacket;
  $('#bonus-secret').hidden = found;
  if (found) setAmbient(song.jacket);
  $('#bonus-records').innerHTML = DIFFICULTY_DEFS.filter(def => song.charts?.[def.id]).map(def => def.id).map(d => {
    if (!isUnlocked(song, d)) return `<article class="bonus-record locked"><h2>${found ? diffDef(d).label : '???'}</h2><strong>LOCKED</strong><p>${found ? `${diffDef(diffDef(d).unlockAfter).label} をクリアすると出現` : '???'}</p></article>`;
    const r = records[d], played = r?.plays > 0;
    const v = (x, f = y => y) => found && played ? f(x) : found ? '---' : '???';
    return `<article class="bonus-record${played ? ` lamp-${r.lamp}` : ''}"><h2>${diffDef(d).label}</h2>${found ? starMarkup(levelOf(song, d)) : '<span class="level-stars"><small>Lv.<b>?</b></small></span>'}
      <strong>${found ? played ? LAMPS[r.lamp] : 'NO PLAY' : '???'}</strong>
      <dl><div><dt>HIGH SCORE</dt><dd>${v(r?.best, x => x ? x.toLocaleString('en-US') : '—')}</dd></div><div><dt>RANK</dt><dd>${v(r?.rank, x => x || '—')}</dd></div>
      <div><dt>MAX COMBO</dt><dd>${v(r?.maxCombo, x => `${x} / ${song.noteCounts?.[d] ?? '?'}`)}</dd></div><div><dt>PLAY</dt><dd>${v(r?.plays)}</dd></div><div><dt>CLEAR</dt><dd>${v(r?.clears)}</dd></div>${d === 'special' && r?.artwork ? `<div class="bonus-art"><img src="${r.artwork}" alt="あなたが描いたジャケット"><span>ARTWORK ${(r.bestPaint * 100).toFixed(1)}%</span></div>` : ''}${r?.ruleStats ? Object.entries(r.ruleStats).map(([k, x]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(x))}</dd></div>`).join('') : ''}${d === 'chaos' && r?.bestCards ? `<div><dt>CARDS</dt><dd>${r.bestCards} ノーミス</dd></div>` : ''}<div><dt>BEST ★</dt><dd class="best-stars">${v(r?.bestStars, x => '★'.repeat(x || 0) + '☆'.repeat(5 - (x || 0)))}</dd></div></dl>${r?.archived?.length ? `<p class="archived">旧譜面の記録: BEST ${Math.max(...r.archived.map(a => a.best || 0)).toLocaleString('en-US')}</p>` : ''}</article>`;
  }).join('');
}

// ── result
let lastResult = null;
const STAR_GOALS = [['CLEAR', r => r.lamp >= 2], ['80%', r => r.acc >= 0.8], ['90%', r => r.acc >= 0.9], ['95%', r => r.acc >= 0.95], ['FULL COMBO', r => r.lamp >= 3]];
const starRating = res => STAR_GOALS.map(([label, test]) => ({ label, got: test(res) }));
function showResult() {
  const r = run; if (!r) return;
  const score = scoreOf(r), acc = accuracyOf(r), rank = rankOf(acc), lamp = r.lamp ?? 1;
  const res = { song: r.song, diff: r.diff, score, acc, rank, lamp, counts: { ...r.counts }, fast: r.fast, slow: r.slow, maxCombo: r.maxCombo, objects: r.objects, deltas: r.deltas.slice(), events: r.events.slice(), hpLog: r.hpLog.slice(), autoPlay: r.autoPlay, dev: r.dev, gameOver: r.failed && !r.noFailUsed, duration: r.song.duration || r.chart.duration, milestones: r.milestones.slice(), milestoneList: [...r.milestoneSet] };
  res.timing = timingGrade(res.deltas);
  if (art.active) { res.paint = artPercent(); res.artCanvas = art.canvas; res.artSrc = art.src; res.hiddenArt = art.hiddenArt; }
  if (r.rule) res.ruleResult = ruleCall('result', res) || null;
  if (r.cards.length) res.cardReport = r.cards.filter(c => !c.cards.includes('rest')).map(c => { const ev = r.events.filter(e => e.t >= c.start && e.t < c.end); return { cards: c.cards, hits: ev.length, miss: ev.filter(e => e.kind === 'MISS').length }; });
  let prevBest = 0, newRecord = false;
  const lockedBefore = lockedDiffs(r.song);
  if (!r.autoPlay && !r.dev) {
    const rec = recordFor(saveData, r.song.id, r.diff);
    rec.rev = r.song.chartRevs?.[r.diff] || 2;
    prevBest = rec.best; rec.plays++; if (lamp >= 2) rec.clears++;
    if (score > rec.best) { rec.best = score; rec.rank = rank; newRecord = prevBest > 0 || score > 0; }
    if (res.paint !== undefined && rec.artwork && (rec.artSrc || r.song.jacket) !== res.artSrc) {   // the song got a new SPECIAL picture: the old painting is kept aside, the new one starts fresh
      rec.artArchive = { src: rec.artSrc || r.song.jacket, bestPaint: rec.bestPaint, artwork: rec.artwork }; rec.bestPaint = 0; delete rec.artwork;
    }
    if (res.paint !== undefined && res.paint > (rec.bestPaint || 0) - 1e-9) {   // keep the best painting (small JPEG) for BONUS TRACK
      rec.bestPaint = +res.paint.toFixed(4); rec.artSrc = res.artSrc;
      try { const c = document.createElement('canvas'); c.width = c.height = 160; c.getContext('2d').drawImage(res.artCanvas, 0, 0, 160, 160); rec.artwork = c.toDataURL('image/jpeg', 0.8); } catch {}
    }
    if (r.rule) { rec.rule = r.chart.rule; ruleCall('save', rec, res); }
    if (res.cardReport) rec.bestCards = Math.max(rec.bestCards || 0, res.cardReport.filter(c => !c.miss).length);
    rec.bestStars = Math.max(rec.bestStars || 0, starRating({ lamp, acc }).filter(s => s.got).length);
    rec.lamp = Math.max(rec.lamp, lamp); rec.maxCombo = Math.max(rec.maxCombo, r.maxCombo); rec.bestAccuracy = Math.max(rec.bestAccuracy, +(acc * 100).toFixed(2)); delete rec.legacy;
    persist();
  }
  res.newRecord = newRecord;
  res.unlocked = !r.autoPlay && !r.dev ? lockedBefore.filter(d => isUnlocked(r.song, d)) : [];
  lastResult = res;
  show('result');
  const kind = res.gameOver ? 'GAME OVER' : { 1: 'FAILED', 2: 'CLEAR', 3: 'FULL COMBO', 4: 'ALL PERFECT' }[lamp];
  $('#result-screen').dataset.lamp = res.gameOver ? 'gameover' : lamp;
  $('#result-kind').textContent = kind;
  $('#result-jacket').src = res.song.jacket;
  $('#result-title').textContent = res.song.title;
  $('#result-difficulty').innerHTML = `<span class="diff-chip diff-${res.diff}">${res.diff.toUpperCase()}</span> ${starMarkup(levelOf(res.song, res.diff))}`;
  $('#result-rank').textContent = rank; $('#result-rank').dataset.rank = rank;
  const goals = starRating(res);
  $('#result-stars').innerHTML = goals.map((s, i) => `<span class="goal${s.got ? ' got' : ''}" style="--i:${i}"><i>${s.got ? '★' : '☆'}</i><small>${s.label}</small></span>`).join('');
  $('#result-stars').classList.toggle('perfect', lamp === 4);
  $('#result-stars').setAttribute('aria-label', `評価 ★${goals.filter(s => s.got).length} / 5`);
  $('#result-auto').hidden = !(res.autoPlay || res.dev);
  $('#result-auto').textContent = res.dev ? 'syuP MODE — 記録・解禁には反映されません' : 'AUTO PLAY — 記録されません';
  $('#result-rate').textContent = `RATE ${(acc * 100).toFixed(2)}%`;
  renderUnlock(res); renderAchievements(res); renderTimingGrade(res); renderModeResult(res);
  $('#result-best').innerHTML = res.autoPlay ? '' : newRecord ? `<b class="new-record">NEW RECORD</b> ${prevBest ? `+${(score - prevBest).toLocaleString('en-US')}` : ''}` : prevBest ? `BEST ${prevBest.toLocaleString('en-US')}` : '';
  countUp($('#result-score'), score);
  for (const k of ['perfect', 'great', 'good', 'miss']) $(`#result-${k}`).textContent = res.counts[k.toUpperCase()];
  $('#result-max-combo').textContent = `${res.maxCombo} / ${res.objects}`;
  $('#result-fastslow').innerHTML = `<em class="fast">${res.fast}</em> / <em class="slow">${res.slow}</em>`;
  requestAnimationFrame(() => { drawTimeline(res); drawHistogram(res); celebrate(res); });
  menuFocus($('.result-actions'), 0);
}
// ── timing accuracy grade: spread of the hit offsets (consistency), with half of the constant bias counted
// (bias can be fixed with OFFSET, spread cannot). RANK judges the score; this judges the hands.
const TIMING_GRADES = [['PINPOINT', '精密', 15], ['SHARP', '正確', 22], ['STEADY', '安定', 32], ['WAVY', 'ゆらぎ', 45], ['WILD', 'ばらばら', Infinity]];
function timingGrade(deltas) {
  if (deltas.length < 20) return null;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length, sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length);
  const eff = Math.sqrt(sd ** 2 + (0.5 * mean) ** 2) * 1000, index = TIMING_GRADES.findIndex(([, , limit]) => eff <= limit);
  return { name: TIMING_GRADES[index][0], ja: TIMING_GRADES[index][1], index, eff: +eff.toFixed(1), sd: +(sd * 1000).toFixed(1), mean: +(mean * 1000).toFixed(1) };
}
function renderTimingGrade(res) {
  const el = $('#result-timing-grade'), g = res.timing;
  el.hidden = !g;
  if (!g) return;
  el.dataset.grade = g.index;
  el.innerHTML = `<b>${g.name}</b><span>${g.ja}</span><small>ばらつき ±${Math.round(g.sd)}ms</small><i class="timing-meter"><i style="width:${Math.max(6, 100 - g.eff * 1.6)}%"></i></i>`;
}
// ── combo milestones reached in this play (and the next one to aim for)
function renderAchievements(res) {
  const reached = res.milestones.map(m => m.combo), next = res.milestoneList.find(m => !reached.includes(m));
  const medals = reached.map(c => `<span class="medal m${Math.min(4, Math.floor(Math.log2(c / 50)))}">${c}<small>COMBO</small></span>`);
  if (res.lamp >= 3) medals.push(`<span class="medal fc">FULL<small>COMBO</small></span>`);
  if (res.lamp >= 4) medals.push(`<span class="medal ap">ALL<small>PERFECT</small></span>`);
  if (next && res.lamp < 3) medals.push(`<span class="medal next">${next}<small>NEXT</small></span>`);
  $('#result-achievements').innerHTML = medals.join('');
}
// SPECIAL / CHAOS have their own "what did I achieve" panel — always encouraging, never mocking
function paintTitle(p, lamp) { return p >= 0.9999 && lamp === 4 ? ['MASTERPIECE', '傑作'] : p >= 0.98 ? ['BEAUTIFUL', '名画'] : p >= 0.9 ? ['VIVID', '力作'] : p >= 0.75 ? ['SKETCH', 'スケッチ完成'] : ['DRAFT', '下描きから始めよう']; }
function chaosTitle(rep) { const ok = rep.filter(c => !c.miss).length, all = rep.length; return ok === all ? ['CHAOS MASTER', 'どんなカードも乗りこなした'] : ok >= all * 0.7 ? ['CHAOS RIDER', 'カオスに慣れてきた'] : ok >= all * 0.3 ? ['CHAOS FRIEND', 'カオスと仲良くなった'] : ['CHAOS ROOKIE', 'まずは笑って楽しもう']; }
function renderModeResult(res) {
  if (res.ruleResult) return renderRuleResult(res);
  const el = $('#result-mode'), artEl = $('#result-art'), jacket = $('#result-jacket');
  artEl.hidden = res.paint === undefined; jacket.hidden = res.paint !== undefined;
  $('#result-screen').classList.toggle('mode-special', res.paint !== undefined);
  if (res.paint !== undefined) { artEl.width = artEl.height = 360; artEl.getContext('2d').drawImage(res.artCanvas, 0, 0); }
  if (res.paint !== undefined) {
    const [title, ja] = paintTitle(res.paint, res.lamp);
    el.hidden = false; el.dataset.mode = 'special';
    el.innerHTML = `<small>${res.hiddenArt ? "SECRET ARTWORK" : "ARTWORK"} — syuPとのセッション</small><b>${title}</b><span>${ja}</span><em>${(res.paint * 100).toFixed(1)}% 塗れました</em>`;
  } else if (res.cardReport) {
    const [title, ja] = chaosTitle(res.cardReport), ok = res.cardReport.filter(c => !c.miss).length;
    el.hidden = false; el.dataset.mode = 'chaos';
    el.innerHTML = `<small>CHAOS CARDS ${ok} / ${res.cardReport.length} ノーミス</small><b>${title}</b><span>${ja}</span><div class="card-chips">${res.cardReport.map(c => `<i class="${c.miss ? 'miss' : 'clear'}" title="${c.cards.map(x => CHAOS_CARDS[x].name).join(' + ')}">${c.cards.map(x => CHAOS_CARDS[x].icon).join('')}</i>`).join('')}</div>`;
  } else el.hidden = true;
}
function renderUnlock(res) {
  const el = $('#result-unlock');
  el.hidden = !res.unlocked.length;
  if (res.unlocked.length) el.innerHTML = `<small>NEW DIFFICULTY UNLOCKED</small><b>${res.unlocked.map(d => diffDef(d).label).join(' / ')}</b><i>選曲画面に追加されました</i>`;
}
// ── celebration: the better the play, the bigger the show (and ALL PERFECT gets its own)
function celebrationLevel(res) {
  if (res.gameOver || res.lamp < 2) return 0;
  if (res.autoPlay) return 1;
  if (res.lamp === 4) return 5;
  if (res.ruleResult?.celebrate >= 4) return Math.min(4, res.ruleResult.celebrate);
  if (res.paint >= 0.98 || (res.cardReport && res.cardReport.every(c => !c.miss))) return Math.max(4, res.lamp === 3 ? 4 : 3);
  let s = 1 + ({ 'S+': 2.5, S: 2, AA: 1.5, A: 1, B: 0.5 }[res.rank] || 0) + (res.lamp === 3 ? 1.5 : 0) + (res.timing ? [1, 0.5, 0, 0, 0][res.timing.index] : 0) + (res.newRecord ? 0.5 : 0) + (res.unlocked.length ? 1 : 0);
  const level = s >= 5 ? 4 : s >= 3.5 ? 3 : s >= 2 ? 2 : 1;
  return res.lamp === 3 ? Math.max(3, level) : level;
}
function celebrate(res) {
  const level = celebrationLevel(res), screenEl = $('#result-screen');
  screenEl.scrollTop = 0;   // effects anchor to the heading: make sure it is on screen first
  screenEl.dataset.celebrate = level;
  screenEl.classList.toggle('unlock-burst', !!res.unlocked.length);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.ResultFX) ResultFX.start(level, { lite: settings.effects === 'lite', reduced, fullCombo: res.lamp >= 3, unlock: !!res.unlocked.length, party: (!!res.ruleResult?.party && !res.autoPlay) || !!res.cardReport && !res.autoPlay && res.cardReport.filter(c => !c.miss).length >= res.cardReport.length * 0.7, bloom: !res.autoPlay && (res.paint >= 0.9 || !!res.ruleResult?.bloom), anchors: { kind: $('#result-kind'), rank: $('#result-rank') } });
  if (level >= 5) playChime([784, 988, 1175, 1568, 1976], 0.08, 0.9);
  else if (level >= 3) playChime([1047, 1319, 1568], 0.06, 0.6);
  if (res.unlocked.length) later(() => playChime([659, 988, 1319, 1760], 0.07, 0.8), 1400);
}
function countUp(el, target) { const t0 = performance.now(), step = () => { const k = Math.min(1, (performance.now() - t0) / 900), e = 1 - (1 - k) ** 3; el.textContent = Math.round(target * e).toLocaleString('en-US'); if (k < 1 && screen === 'result') requestAnimationFrame(step); }; step(); }
function prepCanvas(canvas) { const rect = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, w: rect.width, h: rect.height }; }
function drawTimeline(res) {
  // stacked judgement bars per time slice + HP line: shows exactly where the song got hard
  const { ctx, w, h } = prepCanvas($('#result-timeline')), dur = Math.max(1, res.duration), bins = Math.max(20, Math.min(60, Math.round(w / 9))), per = dur / bins;
  const counts = Array.from({ length: bins }, () => ({ PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 }));
  res.events.forEach(e => { const b = Math.max(0, Math.min(bins - 1, Math.floor(e.t / per))); counts[b][e.kind]++; });
  const peak = Math.max(1, ...counts.map(c => c.PERFECT + c.GREAT + c.GOOD + c.MISS)), bw = w / bins, colors = JUDGE_COLORS;
  ctx.clearRect(0, 0, w, h);
  counts.forEach((c, i) => { let y = h - 2; for (const k of ['PERFECT', 'GREAT', 'GOOD', 'MISS']) { const bh = c[k] / peak * (h - 10); if (!bh) continue; ctx.fillStyle = colors[k]; ctx.globalAlpha = k === 'PERFECT' ? 0.8 : 0.95; ctx.fillRect(i * bw + 1, y - bh, bw - 2, bh); y -= bh; } });
  ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 1.5; ctx.beginPath();
  res.hpLog.forEach(([t, hp], i) => { const x = Math.min(w, t / dur * w), y = h - 2 - hp / 100 * (h - 6); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  const lastHp = res.hpLog.at(-1); if (!res.gameOver) ctx.lineTo(w, h - 2 - lastHp[1] / 100 * (h - 6)); ctx.stroke();
  // combo milestones on the log: where in the song each one was reached
  ctx.font = '700 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const m of res.milestones) {
    const x = Math.min(w - 8, Math.max(8, m.t / dur * w));
    ctx.fillStyle = 'rgba(255,217,90,0.35)'; ctx.fillRect(x - 0.5, 0, 1, h);
    ctx.fillStyle = '#ffd95a'; ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 2.2 : 5; ctx.lineTo(x + Math.cos(a) * rr, 7 + Math.sin(a) * rr); } ctx.fill();
    ctx.fillStyle = '#fff6c8'; ctx.fillText(String(m.combo), x, 13);
  }
}
function drawHistogram(res) {
  const { ctx, w, h } = prepCanvas($('#result-histogram')), range = 150, binMs = 10, bins = range * 2 / binMs, hist = new Array(bins).fill(0);
  res.deltas.forEach(d => { const b = Math.floor((d * 1000 + range) / binMs); if (b >= 0 && b < bins) hist[b]++; });
  const peak = Math.max(1, ...hist), bw = w / bins;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,217,90,0.08)'; ctx.fillRect(w / 2 - 50 / range * w / 2, 0, 50 / range * w, h);
  hist.forEach((v, i) => { const center = (i + 0.5) * binMs - range, a = Math.abs(center); ctx.fillStyle = a <= 50 ? JUDGE_COLORS.PERFECT : a <= 100 ? JUDGE_COLORS.GREAT : JUDGE_COLORS.GOOD; const bh = v / peak * (h - 14); ctx.fillRect(i * bw + 1, h - 12 - bh, bw - 2, bh); });
  ctx.fillStyle = '#ffffff55'; ctx.fillRect(w / 2 - 0.5, 0, 1, h - 12);
  ctx.fillStyle = '#9fb2cc'; ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left'; ctx.fillText('FAST', 2, h); ctx.textAlign = 'right'; ctx.fillText('SLOW', w - 2, h); ctx.textAlign = 'center'; ctx.fillText('0', w / 2, h);
  const n = res.deltas.length, mean = n ? res.deltas.reduce((a, b) => a + b, 0) / n : 0, tip = $('#result-offset-tip');
  $('#result-timing-mean').textContent = n ? `平均 ${mean >= 0 ? '+' : ''}${Math.round(mean * 1000)}ms` : '';
  const suggest = Math.round((settings.offsetMs + mean * 1000) / 5) * 5;
  if (!res.autoPlay && n >= 30 && Math.abs(mean) >= 0.015 && Math.abs(suggest) <= 300) {
    tip.hidden = false;
    tip.innerHTML = `全体的に${mean > 0 ? '遅め' : '早め'}に押しています。<button type="button" data-action="apply-offset" data-offset="${suggest}">OFFSET を ${suggest > 0 ? '+' : ''}${suggest}ms にする</button>`;
  } else tip.hidden = true;
}

// ───────────────────────────── input ─────────────────────────────
const eventPerf = e => { const ts = e.timeStamp, now = performance.now(); return ts > 0 && ts <= now + 5 && now - ts < 1000 ? ts : now; };
let introTimer = 0;

function devCommand(e) {
  if (!/^[0-9]$/.test(e.key) || e.repeat) return false;
  if (screen === 'title') {
    dev.buffer = (dev.buffer + e.key).slice(-6);
    if (!syuPMode && dev.buffer.endsWith('109109')) { setSyuPMode(true); return true; }
    if (syuPMode && dev.buffer.endsWith('1111')) { setSyuPMode(false); return true; }
    if (syuPMode && dev.buffer.endsWith('0000')) { saveData = createDefaultSave(); persist(); dev.buffer = ''; toast('syuP MODE: セーブデータを初期化しました'); renderTitle(); return true; }
  } else if (screen === 'play' && syuPMode && !laneKeys().includes(e.code)) {
    dev.buffer = (dev.buffer + e.key).slice(-3);
    if (dev.buffer === '109') { dev.buffer = ''; devForceClear(); return true; }
  }
  return false;
}
function setSyuPMode(on) {
  syuPMode = on; dev.buffer = '';
  try { on ? sessionStorage.setItem('syupworks-syup-mode', '1') : sessionStorage.removeItem('syupworks-syup-mode'); } catch {}
  $('#syup-badge').hidden = !on;
  ensureAudio(); playChime(on ? [660, 990] : [780, 420], 0.1, 0.15);
  toast(on ? 'syuP MODE ON — 全難易度を表示（記録・解禁なし）' : 'syuP MODE OFF');
}
// syuP MODE: finish the song as if every remaining note were PERFECT (never recorded)
function devForceClear() {
  const r = run; if (!r || !r.dev || r.ended || r.paused) return;
  for (const n of r.notes) { if (n.state === PENDING) hitHead(n, 0, n.time); if (n.state === HOLDING) n.release ? judgeRelease(n, 0, n.end) : completeHold(n, n.end); }
  finishSong();
}
function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (devCommand(e)) { e.preventDefault(); return; }
  if (screen !== 'intro') ensureAudio();
  const k = e.key, code = e.code;

  if (screen === 'play') {
    const lane = laneKeys().indexOf(code);
    if (run?.paused) {
      e.preventDefault();
      if (k === 'ArrowUp') menuMove($('#pause-menu'), -1); else if (k === 'ArrowDown') menuMove($('#pause-menu'), 1);
      else if (k === 'Enter' || k === ' ') menuActivate($('#pause-menu')); else if (k === 'Escape') resumeGame();
      return;
    }
    if (lane >= 0) { e.preventDefault(); if (!e.repeat) pressLane(lane, eventPerf(e)); return; }
    if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); pauseGame(); }
    return;
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();   // keyboard drives menus; avoid native button activation on keyup
  if (e.repeat && (k === 'Enter' || k === ' ')) return;
  if (screen === 'options' && keyCapture) { e.preventDefault(); captureKey(e); return; }
  if (screen === 'calibrate' && calib.running && !['Escape', 'Tab'].includes(k)) { e.preventDefault(); if (!e.repeat) calibrationTap(eventPerf(e)); return; }

  const go = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 };
  switch (screen) {
    case 'intro': skipIntro(); break;
    case 'title':
      if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); menuMove($('.title-menu'), go[k]); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); menuActivate($('.title-menu')); }
      break;
    case 'select':
      if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); moveSong(go[k]); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); moveDifficulty(go[k]); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); startGame(); }
      else if (k === 'Tab') { e.preventDefault(); sel.autoPlay = !sel.autoPlay; renderSelect(); }
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); show('title'); }
      else if (code === 'KeyO') { optionsReturn = 'select'; show('options'); }
      break;
    case 'options':
      if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); optionIndex = (optionIndex + go[k] + OPTION_ROWS.length) % OPTION_ROWS.length; renderOptions(); $('.option-row.selected')?.scrollIntoView({ block: 'nearest' }); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); stepOption(optionIndex, go[k]); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); activateOption(optionIndex); }
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); show(optionsReturn); }
      break;
    case 'calibrate':
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); menuMove($('.calibrate-actions'), go[k]); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); menuActivate($('.calibrate-actions')); }
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); show('options'); }
      break;
    case 'bonus':
      if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); bonusIndex += go[k]; renderBonus(); }
      else if (k === 'Escape' || k === 'Backspace' || k === 'Enter') { e.preventDefault(); show('title'); }
      break;
    case 'result':
      if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); menuMove($('.result-actions'), go[k]); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); menuActivate($('.result-actions')); }
      else if (code === 'KeyR') startGame();
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); show('select'); }
      break;
  }
}
function onKeyUp(e) {
  if (screen !== 'play') return;
  const lane = laneKeys().indexOf(e.code);
  if (lane >= 0) releaseLane(lane, eventPerf(e));
}

// touch / pointer lanes: the whole lane column is the hit zone
function laneAtPoint(clientX, clientY) {
  const rect = board.canvas.getBoundingClientRect(), x = (clientX - rect.left) * board.dpr, y = Math.max(board.topY, (clientY - rect.top) * board.dpr);
  const s = Math.max(board.far, sAtY(y)), left = edgeX(0, s), width = edgeX(LANES, s) - left;
  return Math.max(0, Math.min(LANES - 1, Math.floor((x - left) / width * LANES)));
}
$('#game').addEventListener('pointerdown', e => {
  if (screen !== 'play' || !run || run.paused || e.target.closest('button')) return;
  e.preventDefault(); ensureAudio();
  const lane = laneAtPoint(e.clientX, e.clientY);
  pointerLanes.set(e.pointerId, lane);
  try { $('#game').setPointerCapture(e.pointerId); } catch {}
  pressLane(lane, eventPerf(e));
});
$('#game').addEventListener('pointermove', e => {
  if (!pointerLanes.has(e.pointerId) || !run) return;
  // sliding a finger onto another lane re-targets it (feels natural on phones); holds keep their lane
  const lane = laneAtPoint(e.clientX, e.clientY), prev = pointerLanes.get(e.pointerId);
  if (lane === prev || run.lanes[prev].some(n => n.state === HOLDING)) return;
  pointerLanes.set(e.pointerId, lane);
  if (![...pointerLanes.values()].includes(prev)) releaseLane(prev, eventPerf(e));
  pressLane(lane, eventPerf(e));
});
const pointerEnd = e => {
  if (!pointerLanes.has(e.pointerId)) return;
  const lane = pointerLanes.get(e.pointerId); pointerLanes.delete(e.pointerId);
  if (![...pointerLanes.values()].includes(lane)) releaseLane(lane, eventPerf(e));
};
$('#game').addEventListener('pointerup', pointerEnd);
$('#game').addEventListener('pointercancel', pointerEnd);
$('#calibrate-pulse').addEventListener('pointerdown', e => { e.preventDefault(); calibrationTap(eventPerf(e)); });

// syuP MODE on touch devices (as in Ver.1): tap the title character 20 times, less than a second apart
$('.title-character').addEventListener('pointerdown', () => { if (screen !== 'title') return; const now = performance.now(); dev.taps = now - dev.tapAt > 1000 ? 1 : dev.taps + 1; dev.tapAt = now; if (dev.taps >= 20) { dev.taps = 0; setSyuPMode(!syuPMode); } });
document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
['pointerdown', 'touchend', 'click'].forEach(type => document.addEventListener(type, () => { if (screen !== 'intro') ensureAudio(); }, { passive: true }));
document.addEventListener('visibilitychange', () => { if (document.hidden && screen === 'play' && !promoMode) pauseGame(); });
window.addEventListener('blur', () => { if (screen === 'play') releaseAllLanes(); });
window.addEventListener('resize', () => { if (screen === 'play') resizeBoard(); if (screen === 'result' && lastResult) { drawTimeline(lastResult); drawHistogram(lastResult); } });

document.addEventListener('click', e => {
  const card = e.target.closest('.song-card');
  if (card && screen === 'select') { const i = Number(card.dataset.song); if (i === sel.song) startGame(); else { sel.song = i; renderSelect(); } return; }
  const tab = e.target.closest('.diff-tab');
  if (tab && screen === 'select') { const id = tab.dataset.diff; if (id === currentDiff() && matchMedia('(pointer:coarse)').matches) startGame(); else setDifficulty(id); return; }
  if (screen === 'options') {
    const step = e.target.closest('.opt-step'), main = e.target.closest('.opt-main'), row = e.target.closest('.option-row');
    if (row) optionIndex = Number(row.dataset.row);
    if (step) { stepOption(optionIndex, Number(step.dataset.step)); return; }
    if (main) { const r = OPTION_ROWS[optionIndex]; if (r.values && r.values.length > 2 && !(r.key === 'keys' && settings.keys === 'custom')) stepOption(optionIndex, 1); else activateOption(optionIndex); return; }
    if (row) { renderOptions(); return; }
  }
  const action = e.target.closest('[data-action]')?.dataset.action; if (!action) { if (screen === 'intro') skipIntro(); return; }
  e.target.closest('button')?.blur();
  const actions = {
    'title-start': () => show('select'),
    'title-bonus': () => hasBonusUnlocked() && show('bonus'),
    'title-options': () => { optionsReturn = 'title'; show('options'); },
    'open-options': () => { optionsReturn = screen; show('options'); },
    'options-back': () => show(optionsReturn),
    'select-back': () => show('title'),
    'song-prev': () => moveSong(-1), 'song-next': () => moveSong(1),
    'toggle-autoplay': () => { sel.autoPlay = !sel.autoPlay; renderSelect(); },
    'start': () => startGame(),
    'pause': () => pauseGame(),
    'pause-resume': () => resumeGame(),
    'pause-retry': () => startGame(),
    'pause-select': () => show('select'),
    'result-retry': () => startGame(),
    'result-select': () => show('select'),
    'result-title': () => show('title'),
    'apply-offset': () => { const v = Number(e.target.closest('[data-offset]').dataset.offset); settings.offsetMs = v; saveSettings(); toast(`TIMING OFFSET を ${v > 0 ? '+' : ''}${v} ms にしました`); $('#result-offset-tip').hidden = true; },
    'calibrate-start': () => startCalibration(),
    'calibrate-apply': () => applyCalibration(),
    'calibrate-back': () => show('options'),
    'bonus-prev': () => { bonusIndex--; renderBonus(); }, 'bonus-next': () => { bonusIndex++; renderBonus(); },
    'bonus-back': () => show('title')
  };
  actions[action]?.();
});

// swipe on the select carousel
(() => {
  let sx = null;
  $('#song-cards').addEventListener('pointerdown', e => { sx = e.clientX; }, { passive: true });
  $('#song-cards').addEventListener('pointerup', e => { if (sx === null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) { moveSong(dx < 0 ? 1 : -1); e.preventDefault(); suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); } });
})();
let suppressClick = false;
document.addEventListener('click', e => { if (suppressClick) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);

function skipIntro() { clearTimeout(introTimer); if (screen === 'intro') show('title'); }

// ───────────────────────────── boot ─────────────────────────────
async function init() {
  data = await fetch('songs.json').then(r => r.json());
  songs = (data.songs || []).filter(s => s.playable !== false).map(resolveSong);
  migrateRecords();
  buildSongCards();
  $('#syup-badge').hidden = !syuPMode;
  if (promoMode) {
    document.body.classList.add('promo-mode'); $('#promo-badge').hidden = false;
    const s = Number(promoParams.get('song')); if (Number.isInteger(s) && s >= 0 && s < songs.length) sel.song = s;
    const d = (promoParams.get('difficulty') || 'hard').toLowerCase(); sel.diffId = DIFFS.includes(d) ? d : 'hard';
    syuPMode = true;   // promo capture may film any difficulty; it never records
    await startGame(); return;
  }
  show('intro');
  introTimer = setTimeout(() => { if (screen === 'intro') show('title'); }, 2600);
  // warm the chart cache for the remembered song
  songs[sel.song] && Object.values(songs[sel.song].charts).forEach(c => loadChart(c).catch(() => {}));
}

// ───────────────────────────── bridge (dev / promo tooling) ─────────────────────────────
window.rhythmGameBridge = Object.freeze({
  getScreen: () => screen,
  isPlaying: () => !!run && run.started && !run.paused && !run.ended,
  isPaused: () => !!run?.paused,
  getCurrentRun: () => run && { songId: run.song.id, difficultyId: run.diff, autoPlay: run.autoPlay, score: scoreOf(run), combo: run.combo, counts: { ...run.counts }, judged: run.judged, objects: run.objects, hp: run.hp, ended: run.ended },
  onScreenChange: fn => gameEvents.screen.push(fn),
  onRunStart: fn => gameEvents.runStart.push(fn),
  createDefaultSave,
  replaceSaveData: value => { saveData = value; },
  getSave: () => saveData,
  saveGame: persist,
  show,
  ensureAudioContext: ensureAudio,
  renderFrameAt,
  songTime: () => clockNow(),
  getPromoCaptureState: () => ({ song: run?.song, chart: run?.chart, difficulty: run?.diff, screen, playing: !!run && run.started && !run.ended })
});
init().catch(error => { console.error(error); document.body.insertAdjacentHTML('beforeend', '<p class="fatal">ゲームデータを読み込めませんでした。ローカルサーバー経由で開いてください。</p>'); });
