/* Loading and indexing the language pack.
 *
 * Everything the app plays with comes from app/data/<lang>/. Keeping the path
 * language-shaped from the start is the whole provision for a second language:
 * prevalence norms of the same kind exist for Dutch and Spanish, and a new pack
 * would drop in beside this one without the engine changing.
 */

export const LANG = 'en';

let pack = null;

const asRecord = (row, cols) => {
  const o = {};
  for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
  return o;
};

export async function loadPack(lang = LANG) {
  if (pack) return pack;
  // The single-file build inlines the pack, because that sandbox serves one
  // document and cannot fetch anything beside it.
  const inlined = typeof window !== 'undefined' && window.__WORDHOARD_DATA;
  const base = `data/${lang}/`;
  const [words, estimator, confusables, meta] = inlined
    ? [inlined.words, inlined.estimator, inlined.confusables, inlined.meta]
    : await Promise.all(
      ['words.json', 'estimator.json', 'confusables.json', 'meta.json']
        .map((f) => fetch(base + f).then((r) => {
          if (!r.ok) throw new Error(`${f}: ${r.status}`);
          return r.json();
        })));

  const list = words.rows.map((row) => {
    const w = asRecord(row, words.cols);
    w.posName = words.pos[w.pos];
    w.lexName = words.lex[w.lex];
    w.packName = words.packs[w.pack];
    return w;
  });

  const byWord = new Map(list.map((w) => [w.w, w]));
  const byPack = new Map(words.packs.map((p) => [p, list.filter((w) => w.packName === p)]));

  // Distractors are drawn by part of speech and difficulty, so index that way
  // once rather than scanning 21,000 words per question.
  const byPos = new Map();
  for (const w of list) {
    if (!byPos.has(w.pos)) byPos.set(w.pos, []);
    byPos.get(w.pos).push(w);
  }
  for (const arr of byPos.values()) arr.sort((a, b) => a.prev - b.prev);

  // Same part of speech AND same ending, sorted by difficulty. Without this the
  // guarantee of a matching decoy fails silently whenever the target's
  // neighbours happen not to share its ending -- which for a rare -ity noun is
  // most of the time.
  const bySuffix = new Map();
  for (const w of list) {
    const suf = suffixOf(w.w);
    if (!suf) continue;
    const key = `${w.pos}|${suf}`;
    if (!bySuffix.has(key)) bySuffix.set(key, []);
    bySuffix.get(key).push(w);
  }
  for (const arr of bySuffix.values()) arr.sort((a, b) => a.prev - b.prev);

  const playable = list.filter((w) => w.packName !== 'core');

  pack = {
    lang, meta, words: list, byWord, byPack, byPos, bySuffix, playable,
    packNames: words.packs,
    posNames: words.pos,
    estimator: {
      ...estimator,
      items: estimator.items.map((r) => asRecord(r, estimator.itemCols)),
    },
    confusables,
  };
  return pack;
}

export const getPack = () => pack;

/** Nearest words by prevalence within a part of speech, for plausible options. */
export function neighboursByPrevalence(word, count, { pos = word.pos, spread = 0.9 } = {}) {
  const arr = pack.byPos.get(pos) || pack.words;
  // binary search to the target prevalence, then walk outwards
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].prev < word.prev) lo = mid + 1; else hi = mid;
  }
  const out = [];
  let i = lo - 1, j = lo;
  while (out.length < count * 6 && (i >= 0 || j < arr.length)) {
    const takeLeft = j >= arr.length
      || (i >= 0 && Math.abs(arr[i].prev - word.prev) <= Math.abs(arr[j].prev - word.prev));
    const cand = takeLeft ? arr[i--] : arr[j++];
    if (!cand || cand.w === word.w) continue;
    if (Math.abs(cand.prev - word.prev) > spread && out.length >= count) break;
    out.push(cand);
  }
  return out;
}

const shareMeaning = (a, b) => {
  const syn = (x) => new Set([(x.syn || []).map((s) => s.toLowerCase()), x.w].flat());
  const sa = syn(a), sb = syn(b);
  for (const s of sa) if (sb.has(s)) return true;
  return false;
};

/* Word shape, so the wrong answers cannot be eliminated on shape alone.
   If the answer is the only -ly word among four, or the only short one, the
   question is testing pattern-matching rather than vocabulary. */
const SUFFIXES = [
  'ability', 'ibility', 'ization', 'isation', 'ousness', 'iveness',
  'ation', 'ition', 'ution', 'ement', 'ility', 'ously', 'ingly', 'edly',
  'ance', 'ence', 'tion', 'sion', 'ness', 'ment', 'ship', 'hood', 'less',
  'able', 'ible', 'ical', 'ious', 'eous', 'ative', 'itive', 'ary', 'ory',
  'ant', 'ent', 'ify', 'ise', 'ize', 'ate', 'ism', 'ist', 'ity', 'ive',
  'ous', 'ful', 'ish', 'age', 'ure', 'ial', 'ual', 'ly', 'al', 'ic', 'y',
];
const PREFIXES = [
  'counter', 'circum', 'contra', 'trans', 'super', 'inter', 'intra', 'under',
  'over', 'semi', 'anti', 'auto', 'post', 'pre', 'pro', 'sub', 'dis', 'mis',
  'non', 'out', 'con', 'com', 'ex', 'in', 'im', 'ir', 'il', 'un', 're', 'de',
  'ab', 'ad', 'be', 'en', 'em', 'ob', 'per', 'a',
];

export function suffixOf(w) {
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) return suf;
  }
  return '';
}

/** The word with its affixes stripped -- a crude root, good enough to group by. */
export function rootOf(w) {
  let core = w;
  for (const pre of PREFIXES) {
    if (core.length - pre.length >= 4 && core.startsWith(pre)) { core = core.slice(pre.length); break; }
  }
  const suf = suffixOf(core);
  if (suf && core.length - suf.length >= 3) core = core.slice(0, -suf.length);
  return core.slice(0, 5);
}

/**
 * Four options for a word, as similar as the bank allows.
 *
 * Same part of speech and comparable difficulty are the floor. On top of that
 * the wrong answers are scored for resemblance to the right one -- same ending,
 * same root, similar length, same WordNet domain -- because a question whose
 * answer can be picked out by shape is testing pattern-matching, not
 * vocabulary. If the answer is an -ly adverb, at least one decoy should be too.
 *
 * Anything sharing a sense with the target is excluded outright: two defensible
 * answers is a broken question, not a hard one.
 */
export function distractorsFor(word, count = 3, rng = Math.random) {
  const pool = neighboursByPrevalence(word, count * 3, { spread: 1.4 })
    .filter((c) => !shareMeaning(word, c));
  if (pool.length < count) return pool.slice(0, count);

  const suf = suffixOf(word.w);
  const root = rootOf(word.w);
  const len = word.w.length;

  const score = (c) => {
    let sc = 0;
    if (suf && suffixOf(c.w) === suf) sc += 5;          // same ending
    if (root.length >= 4 && rootOf(c.w) === root) sc += 4; // same root
    if (c.lex === word.lex) sc += 2;                    // same domain of meaning
    sc -= Math.abs(c.w.length - len) * 0.35;            // similar length
    sc -= Math.abs(c.prev - word.prev) * 0.8;           // similar difficulty
    return sc + rng() * 1.2;                            // keep rounds from repeating
  };

  const ranked = pool.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  const picked = [];
  // Guarantee one decoy that ends the same way, so the ending is never the tell.
  if (suf) {
    const match = ranked.find((r) => suffixOf(r.c.w) === suf);
    if (match) picked.push(match.c);
    else {
      // None nearby: go and find the closest one in the whole language.
      const shelf = pack.bySuffix.get(`${word.pos}|${suf}`) || [];
      let best = null, bestD = Infinity;
      for (const c of shelf) {
        if (c.w === word.w || shareMeaning(word, c)) continue;
        const d = Math.abs(c.prev - word.prev);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) picked.push(best);
    }
  }
  for (const r of ranked) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.w === r.c.w)) picked.push(r.c);
  }
  return picked.slice(0, count);
}
