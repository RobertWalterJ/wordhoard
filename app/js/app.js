/* Screens, and the loop that runs a round.
 *
 * One runner drives every mode, because they all answer the same three
 * questions: what is next, was that right, and how did the round go. The
 * differences that remain -- a clock, a text box, two buttons instead of four --
 * are read off the question, not off the mode.
 */
import { loadPack, getPack } from './data.js';
import * as S from './store.js';
import * as M from './modes.js';
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

const SCREENS = ['home', 'play', 'result', 'progress', 'about'];
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
    start: () => M.rapidSession({ ...S.load().settings, length: S.load().settings.rapidLength, seconds: S.load().settings.rapidSeconds }),
  },
  {
    id: 'estimate', name: 'Take the Measure', tag: '~90 words',
    desc: 'The calibrated test: how many words you know, with pseudowords and spot checks to keep you honest.',
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
    start: () => M.recallSession(),
  },
];

/* ------------------------------------------------------------------- home */

function renderHome() {
  const st = S.load();
  const fit = M.currentAbility();
  const card = $('estimate-card-inner');
  card.replaceChildren();

  if (fit.trials < 12) {
    card.append(
      el('div', 'eyebrow', 'Your vocabulary'),
      el('div', 'est-empty',
        'Not measured yet. Take the Measure runs about ninety words and gives you a '
        + 'number with an honest margin around it — every other mode then keeps it up to date.'),
      el('div', 'est-cta', 'Start the measurement →'),
    );
  } else {
    const v = M.vocabulary(fit);
    const num = el('div', 'est-number', n0(v.lemmas));
    num.append(el('span', 'est-unit', ' lemmas'));
    const bandWrap = el('div', 'band');
    // Where the estimate sits between a fairly low and a very high vocabulary,
    // so the number has somewhere to stand.
    const lo = 20000, hi = 62000;
    const at = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
    const fill = el('div', 'band-fill');
    fill.style.left = `${at(v.lo)}%`;
    fill.style.width = `${Math.max(1, at(v.hi) - at(v.lo))}%`;
    const mark = el('div', 'band-mark');
    mark.style.left = `${at(v.lemmas)}%`;
    bandWrap.append(fill, mark);
    card.append(
      el('div', 'eyebrow', 'Your vocabulary'),
      num,
      bandWrap,
      el('div', 'est-range', `${n0(v.lo)} – ${n0(v.hi)} · from ${n0(fit.trials)} answers`),
      el('div', 'est-cta', 'How this is worked out →'),
    );
  }

  const nav = $('modes');
  nav.replaceChildren();
  const due = S.dueWords().length;
  for (const m of MODES) {
    const b = el('button', 'mode');
    b.type = 'button';
    const left = el('div');
    left.append(el('div', 'mode-name', m.name), el('div', 'mode-desc', m.desc));
    let tag = m.tag;
    if (m.id === 'train') {
      const ready = due + st.starred.length;
      tag = ready ? `${ready} waiting` : 'nothing due';
      b.disabled = ready === 0;
    }
    b.append(left, el('div', 'mode-tag', tag));
    b.addEventListener('click', () => startMode(m));
    nav.append(b);
  }

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

function startMode(m) {
  session = m.start();
  if (!session.total) {
    renderHome();
    return;
  }
  show('play');
  nextQuestion();
}

function clearTimers() {
  cancelAnimationFrame(timerId);
  clearTimeout(hintId);
  timerId = hintId = null;
}

function nextQuestion() {
  clearTimers();
  locked = false;
  question = session.next();
  if (!question) return finishRound();

  $('feedback').hidden = true;
  $('advance').hidden = true;
  $('progress-fill').style.width = `${(session.index / session.total) * 100}%`;
  $('play-count').textContent = `${Math.min(session.index, session.total)} / ${session.total}`;
  if (session.mode === 'rapid') {
    const chip = $('score-chip');
    chip.hidden = false;
    chip.textContent = `${session.score.toLocaleString('en-CA')} pts${session.streak > 1 ? ` · ${session.streak} in a row` : ''}`;
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
    qBox.append(el('div', 'q-word', q.prompt.text));
  } else if (q.prompt.style === 'sentence') {
    const p = el('div', 'q-sentence');
    // The blank is the focus of the question, so it is marked rather than left
    // as an anonymous run of underscores.
    const [before, after] = q.prompt.text.split('____');
    // The gap has to be an element with width of its own: a run of spaces
    // collapses to one in HTML and the blank all but disappears.
    p.append(document.createTextNode(before), el('em', 'blank'), document.createTextNode(after || ''));
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
      b.textContent = label;
      b.addEventListener('click', () => submit(value));
      box.append(b);
    }
    return;
  }

  if (q.kind === 'recall') {
    const input = el('input', 'recall-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.placeholder = 'the word…';
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

  for (const opt of q.options) {
    const b = el('button', q.longOptions || q.prompt.style !== 'definition' ? 'opt serif' : 'opt');
    b.type = 'button';
    b.textContent = opt.text;
    b.addEventListener('click', () => submit(opt));
    box.append(b);
  }
}

/* The clock stops when the screen does.
   requestAnimationFrame does not run in a backgrounded tab, so without this the
   deadline would quietly pass while the phone was locked and the question would
   be marked wrong the instant you came back to it. */
document.addEventListener('visibilitychange', () => {
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

let tickClock = () => {};

function startClock(seconds) {
  const bar = $('timer');
  const fill = $('timer-fill');
  bar.hidden = false;
  bar.classList.remove('urgent');
  timerEnds = performance.now() + seconds * 1000;
  hiddenAt = 0;
  const tick = () => {
    const left = timerEnds - performance.now();
    const frac = Math.max(0, left / (seconds * 1000));
    fill.style.width = `${frac * 100}%`;
    if (frac < 0.25) bar.classList.add('urgent');
    if (left <= 0) {
      // Running out is an answer. This is where an earlier version of this app
      // threw, because the timeout path had no chosen option to work with.
      submit(null);
      return;
    }
    timerId = requestAnimationFrame(tick);
  };
  tickClock = tick;
  timerId = requestAnimationFrame(tick);
}

function submit(choice) {
  if (locked || !question) return;
  locked = true;
  clearTimers();
  $('timer').hidden = true;
  const msLeft = session.seconds ? Math.max(0, timerEnds - performance.now()) : 0;
  const outcome = session.answer(question, choice, msLeft);

  if (outcome.deferred) {          // a spot check follows this "yes"
    nextQuestion();
    return;
  }
  showFeedback(question, choice, outcome);
}

function showFeedback(q, choice, outcome) {
  const box = $('options');
  if (q.kind === 'mcq') {
    [...box.children].forEach((btn, i) => {
      btn.disabled = true;
      const opt = q.options[i];
      if (opt.correct) btn.classList.add('right');
      else if (opt === choice) btn.classList.add('wrong');
      else btn.classList.add('dim');
    });
  } else {
    [...box.children].forEach((c) => { c.disabled = true; });
  }

  const fb = $('feedback');
  fb.replaceChildren();

  if (outcome.ok === null) {
    // Yes/no: there is no right answer to report, so say what it was worth.
    const known = q.pseudo ? 'That one was invented.' : null;
    if (known) {
      const head = el('div', `fb-head ${outcome.claimed ? 'wrong' : 'right'}`,
        outcome.claimed ? 'Not a word' : 'Correct — not a word');
      fb.append(head, el('div', 'fb-note',
        'Made-up words are mixed in to measure over-claiming. Without them a '
        + 'yes/no test measures confidence rather than vocabulary.'));
    } else {
      fb.append(el('div', 'fb-note', outcome.claimed ? 'Noted.' : 'Noted — no shame in it.'));
    }
  } else {
    const head = el('div', `fb-head ${outcome.ok ? 'right' : 'wrong'}`,
      outcome.ok ? 'Right' : (choice === null ? 'Out of time' : 'Not that one'));
    fb.append(head);
    const w = q.word && getPack().byWord.get(q.word.w);
    if (q.kind === 'recall' || (!outcome.ok && w)) {
      const line = el('div');
      line.append(el('span', 'fb-word', q.word.w));
      if (w) line.append(document.createTextNode(` — ${w.def}`));
      fb.append(line);
    } else if (!outcome.ok && outcome.correctOption) {
      fb.append(el('div', null, outcome.correctOption.text));
    }
    if (q.explain) fb.append(el('div', 'fb-note', q.explain));
    else if (w && w.note) fb.append(el('div', 'fb-note', w.note));
  }

  fb.hidden = false;
  const adv = $('advance');
  adv.hidden = false;
  adv.textContent = session.index >= session.total ? 'See the result' : 'Next';
  adv.focus();
}

function finishRound() {
  // summary() is what banks the round -- the streak, the session count, the
  // stored estimate -- so it must happen exactly once however we got here.
  if (!session || session.done) return;
  session.done = true;
  clearTimers();
  const summary = session.summary();
  $('options').replaceChildren();
  $('advance').hidden = true;
  lastMode = session.mode;
  renderResult(summary);
  show('result');
}

$('advance').addEventListener('click', nextQuestion);
$('quit').addEventListener('click', () => {
  clearTimers();
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
    else if (to === 'about') renderAbout();
  });
}
$('estimate-card').addEventListener('click', () => {
  const fit = M.currentAbility();
  if (fit.trials < 12) startMode(MODES.find((m) => m.id === 'estimate'));
  else renderAbout();
});

/* ---------------------------------------------------------------- results */

function wordListPanel(title, words, { note } = {}) {
  if (!words.length) return null;
  const p = el('div', 'panel');
  p.append(el('h3', null, title));
  if (note) p.append(el('p', 'tight', note));
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
    const star = el('button', `star${S.isStarred(full.w) ? ' on' : ''}`, '★');
    star.type = 'button';
    star.title = 'Keep this one coming back';
    star.addEventListener('click', () => {
      star.classList.toggle('on', S.toggleStar(full.w));
    });
    item.append(left, star);
    list.append(item);
  }
  p.append(list);
  return p;
}

function renderResult(sum) {
  const body = $('result-body');
  body.replaceChildren();

  if (sum.mode === 'estimate') return renderEstimateResult(sum, body);

  const head = el('div', 'result-head');
  head.append(el('div', 'result-score',
    sum.mode === 'rapid' ? sum.score.toLocaleString('en-CA') : `${sum.correct}/${sum.total}`));
  head.append(el('div', 'result-sub', sum.mode === 'rapid'
    ? `${sum.correct} of ${sum.total} right · best run ${sum.bestStreak}`
    : `${pct(sum.correct, sum.total)}% right`));
  body.append(head);

  if (sum.mode === 'sharpen') {
    const missed = (sum.missed || []).filter((m) => m.why);
    if (missed.length) {
      const p = el('div', 'panel');
      p.append(el('h3', null, 'Worth a second look'));
      for (const m of missed) {
        p.append(el('div', 'wl-word', m.word), el('p', 'tight', m.why));
      }
      body.append(p);
    }
    return;
  }

  const missPanel = wordListPanel('Missed — these come back', sum.missed || [],
    { note: 'Added to Training. Star one to make sure it keeps returning.' });
  if (missPanel) body.append(missPanel);

  const fit = M.currentAbility();
  if (fit.trials >= 12) {
    const v = M.vocabulary(fit);
    const p = el('div', 'panel');
    p.append(el('h3', null, 'Estimate after this round'));
    p.append(el('div', 'big-number', n0(v.lemmas)));
    p.append(el('p', 'tight', `lemmas · ${n0(v.lo)} – ${n0(v.hi)} · ${n0(fit.trials)} answers all told`));
    body.append(p);
  }
}

function renderEstimateResult(sum, body) {
  const v = sum.vocab;
  const head = el('div', 'result-head');
  head.append(el('div', 'eyebrow', 'You know about'));
  head.append(el('div', 'big-number', n0(v.lemmas)));
  head.append(el('div', 'result-sub',
    `lemmas — dictionary words, counting walk / walks / walked once.`));
  head.append(el('div', 'result-sub', `Range: ${n0(v.lo)} to ${n0(v.hi)}`));
  body.append(head);

  const forms = el('div', 'panel');
  forms.append(el('h3', null, 'In other units'));
  forms.append(el('p', null,
    `Counting inflected and transparently derived forms as separate words — which is `
    + `what tests reporting much larger numbers usually do — that is roughly `
    + `${n0(v.lemmas * FORMS_PER_LEMMA)} word forms.`));
  forms.append(el('p', null,
    'The conversion is a convention, not a measurement. Numbers from different '
    + 'vocabulary tests are not comparable unless they agree on the unit and on '
    + 'which dictionary they are counting against.'));
  body.append(forms);

  const anchors = el('div', 'panel');
  anchors.append(el('h3', null, 'Against the same scale'));
  const dl = el('dl');
  dl.style.margin = '0';
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
    'Both reference points come from the same research as the calibration, so '
    + 'they sit on this scale. Figures from other tests do not.'));
  body.append(anchors);

  const honesty = el('div', 'panel');
  honesty.append(el('h3', null, 'How honest were you?'));
  const d2 = el('dl');
  d2.style.margin = '0';
  const rows = [
    ['Invented words shown', sum.pseudoShown],
    ['Invented words claimed', sum.pseudoClaimed],
    ['Spot checks asked', sum.probes],
    ['Spot checks failed', sum.probesFailed],
  ];
  for (const [k, val] of rows) {
    const r = el('div', 'stat-row');
    r.append(el('dt', null, k), el('dd', null, String(val)));
    d2.append(r);
  }
  honesty.append(d2);
  honesty.append(el('p', null, sum.pseudoClaimed === 0 && sum.probesFailed === 0
    ? 'No over-claiming detected, so the estimate has not been discounted.'
    : 'Claimed non-words and failed spot checks both pull the estimate down — '
      + 'that correction is already in the number above.'));
  body.append(honesty);
}

/* --------------------------------------------------------------- progress */

function sparkline(history) {
  if (history.length < 2) return null;
  const W = 320, H = 130, PAD = 8, LEFT = 34;
  const xs = history.map((h) => h.t);
  const lo = Math.min(...history.map((h) => h.vlo));
  const hi = Math.max(...history.map((h) => h.vhi));
  const t0 = Math.min(...xs), t1 = Math.max(...xs);
  const x = (t) => LEFT + ((t - t0) / Math.max(1, t1 - t0)) * (W - LEFT - PAD);
  const y = (v) => PAD + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - PAD * 2 - 12);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Vocabulary estimate over ${history.length} measurements, from ${n0(history[0].lemmas)} to ${n0(history.at(-1).lemmas)} lemmas`);
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  const upper = history.map((h) => `${x(h.t)},${y(h.vhi)}`);
  const lower = history.map((h) => `${x(h.t)},${y(h.vlo)}`).reverse();
  svg.append(mk('polygon', { class: 'band-area', points: [...upper, ...lower].join(' ') }));
  svg.append(mk('polyline', { class: 'line', points: history.map((h) => `${x(h.t)},${y(h.lemmas)}`).join(' ') }));
  for (const h of history) svg.append(mk('circle', { class: 'dot', cx: x(h.t), cy: y(h.lemmas), r: 2.5 }));
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
  const top = el('div', 'panel');
  top.append(el('h3', null, 'Where you stand'));
  top.append(el('div', 'big-number', n0(v.lemmas)));
  top.append(el('p', 'tight', `lemmas · ${n0(v.lo)} – ${n0(v.hi)}`));
  top.append(el('p', 'tight', `≈ ${n0(v.lemmas * FORMS_PER_LEMMA)} word forms`));
  body.append(top);

  if (st.history.length >= 2) {
    const chartPanel = el('div', 'panel');
    chartPanel.append(el('h3', null, 'Over time'));
    chartPanel.append(sparkline(st.history));
    const first = st.history[0], last = st.history.at(-1);
    const delta = last.lemmas - first.lemmas;
    chartPanel.append(el('p', 'tight',
      `${delta >= 0 ? '+' : ''}${n0(delta)} lemmas across ${st.history.length} measurements. `
      + 'Movement inside the shaded band is noise, not progress.'));
    body.append(chartPanel);
  }

  // Accuracy by pack, which is the useful cut: it says where the ceiling is.
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
    core: 'Everyday', precision: 'Precision', rare: 'Rare & literary', builtform: 'Built form & science',
  };
  if (byPack.size) {
    const p = el('div', 'panel');
    p.append(el('h3', null, 'By kind of word'));
    const dl = el('dl');
    dl.style.margin = '0';
    for (const [k, e] of [...byPack].sort((a, b) => b[1].n - a[1].n)) {
      const row = el('div', 'stat-row');
      row.append(el('dt', null, LABELS[k] || k), el('dd', null, `${pct(e.k, e.n)}% of ${e.n}`));
      dl.append(row);
    }
    p.append(dl);
    body.append(p);
  }

  const s = el('div', 'panel');
  s.append(el('h3', null, 'Records'));
  const dl = el('dl');
  dl.style.margin = '0';
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
  s.append(dl);
  body.append(s);

  const tools = el('div', 'stack');
  const exp = el('button', 'btn', 'Export my record');
  exp.type = 'button';
  exp.addEventListener('click', () => {
    const json = S.exportJSON();
    // The single-file build runs in a sandbox that never grants downloads, so a
    // download link there is a button that silently does nothing. Show the text
    // instead and say so, rather than pretending it saved.
    if (window.__WORDHOARD_DATA) {
      const box = el('div', 'panel');
      box.append(el('h3', null, 'Your record'));
      box.append(el('p', 'tight', 'This build cannot save files, so here it is to copy. '
        + 'Paste it into a text file to keep it.'));
      const ta = el('textarea', 'recall-input');
      ta.value = json;
      ta.rows = 8;
      ta.readOnly = true;
      box.append(ta);
      exp.replaceWith(box);
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

  const how = el('div', 'panel');
  how.append(el('h3', null, 'What the number means'));
  how.append(el('p', null,
    `Every word here carries a measured difficulty: the proportion of about 220,000 `
    + `people who said they knew it. That turns each word into a test item whose `
    + `difficulty is known in advance, rather than assumed from how often it appears in print.`));
  how.append(el('p', null,
    `Your answers fit a single number — how far above or below the average respondent `
    + `you sit. The vocabulary figure is then the sum, across all `
    + `${n0(meta.inventory)} words in the reference inventory, of the chance you know each one. `
    + `It is an expected count, not a tally, which is why it comes with a range.`));
  how.append(el('p', null,
    `Made-up words and spot checks exist to catch the obvious failure mode: on a `
    + `yes/no test, saying yes to everything produces a magnificent score. Claiming a `
    + `non-word, or failing to define a word you claimed, pulls the estimate down.`));
  body.append(how);

  const limits = el('div', 'panel');
  limits.append(el('h3', null, 'What it cannot do'));
  limits.append(el('p', null,
    `The reference inventory has ${n0(meta.inventory)} words in it, so that is the ceiling. `
    + `A very large vocabulary will press against it and the range will go lopsided.`));
  limits.append(el('p', null,
    'It measures recognition. Knowing a word well enough to pick its meaning out of '
    + 'four is not the same as being able to use it, which is what Summon is for.'));
  limits.append(el('p', null,
    'Numbers from other vocabulary tests are usually not comparable with this one. '
    + 'They differ in the unit counted — lemmas, word families or word forms — and in '
    + 'which dictionary they sample from. A figure roughly twice this one is the '
    + 'normal result of counting forms rather than lemmas.'));
  body.append(limits);

  const src = el('div', 'panel');
  src.append(el('h3', null, 'Sources'));
  for (const s of meta.sources) {
    src.append(el('p', 'tight', `${s.name} — ${s.who}. ${s.use}.`));
  }
  src.append(el('p', 'tight',
    `${n0(meta.words)} playable words · ${meta.confusables.sets} confusable sets · built ${meta.built}.`));
  body.append(src);

  const priv = el('div', 'panel');
  priv.append(el('h3', null, 'Where your answers live'));
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
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
  }
})();
