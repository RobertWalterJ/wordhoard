/* Does the instrument actually measure what it claims?
 *
 * Simulates respondents of known ability sitting the test, then checks whether
 * the estimator recovers the ability it was given. This is the only way to know
 * the number on the front screen means anything: a vocabulary test cannot be
 * validated against a real person, because nobody knows their own true count.
 *
 * The simulated respondent is deliberately unflattering. He over-claims at a
 * realistic rate, and when he over-claims he then guesses the definition. If
 * the estimator can be fooled by that, this is where it shows.
 *
 * Reports, per ability level:
 *   bias       average error in lemmas (should be near zero)
 *   spread     standard deviation of the estimate across replications
 *   coverage   how often the 95% interval contains the truth (should be ~95%)
 *
 * Run:  node build/check_estimator.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  phi, bucket, fitAbility, vocabularyAt, targetPrevalence, falseAlarmRate,
} from '../app/js/ability.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const est = JSON.parse(readFileSync(join(ROOT, 'app/data/en/estimator.json'), 'utf8'));
const items = est.items.map(([w, prev, pknown, zipf, hasDef]) => ({ w, prev, pknown, hasDef }));
const hist = est.hist;

const LENGTH = 60;
const PSEUDO_SHARE = 0.18;
const REPLICATIONS = 200;
// A respondent who claims words they do not know. Kept modest but non-zero:
// the whole point of the pseudowords is that this happens.
const TRUE_FALSE_ALARM = 0.06;

function simulate(trueTheta) {
  const observations = [];
  const used = new Set();
  let fit = { theta: 0 };
  const nPseudo = Math.round(LENGTH * PSEUDO_SHARE);
  let pseudoUsed = 0;

  for (let i = 0; i < LENGTH; i++) {
    const wantPseudo = pseudoUsed < nPseudo
      && Math.random() < nPseudo / Math.max(1, LENGTH - i);
    if (wantPseudo) {
      pseudoUsed++;
      observations.push({
        w: `__fake${i}`, b: null, kind: 'yesno', options: 0,
        ok: Math.random() < TRUE_FALSE_ALARM ? 1 : 0, t: Date.now(), pseudo: 1,
      });
      continue;
    }
    // same adaptive rule the app uses
    const target = targetPrevalence(fit.theta, 'verify') + (Math.random() - 0.5) * 1.4;
    let best = null, bestD = Infinity;
    for (let n = 0; n < 400; n++) {
      const c = items[Math.floor(Math.random() * items.length)];
      if (used.has(c.w)) continue;
      const d = Math.abs(c.prev - target);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) break;
    used.add(best.w);

    // Two stages: claim it, then define it. The item passes only if both hold.
    const knows = Math.random() < phi(trueTheta + best.prev);
    const claims = knows || Math.random() < TRUE_FALSE_ALARM;
    const passed = claims && (knows || Math.random() < 0.25);
    observations.push({
      w: best.w, b: best.prev, kind: 'verify', options: 4,
      ok: passed ? 1 : 0, t: Date.now(),
    });

    if (i % 6 === 0) {
      const fa = falseAlarmRate(observations);
      fit = fitAbility(bucket(observations), fa.rate);
    }
  }
  const fa = falseAlarmRate(observations);
  return fitAbility(bucket(observations), fa.rate);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
const n0 = (x) => Math.round(x).toLocaleString('en-CA');

console.log(`Wordhoard estimator check — ${REPLICATIONS} simulated respondents per level,`);
console.log(`${LENGTH} items each, ${Math.round(PSEUDO_SHARE * 100)}% pseudowords, `
  + `true false-alarm rate ${TRUE_FALSE_ALARM}\n`);
console.log('  true θ    true lemmas    estimated      bias      spread   95% coverage');
console.log('  ' + '-'.repeat(74));

let worstBias = 0, worstCoverage = 1;
for (const trueTheta of [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0]) {
  const truth = vocabularyAt(trueTheta, hist);
  const ests = [];
  let covered = 0;
  for (let r = 0; r < REPLICATIONS; r++) {
    const fit = simulate(trueTheta);
    ests.push(vocabularyAt(fit.theta, hist));
    if (fit.lo <= trueTheta && trueTheta <= fit.hi) covered++;
  }
  const bias = mean(ests) - truth;
  const coverage = covered / REPLICATIONS;
  worstBias = Math.max(worstBias, Math.abs(bias) / truth);
  worstCoverage = Math.min(worstCoverage, coverage);
  console.log(
    `  ${trueTheta.toFixed(1).padStart(6)}  ${n0(truth).padStart(13)}  ${n0(mean(ests)).padStart(11)}`
    + `  ${(bias >= 0 ? '+' : '') + n0(bias).padStart(8)}  ${n0(sd(ests)).padStart(10)}`
    + `  ${(coverage * 100).toFixed(0).padStart(11)}%`);
}

console.log('');
const biasOk = worstBias < 0.03;
const covOk = worstCoverage > 0.85;
console.log(`  worst relative bias   ${(worstBias * 100).toFixed(1)}%   ${biasOk ? 'ok' : 'TOO HIGH'}`);
console.log(`  worst CI coverage     ${(worstCoverage * 100).toFixed(0)}%   ${covOk ? 'ok' : 'TOO LOW'}`);
console.log('');
console.log('  Note: coverage is checked on theta, where the model lives. The lemma');
console.log('  interval is that interval mapped through a monotone function, so it');
console.log('  covers at the same rate.');

process.exit(biasOk && covOk ? 0 : 1);
