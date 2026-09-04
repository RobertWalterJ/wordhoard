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

  const playable = list.filter((w) => w.packName !== 'core');

  pack = {
    lang, meta, words: list, byWord, byPack, byPos, playable,
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

/**
 * Four options for a word, as similar as the bank allows.
 * Same part of speech, comparable difficulty, and preferring the same WordNet
 * domain, so the wrong answers are wrong on the meaning rather than obviously
 * out of place. Anything sharing a sense with the target is excluded: two
 * defensible answers is a broken question, not a hard one.
 */
export function distractorsFor(word, count = 3, rng = Math.random) {
  const pool = neighboursByPrevalence(word, count);
  const sameDomain = pool.filter((c) => c.lex === word.lex && !shareMeaning(word, c));
  const rest = pool.filter((c) => c.lex !== word.lex && !shareMeaning(word, c));
  const picked = [];
  const take = (arr, n) => {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    for (const c of copy) {
      if (picked.length >= n) break;
      if (!picked.some((p) => p.w === c.w)) picked.push(c);
    }
  };
  take(sameDomain, Math.min(count, 2));   // at least one near-miss, never all four
  take(rest, count);
  take(pool, count);
  return picked.slice(0, count);
}
