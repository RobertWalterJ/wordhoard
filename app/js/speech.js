/* Saying the word out loud.
 *
 * A vocabulary you can only read is half a vocabulary -- you will not use a word
 * you are not sure how to say. This wraps the browser's speech synthesis so the
 * rest of the app can ask for a word without knowing anything about voices.
 *
 * Everything here degrades to nothing: on a device with no voices the buttons
 * simply do not appear, rather than appearing and doing nothing.
 */

let voice = null;
let ready = false;

const PREFERRED = [
  // Robert is Canadian; British and Canadian voices read these words the way he
  // would say them. American is the fallback because it is the most likely to
  // exist at all.
  /en[-_]GB/i, /en[-_]CA/i, /en[-_]AU/i, /en[-_]US/i, /^en/i,
];

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;
  // Prefer a local voice: a network voice stalls on a poor connection, and a
  // word that arrives two seconds late is worse than no word.
  const local = voices.filter((v) => v.localService);
  for (const pattern of PREFERRED) {
    for (const pool of [local, voices]) {
      const hit = pool.find((v) => pattern.test(v.lang));
      if (hit) return hit;
    }
  }
  return voices[0] || null;
}

export function available() {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

export function init() {
  if (!available() || ready) return;
  ready = true;
  voice = pickVoice();
  // Voices load asynchronously in most browsers, and on some they are empty on
  // the first call however long you wait for them.
  window.speechSynthesis.addEventListener('voiceschanged', () => { voice = pickVoice(); });
}

export function voiceName() {
  return voice ? `${voice.name} (${voice.lang})` : null;
}

/** Say it. Cancels anything already speaking, so answers cannot pile up. */
export function speak(text, { rate = 0.92 } = {}) {
  if (!available() || !text) return false;
  init();
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = rate;       // a shade under natural: these are unfamiliar words
    u.pitch = 1;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/* Mobile browsers refuse to speak until speech has been started once from a
   real user gesture. Without this the first few words of a round are silently
   swallowed and it looks as though pronunciation simply does not work. */
let unlocked = false;
export function unlock() {
  if (unlocked || !available()) return;
  unlocked = true;
  init();
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch { /* nothing to unlock */ }
}

export function stop() {
  if (available()) {
    try { window.speechSynthesis.cancel(); } catch { /* nothing to stop */ }
  }
}
