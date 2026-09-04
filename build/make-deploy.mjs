/* Assemble the deployable site from app/.
 *
 * Writes two identical copies:
 *   docs/      what GitHub Pages serves (Settings > Pages > branch main, /docs)
 *   dist/web   the same thing zipped-ready, for any other static host
 *
 * Everything the app asks for is a relative path -- the manifest's start_url
 * and scope, the service worker registration, the font and data URLs -- so the
 * site works unchanged at a subpath like /wordhoard/ as well as at a domain
 * root. That is the one thing worth checking before a Pages deploy, and
 * build/check-subpath.mjs checks it.
 *
 * Run:  node build/make-deploy.mjs
 */
import { mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'app');

const FILES = [
  'index.html',
  'styles.css',
  'fonts.css',
  'sw.js',
  'manifest.webmanifest',
  'js/app.js',
  'js/ability.js',
  'js/data.js',
  'js/modes.js',
  'js/speech.js',
  'js/store.js',
  'data/en/words.json',
  'data/en/estimator.json',
  'data/en/confusables.json',
  'data/en/meta.json',
  'fonts/literata-latin-normal-400.woff2',
  'fonts/literata-latin-normal-600.woff2',
  'fonts/literata-latin-normal-700.woff2',
  'fonts/literata-latin-italic-400.woff2',
  'fonts/literata-latin-ext-normal-400.woff2',
  'fonts/archivo-latin-400.woff2',
  'fonts/archivo-latin-500.woff2',
  'fonts/archivo-latin-600.woff2',
  'fonts/archivo-latin-700.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

for (const target of [join(ROOT, 'docs'), join(ROOT, 'dist', 'web')]) {
  rmSync(target, { recursive: true, force: true });
  let bytes = 0;
  for (const f of FILES) {
    const from = join(APP, f);
    const to = join(target, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    bytes += statSync(from).size;
  }
  // Pages runs Jekyll by default, which ignores files and folders beginning
  // with an underscore and can rewrite things it thinks are templates.
  writeFileSync(join(target, '.nojekyll'), '');
  console.log(`${target.replace(ROOT, '.')}  ${FILES.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

// A quick guard against the mistake that would break a subpath deploy: an
// absolute path anywhere in the shipped source.
const offenders = [];
for (const f of FILES.filter((f) => /\.(html|css|js|webmanifest)$/.test(f))) {
  const text = readFileSync(join(APP, f), 'utf8');
  for (const m of text.matchAll(/(?:src|href|url\(|register\()\s*['"(]?(\/[^'")\s]+)/g)) {
    if (!m[1].startsWith('//')) offenders.push(`${f}: ${m[1]}`);
  }
}
if (offenders.length) {
  console.log('\nABSOLUTE PATHS -- these would break a subpath deploy:');
  for (const o of offenders) console.log('  ' + o);
  process.exit(1);
}
console.log('\nall paths relative: the site works at a domain root or a subpath');
