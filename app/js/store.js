/* Everything the app remembers, in localStorage.
 *
 * Two things are kept, and they do different jobs:
 *
 *   observations   every answer ever given, with the word's difficulty. The
 *                  ability estimate is refitted from the whole history each
 *                  time, so a session six months ago still counts (less, by
 *                  design -- see the half-life in ability.js).
 *   schedule       Leitner boxes, for deciding what to put in front of you next.
 *
 * Kept per device on purpose: no account, no sync, nothing leaves the phone.
 */

const KEY = 'wordhoard.v1';
const MAX_OBS = 20000;

const blank = () => ({
  v: 1,
  created: Date.now(),
  observations: [],
  history: [],          // one entry per completed estimate, for the trend
  schedule: {},         // word -> { box, due, seen, missed }
  starred: [],
  sessions: 0,
  lastPlayed: null,
  streak: 0,
  settings: { rapidLength: 20, rapidSeconds: 12, packs: ['precision', 'rare', 'builtform'], theme: 'auto' },
});

let state = null;

export function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? { ...blank(), ...JSON.parse(raw) } : blank();
    state.settings = { ...blank().settings, ...(state.settings || {}) };
  } catch {
    // A corrupt or unavailable store must not stop you playing; you just start
    // over rather than seeing an error you can do nothing about.
    state = blank();
  }
  return state;
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (state.observations.length > MAX_OBS) {
        state.observations = state.observations.slice(-MAX_OBS);
      }
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch { /* quota or private mode: play on, just without a record */ }
  }, 250);
}

/** Record one answer. `b` is the word's prevalence -- the whole point of the row. */
export function record({ word, b, kind, options, ok, mode, pseudo = false, calibrated = true }) {
  const s = load();
  s.observations.push({
    w: word, b: calibrated ? b : null, kind, options, ok: ok ? 1 : 0,
    t: Date.now(), m: mode, ...(pseudo ? { pseudo: 1 } : {}),
  });
  return s;
}

const DAY = 86400000;
// Leitner intervals in days. Box 0 is "just missed it, show me again today".
const BOXES = [0, 1, 3, 7, 21, 60];

export function schedule(word, correct) {
  const s = load();
  const e = s.schedule[word] || { box: 0, due: 0, seen: 0, missed: 0 };
  e.seen++;
  if (correct) e.box = Math.min(BOXES.length - 1, e.box + 1);
  else { e.box = 0; e.missed++; }
  e.due = Date.now() + BOXES[e.box] * DAY;
  s.schedule[word] = e;
  return e;
}

/** Words that are due, most overdue first -- the queue Training works through. */
export function dueWords(now = Date.now()) {
  const s = load();
  return Object.entries(s.schedule)
    .filter(([, e]) => e.due <= now)
    .sort((a, b) => a[1].due - b[1].due)
    .map(([w]) => w);
}

export function toggleStar(word) {
  const s = load();
  const i = s.starred.indexOf(word);
  if (i >= 0) s.starred.splice(i, 1); else s.starred.push(word);
  save();
  return i < 0;
}

export const isStarred = (word) => load().starred.includes(word);

/** Called once per finished session: bumps the streak if it is a new day. */
export function noteSession() {
  const s = load();
  const today = new Date().toDateString();
  const last = s.lastPlayed ? new Date(s.lastPlayed).toDateString() : null;
  if (last !== today) {
    const yesterday = new Date(Date.now() - DAY).toDateString();
    s.streak = last === yesterday ? s.streak + 1 : 1;
  }
  s.lastPlayed = Date.now();
  s.sessions++;
  save();
  return s;
}

export function pushEstimate(entry) {
  const s = load();
  s.history.push({ t: Date.now(), ...entry });
  save();
  return s.history;
}

export function reset() {
  state = blank();
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
  return state;
}

export function exportJSON() {
  return JSON.stringify(load(), null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.observations)) {
    throw new Error('That does not look like a Wordhoard export.');
  }
  state = { ...blank(), ...parsed };
  save();
  return state;
}
