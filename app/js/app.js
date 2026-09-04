/* Screens, and the loop that runs a round.
 *
 * One runner drives every mode, because they all answer the same three
 * questions: what is next, was that right, and how did the round go. The
 * differences that remain -- a clock, a text box, two buttons instead of four --
 * are read off the question, not off the mode.
 *
 * The round moves on by itself. On a phone, making someone tap an answer and
 * then hunt for a Next button doubles the taps and breaks the rhythm; instead
 * the verdict appears, a line runs down showing how long you have to read it,
 * and a tap anywhere skips ahead.
 */
import { loadPack, getPack } from './data.js';
import * as S from './store.js';
import * as M from './modes.js';
import * as Speech from './speech.js';
import { FORMS_PER_LEMMA, ANCHORS, vocabularyAt } from './ability.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const n0 = (x) => Math.round(x).toLocaleString('en-CA');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

/* Each mode gets a mark, because five lines of text all set the same way take
   as long to tell apart as reading them does. */
const ICON = {
  speak: ['M4 9h3.2L11 5.2v13.6L7.2 15H4z', 'M15 9.4a3.8 3.8 0 0 1 0 5.2', 'M17.6 6.6a7.5 7.5 0 0 1 0 10.8'],
  star: ['M12 3.4l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 17.1 6.7 19.9l1.1-6L3.4 9.7l6-.8z'],
  chevron: ['M9 5l7 7-7 7'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  cross: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  rapid: ['M13 2.5 5.5 13.5H11L10 21.5 18.5 10.5H13z'],
  estimate: ['M3.5 18a8.5 8.5 0 0 1 17 0', 'M12 18l4.2-5.4', 'M4.6 13.2h1.6M12 8.4v1.6M19.4 13.2h-1.6'],
  train: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z'],
  sharpen: ['M12 2.8 6.4 12l5.6 9.2L17.6 12z', 'M6.4 12h11.2'],
  recall: ['M4.5 19.5l3.4-.9L19 7.5a1.8 1.8 0 0 0-2.5-2.5L5.4 16.1z', 'M15.4 6.1l2.5 2.5'],
};

function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** A progress ring. A proportion reads faster as an arc than as a sentence. */
function ring(fraction, value, caption) {
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = el('span', 'ring');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', 'ringGrad');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
  for (const [offset, color] of [['0%', '#d3a04a'], ['100%', '#eac274']]) {
    const stop = document.createElementNS(NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.append(stop);
  }
  defs.append(grad);
  svg.append(defs);
  const R = 44, C = 2 * Math.PI * R;
  for (const cls of ['track', 'value']) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', String(R));
    c.setAttribute('fill', 'none');
    c.setAttribute('class', cls);
    if (cls === 'value') {
      c.setAttribute('stroke-dasharray', String(C));
      c.setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, Math.min(1, fraction)))));
    }
    svg.append(c);
  }
  const label = el('span', 'ring-label');
  label.append(el('span', 'ring-pct', value), el('span', 'ring-cap', caption));
  wrap.append(svg, label);
  return wrap;
}

const SCREENS = ['home', 'play', 'result', 'progress', 'settings', 'about'];
function show(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  // The stylesheet re-points its colour tokens off this: the shelf is the deep
  // world, every other screen is its inverse.
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

const MODES = [
  {
    id: 'rapid', name: 'Rapid Fire', tag: '20 questions',
    desc: 'Timed multiple choice that follows your level. The main scoreboard.',
    start: () => {
      const st = S.load().settings;
      return M.rapidSession({ packs: st.packs, length: st.rapidLength, seconds: st.rapidSeconds });
    },
  },
  {
    id: 'estimate', name: 'Take the Measure', tag: '~90 words',
    desc: 'The calibrated test: how many words you know, with invented words and spot checks to keep you honest.',
    start: () => M.estimateSession(),
  },
  {
    id: 'train', name: 'Training', tag: 'spaced',
    desc: 'The words you have missed or starred, returning on a schedule until they stick.',
    start: () => M.trainSession(),
  },
  {
    id: 'sharpen', name: 'Sharpen', tag: 'usage',
    desc: 'Words you already think you know, used the way they actually mean.',
    start: () => M.sharpenSession(),
  },
  {
    id: 'recall', name: 'Summon', tag: 'write it',
    desc: 'Meaning first — you produce the word. The step from recognising to using.',
    start: () => {
      const st = S.load().settings;
      return M.recallSession({ packs: st.packs.filter((p) => p !== 'core') });
    },
  },
];

/* ------------------------------------------------------------------ speech */

const speechOn = () => S.load().settings.speak !== 'off';
const speakPrompts = () => S.load().settings.speak === 'both' || S.load().settings.speak === 'prompt';
const speakAnswers = () => S.load().settings.speak === 'both' || S.load().settings.speak === 'answer';

function speakButton(word, { small = false } = {}) {
  if (!Speech.available()) return null;
  const b = el('button', small ? 'wl-speak' : 'speak-btn');
  b.type = 'button';
  b.setAttribute('aria-label', `Say “${word}” aloud`);
  b.append(icon(ICON.speak));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    Speech.speak(word);
    b.classList.add('speaking');
    setTimeout(() => b.classList.remove('speaking'), 900);
  });
  return b;
}

/* -------------------------------------------------------------------- home */

/** Real words from the bank, piled up. The hero says what the tool is. */
function renderHoard() {
  const box = $('hoard');
  box.replaceChildren();
  const pack = getPack();
  // precision + built form only: the hero should show words worth owning,
  // not the odd corners of the long tail.
  const pool = ['precision', 'builtform'].flatMap((p) => pack.byPack.get(p) || []);
  if (!pool.length) return;
  const seen = new Set();
  const items = [];
  const SIZES = ['w-lg', 'w-lg', 'w-md', 'w-md', 'w-md', 'w-md', 'w-sm', 'w-sm', 'w-sm',
    'w-sm', 'w-sm', 'w-sm', 'w-xs', 'w-xs', 'w-xs', 'w-xs', 'w-xs', 'w-xs', 'w-xs', 'w-xs'];
  for (let guard = 0; items.length < SIZES.length && guard < 900; guard++) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!w || seen.has(w.w) || w.w.length > 12 || w.w.length < 4) continue;
    seen.add(w.w);
    items.push({ word: w.w, size: SIZES[items.length] });
  }
  // Shuffle after sizing, so the big words are scattered through the pile
  // instead of stacked at the front of it.
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  let hot = 0;
  for (const it of items) {
    const isHot = it.size === 'w-lg' && hot++ < 2;
    box.append(el('span', `${it.size}${isHot ? ' w-hot' : ''}`, it.word));
  }
}

function modeRow(m, { lead = false, tag, disabled = false } = {}) {
  const b = el('button', `mode${lead ? ' lead' : ''}`);
  b.type = 'button';
  b.disabled = disabled;
  const tile = el('span', 'mode-ico');
  tile.append(icon(ICON[m.id] || ICON.rapid));
  const body = el('span', 'mode-body');
  body.append(el('span', 'mode-name', m.name), el('span', 'mode-desc', m.desc));
  if (tag) body.append(el('span', 'mode-tag', tag));
  const go = el('span', 'mode-go');
  go.append(icon(ICON.chevron));
  b.append(tile, body, go);
  if (!disabled) b.addEventListener('click', () => startMode(m));
  return b;
}

function renderHome() {
  const st = S.load();
  const fit = M.currentAbility();
  renderHoard();

  const card = $('estimate-card-inner');
  card.replaceChildren();
  if (fit.trials < 12) {
    card.append(
      el('span', 'eyebrow', 'Your vocabulary'),
      el('span', 'est-empty',
        'Not measured yet. Take the Measure runs about ninety words and gives you a '
        + 'number with an honest margin around it.'),
      el('span', 'est-cta', 'Start the measurement'),
    );
  } else {
    const v = M.vocabulary(fit);
    const met = Object.keys(st.schedule).length;
    const settled = Object.values(st.schedule).filter((e) => e.box >= 4).length;
    const frac = met ? settled / met : 0;

    const top = el('span', 'est-top');
    top.append(ring(frac, `${Math.round(frac * 100)}%`, 'settled'));
    const figs = el('span', 'est-figures');
    const num = el('span', 'est-number', n0(v.lemmas));
    num.append(el('span', 'est-unit', 'lemmas'));
    figs.append(el('span', 'eyebrow', 'Your vocabulary'), num);
    top.append(figs);

    const bandWrap = el('span', 'band');
    const lo = 8000, hi = 62000;
    const at = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
    const fill = el('span', 'band-fill');
    fill.style.left = `${at(v.lo)}%`;
    fill.style.width = `${Math.max(2, at(v.hi) - at(v.lo))}%`;
    const mark = el('span', 'band-mark');
    mark.style.left = `${at(v.lemmas)}%`;
    bandWrap.append(fill, mark);

    card.append(top, bandWrap,
      el('span', 'est-range',
        `${n0(v.lo)}–${n0(v.hi)} · from ${n0(fit.trials)} answers`),
      el('span', 'est-cta', 'How this is worked out'));
  }

  const waiting = S.dueWords().length + st.starred.length;
  const slot = $('due-slot');
  slot.replaceChildren();
  if (waiting) slot.append(el('div', 'chip due full', `${waiting} words due for review`));

  const byId = Object.fromEntries(MODES.map((m) => [m.id, m]));
  const main = $('modes');
  main.replaceChildren();
  main.append(
    modeRow(byId.rapid, { lead: true, tag: `${st.settings.rapidLength} questions` }),
    modeRow(byId.train, {
      tag: waiting ? `${waiting} due right now` : 'nothing due yet', disabled: !waiting,
    }),
    modeRow(byId.estimate, { tag: fit.trials < 12 ? 'not measured yet' : 'refresh the number' }),
  );

  const more = $('modes-more');
  more.replaceChildren();
  more.append(modeRow(byId.sharpen), modeRow(byId.recall));
  $('more-label').hidden = false;

  $('streak-line').textContent = st.streak > 0
    ? `${st.streak}-day streak · ${st.sessions} rounds`
    : `${st.sessions} rounds played`;
  show('home');
}

/* ------------------------------------------------------------- the runner */

let session = null;
let lastMode = null;
let question = null;
let locked = false;
let timerId = null;
let timerEnds = 0;
let hiddenAt = 0;
let hintId = null;
let advanceId = null;
let advanceRaf = null;

function startMode(m) {
  session = m.start();
  if (!session.total) { renderHome(); return; }
  lastMode = m.id;
  show('play');
  nextQuestion();
}

function clearTimers() {
  cancelAnimationFrame(timerId);
  cancelAnimationFrame(advanceRaf);
  clearTimeout(hintId);
  clearTimeout(advanceId);
  timerId = hintId = advanceId = advanceRaf = null;
}

function nextQuestion() {
  clearTimers();
  Speech.stop();
  locked = false;
  question = session.next();
  if (!question) return finishRound();

  $('feedback').hidden = true;
  $('continue-row').hidden = true;
  $('progress-fill').style.width = `${(session.index / session.total) * 100}%`;
  $('play-count').textContent = `${Math.min(session.index, session.total)} / ${session.total}`;
  // Streak and clock sit above the question as a warm pill and a bare number,
  // so a run in progress and time running out are both visible without reading.
  const meta = $('play-meta');
  meta.replaceChildren();
  if (session.mode === 'rapid' && session.streak > 1) {
    meta.append(el('div', 'streak-pill', `${session.streak} in a row`));
  }
  if (session.seconds) meta.append(el('div', 'clock', `${session.seconds.toFixed(1)}s`));
  if (session.mode === 'rapid') {
    const chip = $('score-chip');
    chip.hidden = false;
    chip.textContent = `${session.score.toLocaleString('en-CA')} points`;
  } else {
    $('score-chip').hidden = true;
  }

  renderQuestion(question);
  if (session.seconds) startClock(session.seconds);
}

function renderQuestion(q) {
  const qBox = $('question');
  qBox.replaceChildren();
  if (q.prompt.lead) qBox.append(el('div', 'q-lead eyebrow', q.prompt.lead));

  if (q.prompt.style === 'word') {
    const row = el('div', 'q-headline');
    row.append(el('h2', 'q-word', q.prompt.text));
    const sb = speakButton(q.prompt.text);
    if (sb) row.append(sb);
    qBox.append(row);
    // Hearing the word as it appears is the point: you cannot use a word you
    // are not sure how to say.
    if (speakPrompts()) Speech.speak(q.prompt.text);
  } else if (q.prompt.style === 'sentence') {
    const p = el('div', 'q-sentence');
    const [before, after] = q.prompt.text.split('____');
    // A run of spaces collapses to one in HTML, so the blank has to be an
    // element with a width of its own.
    p.append(document.createTextNode(before), el('span', 'blank'), document.createTextNode(after || ''));
    qBox.append(p);
  } else {
    qBox.append(el('div', 'q-def', q.prompt.text));
  }
  if (q.ask) qBox.append(el('div', 'q-ask', q.ask));

  const box = $('options');
  box.replaceChildren();
  box.className = 'options';

  if (q.kind === 'yesno') {
    box.classList.add('yesno');
    for (const [value, label] of [['yes', 'I know it'], ['no', 'No']]) {
      const b = el('button', 'opt');
      b.type = 'button';
      b.append(el('span', null, label));
      b.addEventListener('click', () => submit(value));
      box.append(b);
    }
    return;
  }

  if (q.kind === 'recall') {
    box.classList.add('recall-row');
    const input = el('input', 'recall-input');
    Object.assign(input, {
      type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
      placeholder: 'the word…',
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) submit(input.value);
    });
    const go = el('button', 'btn primary', 'Check');
    go.type = 'button';
    go.addEventListener('click', () => submit(input.value));
    box.append(input, go);
    input.focus();
    // A blank prompt with no way in is a dead end, so the shape of the word
    // arrives if you sit with it.
    hintId = setTimeout(() => {
      if (!locked) box.insertBefore(el('div', 'recall-hint', q.hint), go);
    }, 9000);
    return;
  }

  q.options.forEach((opt, i) => {
    const b = el('button', 'opt');
    b.type = 'button';
    b.append(el('span', 'opt-key', KEYS[i]), el('span', 'opt-text', opt.text));
    b.addEventListener('click', () => submit(opt));
    box.append(b);
  });
}

function startClock(seconds) {
  const bar = $('timer');
  const fill = $('timer-fill');
  bar.hidden = false;
  bar.classList.remove('urgent');
  timerEnds = performance.now() + seconds * 1000;
  hiddenAt = 0;
  const readout = $('play-meta').querySelector('.clock');
  const tick = () => {
    const left = timerEnds - performance.now();
    const frac = Math.max(0, left / (seconds * 1000));
    fill.style.width = `${frac * 100}%`;
    if (readout) readout.textContent = `${Math.max(0, left / 1000).toFixed(1)}s`;
    if (frac < 0.25) {
      bar.classList.add('urgent');
      if (readout) readout.classList.add('urgent');
    }
    if (left <= 0) {
      // Running out is an answer. This is where an earlier version threw,
      // because the timeout path had no chosen option to work with.
      submit(null);
      return;
    }
    timerId = requestAnimationFrame(tick);
  };
  tickClock = tick;
  timerId = requestAnimationFrame(tick);
}

let tickClock = () => {};

/* The clock stops when the screen does. requestAnimationFrame does not run in a
   backgrounded tab, so without this the deadline would quietly pass while the
   phone was locked and the question would be wrong the moment you returned. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) Speech.stop();
  if (!session || !session.seconds || locked) return;
  if (document.hidden) {
    hiddenAt = performance.now();
    cancelAnimationFrame(timerId);
  } else if (hiddenAt) {
    timerEnds += performance.now() - hiddenAt;
    hiddenAt = 0;
    timerId = requestAnimationFrame(tickClock);
  }
});

function submit(choice) {
  if (locked || !question) return;
  locked = true;
  clearTimers();
  $('timer').hidden = true;
  const msLeft = session.seconds ? Math.max(0, timerEnds - performance.now()) : 0;
  const outcome = session.answer(question, choice, msLeft);
  if (outcome.deferred) { nextQuestion(); return; }   // a spot check follows
  showVerdict(question, choice, outcome);
}

function showVerdict(q, choice, outcome) {
  const box = $('options');
  if (q.kind === 'mcq') {
    [...box.children].forEach((btn, i) => {
      btn.disabled = true;
      const opt = q.options[i];
      const key = btn.querySelector('.opt-key');
      // A tick and a cross land before a letter does, and they say the same
      // thing without being read.
      if (opt.correct) {
        btn.classList.add('right');
        if (key) key.replaceChildren(icon(ICON.check));
      } else if (opt === choice) {
        btn.classList.add('wrong');
        if (key) key.replaceChildren(icon(ICON.cross));
      } else {
        btn.classList.add('dim');
      }
    });
  } else {
    [...box.children].forEach((c) => { c.disabled = true; });
  }

  const fb = $('feedback');
  fb.replaceChildren();
  fb.className = 'verdict';
  const pack = getPack();
  const full = q.word && pack.byWord.get(q.word.w);
  const target = q.word && q.word.w;
  let spoke = false;

  if (outcome.ok === null) {
    // Yes/no has no right answer to report, so it says what the item was for.
    if (q.pseudo) {
      fb.classList.add(outcome.claimed ? 'is-wrong' : 'is-right');
      fb.append(el('div', `fb-head ${outcome.claimed ? 'wrong' : 'right'}`,
        outcome.claimed ? 'Not a word' : 'Correct — not a word'));
      fb.append(el('div', 'fb-def',
        'Invented words are mixed in to measure over-claiming. Without them a '
        + 'yes/no test measures confidence rather than vocabulary.'));
    } else {
      fb.append(el('div', 'fb-def', outcome.claimed ? 'Noted.' : 'Noted — no shame in it.'));
      if (outcome.claimed && speakAnswers() && target) spoke = Speech.speak(target);
    }
  } else {
    fb.classList.add(outcome.ok ? 'is-right' : 'is-wrong');
    fb.append(el('div', `fb-head ${outcome.ok ? 'right' : 'wrong'}`,
      outcome.ok ? 'Right' : (choice === null ? 'Out of time' : 'Not that one')));

    if (target && (q.kind === 'recall' || !outcome.ok || q.prompt.style !== 'word')) {
      const row = el('div', 'fb-answer');
      row.append(el('span', 'fb-word', target));
      const sb = speakButton(target, { small: true });
      if (sb) row.append(sb);
      fb.append(row);
      if (full && full.def) fb.append(el('div', 'fb-def', full.def));
    } else if (!outcome.ok && outcome.correctOption) {
      fb.append(el('div', 'fb-def', outcome.correctOption.text));
    }

    // Say the word that was actually being tested, right or wrong -- that is
    // the one worth being able to pronounce.
    if (speakAnswers() && target && !q.pseudo) spoke = Speech.speak(target);

    if (q.explain) fb.append(el('div', 'fb-note', q.explain));
    else if (full && full.note) fb.append(el('div', 'fb-note', full.note));
  }

  fb.hidden = false;
  const last = session.index >= session.total;
  $('advance').textContent = last ? 'See the result' : 'Continue';
  $('continue-row').hidden = false;
  scheduleAdvance(fb.textContent.length, outcome.ok === false, spoke);
}

/**
 * How long the verdict stays up.
 * Right answers get out of the way; wrong ones give you time to read what the
 * word actually meant, scaled to how much there is to read.
 */
function scheduleAdvance(chars, wrong, spoke) {
  const base = wrong ? 2000 : 900;
  const reading = Math.min(4500, chars * 26);
  const ms = Math.min(7000, base + (wrong ? reading : Math.min(900, reading))) + (spoke ? 500 : 0);
  const fill = $('continue-fill');
  const started = performance.now();
  const tick = () => {
    const frac = Math.max(0, 1 - (performance.now() - started) / ms);
    fill.style.width = `${frac * 100}%`;
    if (frac > 0) advanceRaf = requestAnimationFrame(tick);
  };
  advanceRaf = requestAnimationFrame(tick);
  advanceId = setTimeout(nextQuestion, ms);
}

/* A tap anywhere on the question moves on -- the whole screen is the button
   once the verdict is up. Real controls keep their own behaviour. */
$('screen-play').addEventListener('click', (e) => {
  if (!locked || $('continue-row').hidden) return;
  if (e.target.closest('button')) return;
  nextQuestion();
});
$('advance').addEventListener('click', nextQuestion);
$('quit').addEventListener('click', () => {
  clearTimers();
  Speech.stop();
  session = null;
  renderHome();
});
$('again').addEventListener('click', () => {
  const m = MODES.find((x) => x.id === lastMode);
  if (m) startMode(m); else renderHome();
});
for (const b of document.querySelectorAll('[data-go]')) {
  b.addEventListener('click', () => {
    const to = b.dataset.go;
    if (to === 'home') renderHome();
    else if (to === 'progress') renderProgress();
    else if (to === 'settings') renderSettings();
    else if (to === 'about') renderAbout();
  });
}
$('estimate-card').addEventListener('click', () => {
  const fit = M.currentAbility();
  if (fit.trials < 12) startMode(MODES.find((m) => m.id === 'estimate'));
  else renderAbout();
});

function finishRound() {
  // summary() is what banks the round -- the streak, the session count, the
  // stored estimate -- so it must happen exactly once however we got here.
  if (!session || session.done) return;
  session.done = true;
  clearTimers();
  Speech.stop();
  const summary = session.summary();
  $('options').replaceChildren();
  $('continue-row').hidden = true;
  renderResult(summary);
  show('result');
}

/* ---------------------------------------------------------------- results */

function section(title) {
  const s = el('section', 'section');
  if (title) s.append(el('h3', null, title));
  return s;
}

function wordListSection(title, words, { note } = {}) {
  if (!words.length) return null;
  const s = section(title);
  if (note) s.append(el('p', 'tight', note));
  const list = el('div', 'wordlist');
  for (const w of words.slice(0, 40)) {
    const full = getPack().byWord.get(w.w) || w;
    const item = el('div', 'wl-item');
    const left = el('div');
    const head = el('div', 'wl-word', full.w);
    if (full.posName) head.append(el('span', 'wl-pos', full.posName));
    left.append(head);
    if (full.def) left.append(el('div', 'wl-def', full.def));
    if (full.note) left.append(el('div', 'wl-note', full.note));

    const tools = el('div', 'wl-tools');
    const sb = speakButton(full.w, { small: true });
    if (sb) tools.append(sb);
    const star = el('button', `star${S.isStarred(full.w) ? ' on' : ''}`);
    star.type = 'button';
    star.setAttribute('aria-label', `Keep “${full.w}” coming back`);
    star.append(icon(ICON.star));
    star.addEventListener('click', () => star.classList.toggle('on', S.toggleStar(full.w)));
    tools.append(star);

    item.append(left, tools);
    list.append(item);
  }
  s.append(list);
  return s;
}

function renderResult(sum) {
  const body = $('result-body');
  body.replaceChildren();
  if (sum.mode === 'estimate') return renderEstimateResult(sum, body);

  const head = el('div', 'result-head');
  head.append(el('div', 'eyebrow', sum.mode === 'rapid' ? 'Score' : 'This round'));
  head.append(el('div', 'result-score',
    sum.mode === 'rapid' ? sum.score.toLocaleString('en-CA') : `${sum.correct}/${sum.total}`));
  head.append(el('div', 'result-sub', sum.mode === 'rapid'
    ? `${sum.correct} of ${sum.total} right · best run ${sum.bestStreak}`
    : `${pct(sum.correct, sum.total)}% right`));
  body.append(head);

  if (sum.mode === 'sharpen') {
    const missed = (sum.missed || []).filter((m) => m.why);
    if (missed.length) {
      const s = section('Worth a second look');
      for (const m of missed) {
        s.append(el('div', 'wl-word', m.word), el('p', 'tight', m.why));
      }
      body.append(s);
    }
    return;
  }

  const missed = wordListSection('Missed — these come back', sum.missed || [],
    { note: 'Added to Training. Star one to make sure it keeps returning.' });
  if (missed) body.append(missed);

  const fit = M.currentAbility();
  if (fit.trials >= 12) {
    const v = M.vocabulary(fit);
    const s = section('Estimate after this round');
    s.append(el('div', 'big-number', n0(v.lemmas)));
    s.append(el('p', 'tight', `lemmas · ${n0(v.lo)} – ${n0(v.hi)} · ${n0(fit.trials)} answers all told`));
    body.append(s);
  }
}

function renderEstimateResult(sum, body) {
  const v = sum.vocab;
  const head = el('div', 'result-head');
  head.append(el('div', 'eyebrow', 'You know about'));
  head.append(el('div', 'big-number', n0(v.lemmas)));
  head.append(el('div', 'result-sub',
    'lemmas — dictionary words, counting walk / walks / walked once.'));
  head.append(el('div', 'result-sub', `Range: ${n0(v.lo)} to ${n0(v.hi)}`));
  body.append(head);

  const forms = section('In other units');
  forms.append(el('p', null,
    'Counting inflected and transparently derived forms as separate words — which is '
    + 'what tests reporting much larger numbers usually do — that is roughly '
    + `${n0(v.lemmas * FORMS_PER_LEMMA)} word forms.`));
  forms.append(el('p', null,
    'The conversion is a convention, not a measurement. Numbers from different '
    + 'vocabulary tests are not comparable unless they agree on the unit and on '
    + 'which dictionary they are counting against.'));
  body.append(forms);

  const anchors = section('Against the same scale');
  const dl = el('dl');
  const { hist } = getPack().estimator;
  for (const a of ANCHORS) {
    const row = el('div', 'stat-row');
    row.append(el('dt', null, a.label), el('dd', null, n0(vocabularyAt(a.theta, hist))));
    dl.append(row);
  }
  const you = el('div', 'stat-row is-you');
  you.append(el('dt', null, 'you'), el('dd', null, n0(v.lemmas)));
  dl.append(you);
  anchors.append(dl);
  anchors.append(el('p', null,
    'Both reference points come from the same research as the calibration, so they '
    + 'sit on this scale. Figures from other tests do not.'));
  body.append(anchors);

  const honesty = section('How honest were you?');
  const d2 = el('dl');
  for (const [k, val] of [
    ['Invented words shown', sum.pseudoShown],
    ['Invented words claimed', sum.pseudoClaimed],
    ['Spot checks asked', sum.probes],
    ['Spot checks failed', sum.probesFailed],
  ]) {
    const r = el('div', 'stat-row');
    r.append(el('dt', null, k), el('dd', null, String(val)));
    d2.append(r);
  }
  honesty.append(d2);
  honesty.append(el('p', null, sum.pseudoClaimed === 0 && sum.probesFailed === 0
    ? 'No over-claiming detected, so the estimate has not been discounted.'
    : 'Claimed non-words and failed spot checks both pull the estimate down — that '
      + 'correction is already in the number above.'));
  body.append(honesty);
}

/* --------------------------------------------------------------- settings */

function choiceRow(options, current, onPick) {
  const wrap = el('div', 'choices');
  for (const [value, label] of options) {
    const b = el('button', `choice${String(current) === String(value) ? ' on' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', () => { onPick(value); renderSettings(); });
    wrap.append(b);
  }
  return wrap;
}

function setting(name, desc, control) {
  const s = el('div', 'setting');
  s.append(el('div', 'setting-name', name));
  if (desc) s.append(el('div', 'setting-desc', desc));
  s.append(control);
  return s;
}

function renderSettings() {
  const st = S.load();
  const body = $('settings-body');
  body.replaceChildren();
  const save = (patch) => { Object.assign(st.settings, patch); S.save(); };

  const sound = section('Sound');
  if (Speech.available()) {
    sound.append(setting('Pronunciation',
      'Words are read aloud in the voice your device provides. A word you cannot say is a word you will not use.',
      choiceRow([
        ['off', 'Off'],
        ['prompt', 'On the word'],
        ['answer', 'On the answer'],
        ['both', 'Both'],
      ], st.settings.speak, (v) => {
        save({ speak: v });
        if (v !== 'off') Speech.speak('vocabulary');
      })));
    const vn = Speech.voiceName();
    if (vn) sound.append(el('p', 'tight', `Using ${vn}.`));
  } else {
    sound.append(el('p', null, 'This browser has no speech voices available, so pronunciation is off.'));
  }
  body.append(sound);

  const round = section('Rapid Fire');
  round.append(setting('Questions per round', null,
    choiceRow([[10, '10'], [20, '20'], [50, '50']], st.settings.rapidLength,
      (v) => save({ rapidLength: Number(v) }))));
  round.append(setting('Seconds per question', 'The clock pauses if you leave the app mid-question.',
    choiceRow([[8, '8'], [12, '12'], [20, '20'], [0, 'No clock']], st.settings.rapidSeconds,
      (v) => save({ rapidSeconds: Number(v) }))));
  body.append(round);

  const packs = section('Which words');
  const LABELS = {
    precision: 'Precision', rare: 'Rare & literary',
    builtform: 'Built form & science', core: 'Everyday',
  };
  const chosen = st.settings.packs;
  const wrap = el('div', 'choices');
  for (const key of ['precision', 'rare', 'builtform', 'core']) {
    const on = chosen.includes(key);
    const b = el('button', `choice${on ? ' on' : ''}`, LABELS[key]);
    b.type = 'button';
    b.addEventListener('click', () => {
      const next = on ? chosen.filter((p) => p !== key) : [...chosen, key];
      if (!next.length) return;     // something has to be selected
      save({ packs: next });
      renderSettings();
    });
    wrap.append(b);
  }
  packs.append(setting('Packs drawn from', 'Applies to Rapid Fire and Summon.', wrap));
  body.append(packs);

  show('settings');
}

/* --------------------------------------------------------------- progress */

function sparkline(history) {
  if (history.length < 2) return null;
  const W = 320, H = 128, PAD = 10, LEFT = 36;
  const xs = history.map((h) => h.t);
  const lo = Math.min(...history.map((h) => h.vlo));
  const hi = Math.max(...history.map((h) => h.vhi));
  const t0 = Math.min(...xs), t1 = Math.max(...xs);
  const x = (t) => LEFT + ((t - t0) / Math.max(1, t1 - t0)) * (W - LEFT - PAD);
  const y = (v) => PAD + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - PAD * 2 - 10);

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = mk('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': `Vocabulary estimate over ${history.length} measurements, from `
      + `${n0(history[0].lemmas)} to ${n0(history.at(-1).lemmas)} lemmas`,
  });
  const upper = history.map((h) => `${x(h.t)},${y(h.vhi)}`);
  const lower = history.map((h) => `${x(h.t)},${y(h.vlo)}`).reverse();
  svg.append(mk('polygon', { class: 'band-area', points: [...upper, ...lower].join(' ') }));
  svg.append(mk('polyline', { class: 'line', points: history.map((h) => `${x(h.t)},${y(h.lemmas)}`).join(' ') }));
  for (const h of history) svg.append(mk('circle', { class: 'dot', cx: x(h.t), cy: y(h.lemmas), r: 2.4 }));
  svg.append(mk('text', { class: 'axis-label', x: 0, y: y(hi) + 4 }, n0(hi)));
  svg.append(mk('text', { class: 'axis-label', x: 0, y: y(lo) + 4 }, n0(lo)));
  return svg;
}

function renderProgress() {
  const st = S.load();
  const fit = M.currentAbility();
  const body = $('progress-body');
  body.replaceChildren();

  if (fit.trials < 8) {
    body.append(el('p', 'note', 'Play a round or two and this fills in.'));
    show('progress');
    return;
  }

  const v = M.vocabulary(fit);
  const top = section('Where you stand');
  top.append(el('div', 'big-number', n0(v.lemmas)));
  top.append(el('p', 'tight', `lemmas · ${n0(v.lo)} – ${n0(v.hi)}`));
  top.append(el('p', 'tight', `≈ ${n0(v.lemmas * FORMS_PER_LEMMA)} word forms`));
  body.append(top);

  if (st.history.length >= 2) {
    const s = section('Over time');
    s.append(sparkline(st.history));
    const delta = st.history.at(-1).lemmas - st.history[0].lemmas;
    s.append(el('p', 'tight',
      `${delta >= 0 ? '+' : ''}${n0(delta)} lemmas across ${st.history.length} measurements. `
      + 'Movement inside the shaded band is noise, not progress.'));
    body.append(s);
  }

  const byPack = new Map();
  const pack = getPack();
  for (const o of st.observations) {
    const w = pack.byWord.get(o.w);
    if (!w) continue;
    const e = byPack.get(w.packName) || { n: 0, k: 0 };
    e.n++; if (o.ok) e.k++;
    byPack.set(w.packName, e);
  }
  const LABELS = {
    core: 'Everyday', precision: 'Precision', rare: 'Rare & literary',
    builtform: 'Built form & science',
  };
  if (byPack.size) {
    const s = section('By kind of word');
    const dl = el('dl');
    for (const [k, e] of [...byPack].sort((a, b) => b[1].n - a[1].n)) {
      const row = el('div', 'stat-row');
      row.append(el('dt', null, LABELS[k] || k), el('dd', null, `${pct(e.k, e.n)}% of ${e.n}`));
      dl.append(row);
    }
    s.append(dl);
    body.append(s);
  }

  const rec = section('Records');
  const dl = el('dl');
  const seen = new Set(st.observations.map((o) => o.w)).size;
  const mastered = Object.values(st.schedule).filter((e) => e.box >= 4).length;
  for (const [k, val] of [
    ['Distinct words met', n0(seen)],
    ['Answers recorded', n0(st.observations.length)],
    ['Rounds played', n0(st.sessions)],
    ['Current streak', `${st.streak} day${st.streak === 1 ? '' : 's'}`],
    ['In training', n0(Object.keys(st.schedule).length)],
    ['Settled (box 4+)', n0(mastered)],
    ['Starred', n0(st.starred.length)],
    ['False-alarm rate', `${Math.round(fit.falseAlarm.rate * 100)}%`],
  ]) {
    const row = el('div', 'stat-row');
    row.append(el('dt', null, k), el('dd', null, String(val)));
    dl.append(row);
  }
  rec.append(dl);
  body.append(rec);

  const tools = el('div', 'stack');
  const exp = el('button', 'btn', 'Export my record');
  exp.type = 'button';
  exp.addEventListener('click', () => {
    const json = S.exportJSON();
    // The single-file build runs in a sandbox that never grants downloads, so a
    // download link there is a button that silently does nothing. Show the text
    // instead and say so, rather than pretending it saved.
    if (window.__WORDHOARD_DATA) {
      const s = section('Your record');
      s.append(el('p', 'tight',
        'This build cannot save files, so here it is to copy.'));
      const ta = el('textarea', 'recall-input');
      Object.assign(ta, { value: json, rows: 8, readOnly: true });
      s.append(ta);
      exp.replaceWith(s);
      ta.focus(); ta.select();
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wordhoard-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const wipe = el('button', 'btn danger', 'Erase everything');
  wipe.type = 'button';
  wipe.addEventListener('click', () => {
    if (confirm('Erase every answer, estimate and starred word on this device?')) {
      S.reset();
      renderHome();
    }
  });
  tools.append(exp, wipe);
  body.append(tools);
  show('progress');
}

/* ------------------------------------------------------------------ about */

function renderAbout() {
  const body = $('about-body');
  const meta = getPack().meta;
  body.replaceChildren();

  const how = section('What the number means');
  how.append(el('p', null,
    'Every word here carries a measured difficulty: the proportion of about 220,000 '
    + 'people who said they knew it. That turns each word into a test item whose '
    + 'difficulty is known in advance, rather than assumed from how often it appears in print.'));
  how.append(el('p', null,
    'Your answers fit a single number — how far above or below the average respondent '
    + `you sit. The vocabulary figure is then the sum, across all ${n0(meta.inventory)} `
    + 'words in the reference inventory, of the chance you know each one. It is an '
    + 'expected count, not a tally, which is why it comes with a range.'));
  how.append(el('p', null,
    'Invented words and spot checks exist to catch the obvious failure mode: on a '
    + 'yes/no test, saying yes to everything produces a magnificent score. Claiming a '
    + 'non-word, or failing to define a word you claimed, pulls the estimate down.'));
  body.append(how);

  const limits = section('What it cannot do');
  limits.append(el('p', null,
    `The reference inventory has ${n0(meta.inventory)} words in it, so that is the ceiling. `
    + 'A very large vocabulary will press against it and the range will go lopsided.'));
  limits.append(el('p', null,
    'It measures recognition. Knowing a word well enough to pick its meaning out of four '
    + 'is not the same as being able to use it, which is what Summon is for.'));
  limits.append(el('p', null,
    'Numbers from other vocabulary tests are usually not comparable with this one. They '
    + 'differ in the unit counted — lemmas, word families or word forms — and in which '
    + 'dictionary they sample from. A figure roughly twice this one is the normal result '
    + 'of counting forms rather than lemmas.'));
  body.append(limits);

  const src = section('Sources');
  for (const s of meta.sources) src.append(el('p', 'tight', `${s.name} — ${s.who}. ${s.use}.`));
  src.append(el('p', 'tight',
    `${n0(meta.words)} playable words · ${meta.confusables.sets} confusable sets · built ${meta.built}.`));
  body.append(src);

  const priv = section('Where your answers live');
  priv.append(el('p', null,
    'On this device, in this browser, and nowhere else. There is no account and no '
    + 'server. Clearing site data clears your record, so export it from Progress if '
    + 'you want to keep it.'));
  body.append(priv);

  show('about');
}

/* ------------------------------------------------------------------- boot */

(async function boot() {
  try {
    await loadPack();
    S.load();
    Speech.init();
    $('boot').hidden = true;
    $('app').hidden = false;
    renderHome();
  } catch (err) {
    $('boot').replaceChildren(
      el('div', 'boot-mark', 'Wordhoard'),
      el('div', 'boot-note', `Could not load the word bank — ${err.message}`),
    );
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
  }
})();
