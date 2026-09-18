// Wordhoard — does the palette still carry its information without colour?
//
//   node build/audit-colour.mjs            report, and fail on any loss
//   node build/audit-colour.mjs --full     every check, including the passes
//
// The rule, the three channels and the engine all live in
// build/lib/audit-template.mjs, shared with the sibling apps. This file is only
// the part that is specific to Wordhoard: which tokens mean what, and where.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from './lib/audit-template.mjs';

const SPEC = {
  files: ['app/styles.css'],
  // The whole app inverts by re-pointing eleven values, so both surfaces are
  // audited: parchment for the playing screens, navy for home and the boot.
  surfaces: [['parchment', ':root'], ['navy', 'body[data-screen="home"], .boot']],
  pairs: [
    { a: '--green', b: '--red', channel: 'shape',
      where: 'a graded option: right against wrong' },
    { a: '--green-wash', b: '--red-wash', channel: 'tint',
      where: 'the wash behind a graded option' },
  ],
  text: [
    { fg: '--red', bg: '--red-wash', where: 'the cross and its text on the wrong-answer wash' },
    { fg: '--green', bg: '--green-wash', where: 'the tick and its text on the right-answer wash' },
    { fg: '--text', bg: '--ground', where: 'the word, the definition' },
    { fg: '--text-soft', bg: '--ground', where: 'supporting lines' },
    { fg: '--text-faint', bg: '--ground', where: 'the quietest labels' },
    { fg: '--text', bg: '--card', where: 'cards' },
    { fg: '--accent', bg: '--ground', where: 'the accent, used as text' },
  ],
};

runAudit(SPEC, join(dirname(fileURLToPath(import.meta.url)), '..'));
