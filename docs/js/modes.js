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
    // On some questions, break the tie in favour of a word whose parts are
    // known, so the root breakdowns are actually met rather than theoretically
    // available. Difficulty still decides; this only settles near-ties, and
    // only sometimes, so the same few hundred words do not come round forever.
    const preferRoots = Math.random() < 0.3;
    let bestW = null, bestD = Infinity;
    for (let n = 0; n < 220; n++) {
      const c = sample(pool);
      if (!c || asked.has(c.w)) continue;
      const d = Math.abs(c.prev - target) - (preferRoots && c.roots ? 0.5 : 0);
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
 * Every item is two stages. You are shown a word and say whether you know it;
 * if you say yes you are immediately asked what it means, from four options.
 * The item counts as passed only if you claimed it AND defined it.
 *
 * That is the difference between measuring vocabulary and measuring confidence.
 * A bare yes/no test can be corrected for the AVERAGE rate of over-claiming
 * using pseudowords, but it can never tell you which particular claims were
 * hollow, and it hands the person being measured full control of their own
 * score. Here the claim only opens the question.
 *
 * The yes/no stage earns its place as a router: it costs one tap to skip the
 * definition question on a word you have never seen, and saying no is evidence.
 *
 * Pseudowords stay, at a lower rate, because the false-alarm rate they measure
 * is a term in the item likelihood -- passing by over-claiming and then guessing
 * one option in four -- and because it is worth showing you.
 */
export function estimateSession({ length = 60, pseudoShare = 0.18 } = {}) {
  const pack = getPack();
  const items = pack.estimator.items;
  const pseudo = shuffle(pack.estimator.pseudo);
  let fit = currentAbility();
  const used = new Set();
  const results = [];
  let i = 0, pseudoUsed = 0, claimed = 0, claimsFailed = 0, pending = null;

  const nPseudo = Math.round(length * pseudoShare);

  const pickReal = () => {
    const target = A.targetPrevalence(fit.theta, 'verify') + (Math.random() - 0.5) * 1.4;
    let best = null, bestD = Infinity;
    for (let n = 0; n < 400; n++) {
      const c = items[Math.floor(Math.random() * items.length)];
      if (used.has(c.w)) continue;
      const d = Math.abs(c.prev - target);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };

  /** One 'verify' observation per real item: claimed it and could define it. */
  const bank = (word, b, passed) => {
    S.record({ word, b, kind: 'verify', options: 4, ok: passed, mode: 'estimate' });
    results.push({ w: word, passed });
    if (i % 6 === 0) fit = currentAbility();
  };

  return {
    mode: 'estimate',
    total: length,
    seconds: 0,
    get index() { return i; },
    next() {
      if (pending) { const q = pending; pending = null; return q; }
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
        b: it.prev, calibrated: true,
        prompt: { text: it.w, style: 'word' }, ask: 'Do you know this word?',
      };
    },
    answer(q, choice) {
      if (q.kind === 'mcq') {                    // the second stage
        const ok = !!(choice && choice.correct);
        if (!ok) { claimsFailed++; S.schedule(q.word.w, false); }
        bank(q.word.w, q.b, ok);
        return { ok, correctOption: q.options.find((o) => o.correct), verified: true };
      }

      const claims = choice === 'yes';
      if (q.pseudo) {
        S.record({
          word: q.word.w, b: null, kind: 'yesno', options: 0, ok: claims,
          mode: 'estimate', pseudo: true, calibrated: false,
        });
        results.push({ w: q.word.w, pseudo: true, claimed: claims });
        return { ok: null, recorded: true, claimed: claims, pseudo: true };
      }

      if (!claims) {                             // no claim, no need to test it
        bank(q.word.w, q.b, false);
        return { ok: null, recorded: true, claimed: false };
      }

      claimed++;
      const full = pack.byWord.get(q.word.w);
      const probe = askable(full) ? definitionQuestion(full) : null;
      if (probe) { pending = probe; return { ok: null, deferred: true }; }
      // Every estimator item is meant to carry a definition; if one somehow does
      // not, take the claim at face value rather than failing it unfairly.
      bank(q.word.w, q.b, true);
      return { ok: null, recorded: true, claimed: true };
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
      const fakes = results.filter((r) => r.pseudo);
      return {
        mode: 'estimate', fit: f, vocab: v,
        answered: results.length,
        pseudoShown: fakes.length,
        pseudoClaimed: fakes.filter((r) => r.claimed).length,
        claimed, claimsFailed,
        tested: results.filter((r) => !r.pseudo).length,
        passed: results.filter((r) => !r.pseudo && r.passed).length,
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
