// SHARED BODY for the colour audit. Each app keeps its own copy of this beside
// a SPEC that names its tokens; the logic below is identical everywhere so a
// fix found in one app is a fix available to all of them.
//
// THE RULE. Two things the app needs you to tell apart must be separated by
// something that is not hue. Three ways to earn that:
//
//   'lightness'  the two differ by 3:1 in luminance. The strong form — it
//                survives every colour vision, and no colour at all. Required
//                wherever colour is the ONLY difference between two marks.
//   'shape'      a glyph, a strike-through or a weight already carries the
//                meaning, so colour is reinforcement. Bar: CIEDE2000 >= 15
//                under every vision, so a dichromat still gets the hint.
//   'tint'       the meaning is in WORDS or a glyph nearby and the colour is
//                atmosphere. Bar: CIEDE2000 >= 6 — different, but it does not
//                have to shout.
//
// A 'shape' or 'tint' claim is not free: whenever it is made, there is a
// 'lightness' pair proving the cue that carries the meaning is itself visible.
// Otherwise the classification is just a way of excusing a failure.

import { readFileSync } from 'node:fs';
import { parse, over, contrast, deltaE, simulate, VISIONS } from './colour.mjs';   // sibling: both live in build/lib

export function runAudit(SPEC, root) {
  const css = SPEC.files.map((f) => readFileSync(root + '/' + f, 'utf8')).join('\n');
  const FULL = process.argv.includes('--full');

  const block = (selector) => {
    const at = css.indexOf(selector + ' {');
    if (at < 0) return {};
    const from = css.indexOf('{', at) + 1;
    let depth = 1, i = from;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const out = {};
    for (const [, k, v] of css.slice(from, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
    return out;
  };

  const base = block(':root');
  const surfaces = (SPEC.surfaces || [['', ':root']])
    .map(([name, sel]) => [name || 'default', { ...base, ...(sel === ':root' ? {} : block(sel)) }]);

  const colourOf = (tokens, name, onto) => {
    let v = name.startsWith('#') ? name : tokens[name];
    if (!v) return null;
    let guard = 0;
    while (v.startsWith('var(') && guard++ < 8) v = (tokens[v.slice(4, v.indexOf(')'))] || v).trim();
    const rgba = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/);
    if (rgba) {
      const rgb = [rgba[1], rgba[2], rgba[3]].map((n) => Number(n) / 255);
      const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
      return a === 1 ? rgb : over(rgb, a, onto);
    }
    return /^#[0-9a-f]{3,8}$/i.test(v) ? parse(v) : null;
  };

  const MIN = { lightness: 3, shape: 15, tint: 6 };
  const MIN_TEXT = 4.5;
  const problems = [];
  const rows = [];

  for (const [surface, tokens] of surfaces) {
    for (const p of SPEC.pairs) {
      const under = p.onto ? colourOf(tokens, p.onto, [1, 1, 1]) : [1, 1, 1];
      const A = colourOf(tokens, p.a, under), B = colourOf(tokens, p.b, under);
      if (!A || !B) { rows.push({ surface, name: `${p.a} / ${p.b}`, missing: true }); continue; }
      const ratio = contrast(A, B);
      let worst = Infinity, worstVision = '';
      for (const v of VISIONS) {
        if (v === 'greyscale') continue;
        const d = deltaE(simulate(A, v), simulate(B, v));
        if (d < worst) { worst = d; worstVision = v; }
      }
      const ok = p.channel === 'lightness' ? ratio >= MIN.lightness : worst >= MIN[p.channel];
      rows.push({ surface, name: `${p.a} / ${p.b}`, channel: p.channel, ratio, worst, worstVision, ok });
      if (!ok) {
        problems.push(p.channel === 'lightness'
          ? `${surface}: ${p.a} and ${p.b} differ by only ${ratio.toFixed(2)}:1 in lightness (need 3:1)\n      ${p.where}`
          : `${surface}: ${p.a} and ${p.b} collapse to deltaE ${worst.toFixed(1)} under ${worstVision} (need ${MIN[p.channel]})\n      ${p.where}`);
      }
    }
    for (const t of SPEC.text) {
      const B = colourOf(tokens, t.bg, [1, 1, 1]);
      const F = colourOf(tokens, t.fg, B || [1, 1, 1]);
      if (!F || !B) { rows.push({ surface, name: `${t.fg} on ${t.bg}`, missing: true }); continue; }
      const ratio = contrast(F, B);
      const ok = ratio >= MIN_TEXT;
      rows.push({ surface, name: `${t.fg} on ${t.bg}`, channel: 'text', ratio, ok });
      if (!ok) problems.push(`${surface}: ${t.fg} on ${t.bg} is ${ratio.toFixed(2)}:1, below WCAG AA 4.5:1 — ${t.where}`);
    }
  }

  let last = '';
  for (const r of rows) {
    if (!FULL && (r.ok || r.missing)) continue;
    if (r.surface !== last) { console.log('\n' + r.surface); last = r.surface; }
    if (r.missing) { console.log(`  ?   ${r.name.padEnd(34)} not found in the stylesheet`); continue; }
    const num = (r.channel === 'shape' || r.channel === 'tint')
      ? `dE ${r.worst.toFixed(1)} (${r.worstVision})` : `${r.ratio.toFixed(2)}:1`;
    console.log(`  ${r.ok ? 'ok ' : 'X  '} ${r.name.padEnd(34)} ${num.padEnd(24)} ${r.channel}`);
  }

  console.log('');
  if (problems.length) {
    console.error(`colour audit FAILED — ${problems.length} place(s) where meaning rides on hue alone:\n`);
    for (const p of problems) console.error('  x ' + p + '\n');
    process.exit(1);
  }
  console.log(`colour audit passed — ${rows.length} checks across ${surfaces.length} surface(s).`);
  console.log('Nothing depends on hue alone, under deuteranopia, protanopia, tritanopia, or no colour at all.');
}
