/* The five modes.
 *
 * Each is a session object with the same three methods -- next(), answer(),
 * summary() -- so the screen that runs questions does not need to know which
 * mode it is running.
 *
 *   rapid     timed multiple choice, a set number of questions, adaptive
 *   estimate  the calibrated instrument: yes/no + pseudowords + spot checks
 *   train     spaced repetition over what you have missed or starred
 *   sharpen   the confusables -- correcting a word you already "know"
 *   recall    produce the word from its meaning: passive -> active
 */
import * as A from './ability.js';
import * as S from './store.js';
import { getPack, distractorsFor } from './data.js';

const shuffle = (a) => {
  const c = a.slice();
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};
const sample = (a) => a[Math.floor(Math.random() * a.length)];

/** Current ability from the whole stored history. */
export function currentAbility() {
  const st = S.load();
  const fa = A.falseAlarmRate(st.observations);
  const fit = A.fitAbility(A.bucket(st.observations), fa.rate);
  return { ...fit, falseAlarm: fa };
}

export function vocabulary(fit) {
  const { hist } = getPack().estimator;
  return {
    lemmas: A.vocabularyAt(fit.theta, hist),
    lo: A.vocabularyAt(fit.lo, hist),
    hi: A.vocabularyAt(fit.hi, hist),
  };
}

/* ------------------------------------------------------------ question types */

/** "What does <word> mean?" -- four definitions. */
function definitionQuestion(word) {
  const wrong = distractorsFor(word, 3);
  if (wrong.length < 3) return null;
  const options = shuffle([
    { text: word.def, correct: true },
    ...wrong.map((w) => ({ text: w.def, correct: false, from: w.w })),
  ]);
  return {
    kind: 'mcq', word, b: word.prev, calibrated: word.cal !== 0,
    prompt: { lead: word.posName, text: word.w, style: 'word' },
    options, ask: 'What does it mean?',
  };
}

/** "Which word means this?" -- four words. Harder: you must retrieve, not verify. */
function wordQuestion(word) {
  const wrong = distractorsFor(word, 3);
  if (wrong.length < 3) return null;
  const options = shuffle([
    { text: word.w, correct: true },
    ...wrong.map((w) => ({ text: w.w, correct: false })),
  ]);
  return {
    kind: 'mcq', word, b: word.prev, calibrated: word.cal !== 0,
    prompt: { lead: word.posName, text: word.def, style: 'definition' },
    options, ask: 'Which word is it?',
  };
}

/** Type the word from its meaning. The only mode that tests production. */
function recallQuestion(word) {
  return {
    kind: 'recall', word, b: word.prev, calibrated: word.cal !== 0,
    prompt: { lead: word.posName, text: word.def, style: 'definition' },
    accept: [word.w], hint: `${word.w[0]}${'·'.repeat(word.w.length - 1)}`,
    ask: 'Write the word',
  };
}

const askable = (w) => w && w.def && w.def.length > 10;

/* ------------------------------------------------------------------- rapid */

export function rapidSession({ length = 20, packs = ['precision', 'rare', 'builtform'], seconds = 12 } = {}) {
  const pack = getPack();
  const pool = packs.flatMap((p) => pack.byPack.get(p) || []).filter(askable);
  let fit = currentAbility();
  const asked = new Set();
  const results = [];
  let i = 0, score = 0, streak = 0, best = 0;

  const pick = () => {
    // Aim at the difficulty that would teach us the most, which for a
    // four-option question lands a little above a coin flip. Drifting the
    // target by a random amount keeps a run from feeling like one long plateau.
    const target = A.targetPrevalence(fit.theta, 'mcq', 4) + (Math.random() - 0.5) * 1.2;
    let bestW = null, bestD = Infinity;
    for (let n = 0; n < 220; n++) {
      const c = sample(pool);
      if (!c || asked.has(c.w)) continue;
      const d = Math.abs(c.prev - target);
      if (d < bestD) { bestD = d; bestW = c; }
    }
    return bestW;
  };

  return {
    mode: 'rapid',
    total: length,
    seconds,
    get index() { return i; },
    get score() { return score; },
    get streak() { return streak; },
    next() {
      if (i >= length) return null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const w = pick();
        if (!w) break;
        asked.add(w.w);
        const q = (Math.random() < 0.5 ? definitionQuestion : wordQuestion)(w);
        if (q) { i++; return q; }
      }
      return null;
    },
    answer(q, choice, msLeft) {
      const ok = !!(choice && choice.correct);
      S.record({
        word: q.word.w, b: q.b, kind: 'mcq', options: 4, ok,
        mode: 'rapid', calibrated: q.calibrated,
      });
      S.schedule(q.word.w, ok);
      if (ok) {
        streak++; best = Math.max(best, streak);
        // Harder words are worth more, and speed is worth something but never
        // more than being right.
        const difficulty = 1 - (q.word.pknown ?? 0.5);
        // With the clock off there is no speed bonus to award, and dividing
        // by a zero limit would make the whole score NaN.
        const speed = seconds > 0 ? msLeft / (seconds * 1000) : 0;
        score += Math.round(60 + 90 * difficulty + 40 * speed + 8 * Math.min(streak, 10));
      } else {
        streak = 0;
      }
      results.push({ q, ok });
      if (i % 5 === 0) fit = currentAbility();
      return { ok, correctOption: q.options.find((o) => o.correct) };
    },
    summary() {
      S.noteSession(); S.save();
      const correct = results.filter((r) => r.ok).length;
      return {
        mode: 'rapid', correct, total: results.length, score, bestStreak: best,
        missed: results.filter((r) => !r.ok).map((r) => r.q.word),
        got: results.filter((r) => r.ok).map((r) => r.q.word),
      };
    },
  };
}

/* ---------------------------------------------------------------- estimate */

/**
 * The vocabulary-size test.
 *
 * Yes/no over words drawn adaptively across the prevalence range, salted with
 * pseudowords to measure over-claiming, and with spot checks: say you know a
 * word and there is a chance you are immediately asked what it means. Where a
 * spot check happens it *replaces* the self-report rather than adding to it,
 * so nothing is counted twice.
 */
export function estimateSession({ length = 90, pseudoShare = 0.25, probeChance = 0.3 } = {}) {
  const pack = getPack();
  const items = pack.estimator.items;
  const pseudo = shuffle(pack.estimator.pseudo);
  let fit = currentAbility();
  const used = new Set();
  const results = [];
  let i = 0, pseudoUsed = 0, probes = 0, probesFailed = 0, pending = null;

  const nPseudo = Math.round(length * pseudoShare);

  const pickReal = () => {
    const target = A.targetPrevalence(fit.theta, 'yesno') + (Math.random() - 0.5) * 1.6;
    let bestI = null, bestD = Infinity;
    for (let n = 0; n < 400; n++) {
      const c = items[Math.floor(Math.random() * items.length)];
      if (used.has(c.w)) continue;
      const d = Math.abs(c.prev - target);
      if (d < bestD) { bestD = d; bestI = c; }
    }
    return bestI;
  };

  return {
    mode: 'estimate',
    total: length,
    seconds: 0,
    get index() { return i; },
    next() {
      if (pending) {                       // a spot check queued by the last yes
        const q = pending; pending = null; return q;
      }
      if (i >= length) return null;
      i++;
      const wantPseudo = pseudoUsed < nPseudo
        && Math.random() < nPseudo / Math.max(1, length - i + 1);
      if (wantPseudo) {
        const w = pseudo[pseudoUsed++];
        return {
          kind: 'yesno', pseudo: true, word: { w }, b: null, calibrated: false,
          prompt: { text: w, style: 'word' }, ask: 'Do you know this word?',
        };
      }
      const it = pickReal();
      if (!it) return null;
      used.add(it.w);
      return {
        kind: 'yesno', pseudo: false, word: pack.byWord.get(it.w) || { w: it.w },
        b: it.prev, calibrated: true, hasDef: !!it.hasDef,
        prompt: { text: it.w, style: 'word' }, ask: 'Do you know this word?',
      };
    },
    answer(q, choice) {
      if (q.kind === 'mcq') {              // this is a spot check
        const ok = !!(choice && choice.correct);
        probes++; if (!ok) probesFailed++;
        S.record({ word: q.word.w, b: q.b, kind: 'mcq', options: 4, ok, mode: 'estimate' });
        if (!ok) S.schedule(q.word.w, false);
        results.push({ q, ok, probe: true });
        return { ok, correctOption: q.options.find((o) => o.correct), probe: true };
      }
      const claims = choice === 'yes';
      const full = pack.byWord.get(q.word.w);
      // Only follow up on a claim, and only where there is a definition to ask
      // about. Checking a "no" would tell us nothing we did not just hear.
      if (claims && !q.pseudo && askable(full) && Math.random() < probeChance) {
        const probe = definitionQuestion(full);
        if (probe) { pending = probe; return { ok: null, deferred: true }; }
      }
      S.record({
        word: q.word.w, b: q.b, kind: 'yesno', options: 0, ok: claims,
        mode: 'estimate', pseudo: q.pseudo, calibrated: !q.pseudo,
      });
      results.push({ q, ok: claims });
      if (i % 8 === 0) fit = currentAbility();
      return { ok: null, recorded: true, claimed: claims, pseudo: q.pseudo };
    },
    summary() {
      S.noteSession();
      const f = currentAbility();
      const v = vocabulary(f);
      S.pushEstimate({
        theta: f.theta, lo: f.lo, hi: f.hi,
        lemmas: Math.round(v.lemmas), vlo: Math.round(v.lo), vhi: Math.round(v.hi),
        trials: Math.round(f.trials),
      });
      S.save();
      const fakes = results.filter((r) => r.q.pseudo);
      return {
        mode: 'estimate', fit: f, vocab: v,
        answered: results.length,
        pseudoShown: fakes.length,
        pseudoClaimed: fakes.filter((r) => r.ok).length,
        probes, probesFailed,
        falseAlarm: f.falseAlarm,
      };
    },
  };
}

/* ------------------------------------------------------------------- train */

export function trainSession({ length = 15 } = {}) {
  const pack = getPack();
  const st = S.load();
  const due = S.dueWords().map((w) => pack.byWord.get(w)).filter(askable);
  const starred = st.starred.map((w) => pack.byWord.get(w)).filter(askable);
  const queue = [];
  const seen = new Set();
  for (const w of [...due, ...starred]) {
    if (seen.has(w.w)) continue;
    seen.add(w.w); queue.push(w);
    if (queue.length >= length) break;
  }
  const results = [];
  let i = 0;

  return {
    mode: 'train',
    total: queue.length,
    seconds: 0,
    available: queue.length,
    get index() { return i; },
    next() {
      if (i >= queue.length) return null;
      const w = queue[i++];
      const box = (st.schedule[w.w] || {}).box || 0;
      // Recognition first; once a word has survived a couple of rounds, make it
      // earn its place by being produced rather than picked out of a line-up.
      return box >= 2 ? recallQuestion(w) : (Math.random() < 0.5 ? definitionQuestion(w) : wordQuestion(w)) || definitionQuestion(w);
    },
    answer(q, choice) {
      const ok = q.kind === 'recall'
        ? normalise(choice) === normalise(q.word.w)
        : !!(choice && choice.correct);
      S.record({
        word: q.word.w, b: q.b, kind: q.kind, options: q.kind === 'recall' ? 0 : 4,
        ok, mode: 'train', calibrated: q.calibrated,
      });
      S.schedule(q.word.w, ok);
      results.push({ q, ok });
      return { ok, correctOption: q.options?.find((o) => o.correct), answerText: q.word.w };
    },
    summary() {
      S.noteSession(); S.save();
      return {
        mode: 'train',
        correct: results.filter((r) => r.ok).length,
        total: results.length,
        missed: results.filter((r) => !r.ok).map((r) => r.q.word),
        got: results.filter((r) => r.ok).map((r) => r.q.word),
      };
    },
  };
}

const normalise = (s) => (s || '').trim().toLowerCase().replace(/[^a-z]/g, '');

/* ----------------------------------------------------------------- sharpen */

/**
 * The confusables.
 *
 * Pair sets are a fill-in-the-blank between two words that get swapped for each
 * other. Drift sets ask which of two sentences uses a word the way it actually
 * means -- the format that catches a word you are confident about and wrong on.
 *
 * These answers are deliberately kept out of the ability estimate: getting
 * 'fulsome' wrong is a fact about precision, not about how many words you know.
 */
export function sharpenSession({ length = 12 } = {}) {
  const conf = getPack().confusables;
  const questions = [];
  for (const set of shuffle(conf.sets)) {
    if (questions.length >= length) break;
    if (set.kind === 'pair') {
      const item = sample(set.items);
      const opts = item.options || set.words;
      questions.push({
        kind: 'mcq', set, calibrated: false, b: null,
        word: { w: item.answer },
        prompt: { text: item.sentence.replace('___', ' ____ '), style: 'sentence' },
        options: shuffle(opts.map((o) => ({ text: o, correct: o === item.answer }))),
        ask: 'Which word belongs here?',
        explain: set.why, gloss: set.gloss,
      });
    } else {
      const right = set.items.find((it) => !it.trap);
      const trap = set.items.find((it) => it.trap);
      if (!right || !trap) continue;
      const target = set.words[0];
      questions.push({
        kind: 'mcq', set, calibrated: false, b: null,
        word: { w: target },
        prompt: { lead: 'Which sentence uses it correctly?', text: target, style: 'word' },
        options: shuffle([
          { text: right.sentence.replace('___', target), correct: true },
          { text: trap.sentence.replace('___', target), correct: false },
        ]),
        ask: null, longOptions: true,
        explain: `${set.why} Commonly mistaken for: ${set.wrong}.`,
        gloss: set.gloss,
      });
    }
  }
  const results = [];
  let i = 0;
  return {
    mode: 'sharpen',
    total: questions.length,
    seconds: 0,
    get index() { return i; },
    next() { return i < questions.length ? questions[i++] : null; },
    answer(q, choice) {
      const ok = !!(choice && choice.correct);
      S.record({
        word: q.word.w, b: null, kind: 'mcq', options: q.options.length, ok,
        mode: 'sharpen', calibrated: false,
      });
      results.push({ q, ok });
      return { ok, correctOption: q.options.find((o) => o.correct), explain: q.explain };
    },
    summary() {
      S.noteSession(); S.save();
      return {
        mode: 'sharpen',
        correct: results.filter((r) => r.ok).length,
        total: results.length,
        missed: results.filter((r) => !r.ok).map((r) => ({ word: r.q.word.w, why: r.q.explain })),
      };
    },
  };
}

/* ------------------------------------------------------------------ recall */

export function recallSession({ length = 12, packs = ['precision', 'builtform'] } = {}) {
  const pack = getPack();
  const fit = currentAbility();
  const pool = packs.flatMap((p) => pack.byPack.get(p) || []).filter(askable);
  // Production lags recognition, so aim easier than the recognition target --
  // otherwise every prompt is a blank you cannot fill and nothing is learned.
  const target = A.targetPrevalence(fit.theta, 'recall');
  const ranked = pool
    .map((w) => ({ w, d: Math.abs(w.prev - target) + Math.random() * 0.8 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, length * 3);
  const queue = shuffle(ranked).slice(0, length).map((r) => r.w);
  const results = [];
  let i = 0;
  return {
    mode: 'recall',
    total: queue.length,
    seconds: 0,
    get index() { return i; },
    next() { return i < queue.length ? recallQuestion(queue[i++]) : null; },
    answer(q, typed) {
      const ok = normalise(typed) === normalise(q.word.w);
      S.record({
        word: q.word.w, b: q.b, kind: 'recall', options: 0, ok,
        mode: 'recall', calibrated: q.calibrated,
      });
      S.schedule(q.word.w, ok);
      results.push({ q, ok });
      return { ok, answerText: q.word.w };
    },
    summary() {
      S.noteSession(); S.save();
      return {
        mode: 'recall',
        correct: results.filter((r) => r.ok).length,
        total: results.length,
        missed: results.filter((r) => !r.ok).map((r) => r.q.word),
        got: results.filter((r) => r.ok).map((r) => r.q.word),
      };
    },
  };
}
