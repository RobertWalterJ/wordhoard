/* Fold the whole app into one HTML file.
 *
 * The PWA in app/ is many files, which is right for a server and impossible for
 * an Artifact: that sandbox serves a single document and blocks fetches to
 * anything else. So the data, the fonts and the five ES modules all have to end
 * up inside one file.
 *
 * The modules keep their `import` / `export` syntax on disk -- rewriting them by
 * hand into one script would make the source worse to read for the sake of the
 * build. Instead they are mechanically rewritten here into a tiny registry.
 * That is safe because this is a closed set of five files using a small, regular
 * subset of module syntax, and the build fails loudly if it meets anything else.
 *
 * Run:  node build/bundle-single.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'app');
const read = (p) => readFileSync(join(APP, p), 'utf8');

/* --------------------------------------------------------------- modules */

const MODULE_ORDER = ['js/ability.js', 'js/store.js', 'js/speech.js', 'js/data.js', 'js/modes.js', 'js/app.js'];

function transform(path) {
  let src = read(path);
  const exported = new Set();

  // export function foo / export const foo / export async function foo
  src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_, kind, name) => { exported.add(name); return `${kind} ${name}`; });

  // import { a, b as c } from './x.js'
  src = src.replace(/^import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.]+)';?$/gm,
    (_, names, file) => `const {${names}} = __require('js/${file}');`);

  // import * as NS from './x.js'
  src = src.replace(/^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*'\.\/([\w.]+)';?$/gm,
    (_, ns, file) => `const ${ns} = __require('js/${file}');`);

  const leftover = src.match(/^\s*(import|export)\s.*$/m);
  if (leftover) throw new Error(`${path}: unhandled module syntax -> ${leftover[0].trim()}`);

  return `__modules['${path}'] = function (__exports, __require) {\n${src}\n`
    + `Object.assign(__exports, { ${[...exported].join(', ')} });\n};`;
}

/* ----------------------------------------------------------------- fonts */

function inlineFonts() {
  let css = read('fonts.css');
  css = css.replace(/url\('([^']+)'\)/g, (_, rel) => {
    const b64 = readFileSync(join(APP, rel)).toString('base64');
    return `url('data:font/woff2;base64,${b64}')`;
  });
  return css;
}

/* ------------------------------------------------------------------ build */

const data = Object.fromEntries(
  ['words', 'estimator', 'confusables', 'meta']
    .map((f) => [f, JSON.parse(read(`data/en/${f}.json`))]));

// Extract the markup between <main> and </main> plus the boot splash, so the
// page structure stays defined in one place: index.html.
const html = read('index.html');
const boot = html.match(/<div id="boot"[\s\S]*?<\/div>\s*<\/div>/)[0];
const main = html.match(/<main id="app"[\s\S]*?<\/main>/)[0];
// The verdict sheet deliberately lives outside <main>, so it has to be lifted
// separately or the single-file build ships without it.
const sheet = html.match(/<div class="sheet" id="sheet"[\s\S]*?\n<\/div>/)[0];

const out = `<title>Wordhoard</title>
<meta name="description" content="A vocabulary game that tests, expands and calibrates how many English words you know.">
<style>
${inlineFonts()}
${read('styles.css')}
</style>
${boot}
${main}
${sheet}
<script>
(function () {
  'use strict';
  // The language pack, inlined. data.js looks here before it tries the network.
  window.__WORDHOARD_DATA = ${JSON.stringify(data)};

  var __modules = {}, __cache = {};
  function __require(name) {
    if (__cache[name]) return __cache[name];
    var exports = __cache[name] = {};
    if (!__modules[name]) throw new Error('missing module ' + name);
    __modules[name](exports, __require);
    return exports;
  }

${MODULE_ORDER.map(transform).join('\n\n')}

  __require('js/app.js');
})();
</script>
`;

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const target = join(ROOT, 'dist', 'wordhoard.html');
writeFileSync(target, out);
console.log(`dist/wordhoard.html   ${(out.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  modules  ${MODULE_ORDER.length}`);
console.log(`  words    ${data.words.rows.length.toLocaleString()}`);
console.log(`  fonts    inlined as data URIs`);
