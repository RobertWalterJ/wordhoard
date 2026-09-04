/* The ability model.
 *
 * Every word in the bank carries a prevalence b: the probit of the proportion
 * of people who know it, measured by Brysbaert et al. across ~220,000
 * respondents. That turns a word into a test item with a known difficulty, and
 * turns the question "how many words does he know?" into a two-step problem:
 *
 *   1. estimate one number, theta, for the person
 *   2. add up P(knows word i) over the whole inventory at that theta
 *
 * P(knows word i) = Phi(theta + b_i). theta = 0 is the average respondent in
 * the norming study; theta = -0.5 lands on ~42,000 lemmas, which is what
 * Brysbaert reports for the average American twenty-year-old.
 *
 * The scoring of an *answer* is not the same as knowing the word, so each kind
 * of observation gets its own link:
 *
 *   yes/no    P(yes)     = f + (1-f) * Phi(theta + b)      f = false-alarm rate
 *   multiple  P(correct) = g + (1-g) * Phi(theta + b)      g = 1/options
 *   recall    P(correct) = Phi(theta + b - RECALL_COST)
 *
 * The false-alarm rate is what the pseudowords are for: claiming 'traisket' is
 * the only direct evidence of over-claiming, and without it a yes/no test just
 * measures confidence.
 */

// Producing a word from its definition is harder than recognising it. The
// offset is an assumption, not a measurement -- it is deliberately modest, and
// it is the one place this model is not grounded in the norms.
export const RECALL_COST = 0.6;

const THETA_MIN = -3.5, THETA_MAX = 4.5, THETA_STEP = 0.02;
export const GRID = (() => {
  const g = [];
  for (let t = THETA_MIN; t <= THETA_MAX + 1e-9; t += THETA_STEP) g.push(+t.toFixed(3));
  return g;
})();

// Abramowitz & Stegun 7.1.26 -- plenty for a progress bar, and it keeps the
// whole engine dependency-free.
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Probability of answering correctly, given ability and the kind of question. */
export function pCorrect(theta, b, kind, options = 4, falseAlarm = 0.05) {
  const known = phi(theta + b - (kind === 'recall' ? RECALL_COST : 0));
  if (kind === 'yesno') return falseAlarm + (1 - falseAlarm) * known;
  if (kind === 'recall') return known;
  const g = 1 / Math.max(2, options);
  return g + (1 - g) * known;
}

/* Observations are bucketed before fitting. Ten thousand answers collapse into
   a couple of hundred (difficulty, kind, options) cells, which is what makes it
   affordable to refit from the complete history on every load rather than
   carrying a running estimate forward and hoping it has not drifted. */
export function bucket(observations, { halfLifeDays = 240, now = Date.now() } = {}) {
  const cells = new Map();
  for (const o of observations) {
    if (o.b == null || !Number.isFinite(o.b)) continue;
    const ageDays = (now - o.t) / 86400000;
    // Vocabulary grows, so a word answered two years ago is weaker evidence
    // about today than one answered this morning.
    const w = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
    if (w < 0.02) continue;
    const key = `${Math.round(o.b * 20)}|${o.kind}|${o.options || 0}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { b: Math.round(o.b * 20) / 20, kind: o.kind, options: o.options || 4, n: 0, k: 0 }));
    c.n += w;
    if (o.ok) c.k += w;
  }
  return [...cells.values()];
}

/** Beta(1,4) posterior mean over the pseudoword trials: cautious, and never 0. */
export function falseAlarmRate(observations) {
  let n = 0, yes = 0;
  for (const o of observations) {
    if (o.kind !== 'yesno' || !o.pseudo) continue;
    n++; if (o.ok) yes++;      // for a pseudoword, ok===1 means "claimed it"
  }
  return { rate: (yes + 1) / (n + 5), n, yes };
}

/**
 * Posterior over theta on the grid, given bucketed observations.
 * The prior is deliberately weak: N(0, 1.5^2) spans roughly 25k to 60k lemmas,
 * so a dozen answers move it and it never pins the estimate on its own.
 */
export function fitAbility(cells, falseAlarm = 0.05, priorSd = 1.5) {
  const logPost = GRID.map((t) => -(t * t) / (2 * priorSd * priorSd));
  for (const c of cells) {
    for (let i = 0; i < GRID.length; i++) {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, pCorrect(GRID[i], c.b, c.kind, c.options, falseAlarm)));
      logPost[i] += c.k * Math.log(p) + (c.n - c.k) * Math.log(1 - p);
    }
  }
  const max = Math.max(...logPost);
  const post = logPost.map((l) => Math.exp(l - max));
  const total = post.reduce((a, b) => a + b, 0);
  for (let i = 0; i < post.length; i++) post[i] /= total;

  let mean = 0;
  for (let i = 0; i < GRID.length; i++) mean += GRID[i] * post[i];
  let varSum = 0;
  for (let i = 0; i < GRID.length; i++) varSum += post[i] * (GRID[i] - mean) ** 2;

  const at = (q) => {
    let acc = 0;
    for (let i = 0; i < GRID.length; i++) {
      acc += post[i];
      if (acc >= q) return GRID[i];
    }
    return GRID[GRID.length - 1];
  };
  const trials = cells.reduce((a, c) => a + c.n, 0);
  return { theta: mean, sd: Math.sqrt(varSum), lo: at(0.025), hi: at(0.975), post, trials };
}

/**
 * Expected number of lemmas known at a given ability.
 * hist is the prevalence distribution of the whole 61,853-word inventory,
 * binned; summing Phi(theta + b) over it IS the vocabulary estimate.
 */
export function vocabularyAt(theta, hist) {
  let v = 0;
  for (const [centre, count] of hist) v += count * phi(theta + centre);
  return v;
}

/** Fisher information for one item -- how much a question would tell us. */
export function information(theta, b, kind, options = 4, falseAlarm = 0.05) {
  const h = 1e-4;
  const p = pCorrect(theta, b, kind, options, falseAlarm);
  if (p <= 1e-6 || p >= 1 - 1e-6) return 0;
  const d = (pCorrect(theta + h, b, kind, options, falseAlarm)
    - pCorrect(theta - h, b, kind, options, falseAlarm)) / (2 * h);
  return (d * d) / (p * (1 - p));
}

/**
 * The prevalence that would be most informative right now.
 * For a yes/no item the peak is exactly at b = -theta (a coin-flip word). For a
 * multiple choice item guessing shifts the peak, so it is solved numerically.
 */
export function targetPrevalence(theta, kind, options = 4, falseAlarm = 0.05) {
  let best = -theta, bestI = -1;
  for (let b = -theta - 2.5; b <= -theta + 2.5; b += 0.05) {
    const i = information(theta, b, kind, options, falseAlarm);
    if (i > bestI) { bestI = i; best = b; }
  }
  return best;
}

/**
 * Lemmas -> word forms.
 *
 * Published vocabulary numbers are not comparable unless they agree on what
 * counts as one word. A lemma counts 'walk', 'walks', 'walked' and 'walking'
 * once. Tests that report much larger numbers are usually counting inflected
 * and transparently derived forms instead, which roughly doubles the total.
 * The factor is a convention, not a measurement, and the app says so wherever
 * it shows the converted figure.
 */
export const FORMS_PER_LEMMA = 2.0;

/* Reference points on this scale, for reading the number against something.
   Both come from the same body of work as the calibration, so they are on the
   same scale as the estimate -- which numbers from other tests are not. */
export const ANCHORS = [
  { theta: -0.5, label: 'average American 20-year-old', source: 'Brysbaert et al. 2016' },
  { theta: 0.0, label: 'average respondent in the norming study', source: 'Brysbaert et al. 2019' },
];
