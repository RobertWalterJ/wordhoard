"""
Wordhoard - data build.

Turns the cached sources in ./sources into the language pack the app ships:

    app/data/en/words.json      the playable word bank (definitions, packs, tags)
    app/data/en/estimator.json  the calibrated vocabulary-size instrument
    app/data/en/meta.json       counts + provenance, shown in the app's About

Sources (cached, so builds work offline):
  * Brysbaert, Mandera, McCormick & Keuleers (2019), "Word prevalence norms for
    62,000 English lemmas", Behavior Research Methods 51(2). Columns:
    word, Pknown, Nobs, Prevalence (probit), FreqZipfUS.
  * Princeton WordNet 3.0 (via nltk) for definitions, POS, senses, synonyms.

Run:  .venv/Scripts/python.exe build/build_data.py
"""
from __future__ import annotations

import csv
import json
import math
import random
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "sources"
OUT = ROOT / "app" / "data" / "en"
CURATED = ROOT / "build" / "curated"

import nltk  # noqa: E402

nltk.data.path.insert(0, str(SRC / "nltk_data"))
from nltk.corpus import wordnet as wn  # noqa: E402

RNG = random.Random(20260904)

# ---------------------------------------------------------------- thresholds
# Tuned by sampling the (Pknown x Zipf) grid rather than guessed. The finding
# that shaped these: frequency is a bad proxy for usefulness. The high-frequency
# / low-prevalence cells are almost entirely proper-noun homographs -- curie,
# burke, riley, theta, mater -- while the words actually worth owning
# (fastidious, drudgery, satiate, demur, prosaic) sit at HIGH prevalence and LOW
# frequency. So the packs are cut on prevalence, and frequency is ignored.
CORE_PKNOWN = 0.97           # everybody knows it -> warm-ups and distractor stock
CORE_MIN_ZIPF = 3.0
PRECISION_MIN_PKNOWN = 0.62  # you might not know it, but your reader might
RARE_MIN_PKNOWN = 0.22       # below this it is a curiosity, not a word to own
DEF_MIN, DEF_MAX = 9, 170   # definition length that reads well on a phone
WORD_MIN, WORD_MAX = 3, 17

POS_MAP = {"n": 0, "v": 1, "a": 2, "s": 2, "r": 3}
POS_NAMES = ["noun", "verb", "adjective", "adverb"]

# Where the junk concentrates, established by sampling each WordNet domain
# rather than guessed. These are the fields whose vocabulary is a parts
# catalogue: species and foodstuffs (loach, willet, areca, sukiyaki), the
# periodic table and the reagent shelf (indium, gallium, aniline, lecithin),
# anatomy (pylorus, reticulocyte, ileum), laboratory processes (acylation,
# desorption, metaphase) and units and currencies (kiloliter, krone, gigabit).
# Knowing any of them is trivia. Curated terms are assigned their pack before
# this test runs, so a hand-picked word from one of these fields still gets in.
BLOCKED_LEX = {
    "noun.animal", "noun.plant", "noun.food",
    "noun.substance", "noun.body", "noun.process", "noun.quantity",
}

# Definition patterns that mark a gloss as an encyclopedia entry rather than a
# meaning: species, places, people, currencies. The chemistry and medicine
# patterns are here rather than in BLOCKED_LEX because they leak in through
# other domains -- 'impetigo' is filed as a noun.state, not a noun.body.
JUNK_DEF = re.compile(
    r"\bgenus\b|\bfamily [A-Z]|\border [A-Z]|any of (?:numerous|several|various|many)\b"
    r"|\bnative to\b|\bmonetary unit\b|\b(?:100|1000) \w+ equal\b|\bworth one\b"
    r"|\b\d{3,4}\s*[-–]\s*\d{3,4}\b|\bborn in \d|\b(?:city|town|river|mountain|island|"
    r"province|capital|seaport|region) (?:in|of|on) \b|\bUnited States \w+ (?:who|born)\b"
    r"|\bthe former name of\b|\ba unit of (?:length|weight|volume|area|capacity) (?:in|used)\b"
    r"|\b(?:chemical|metallic|radioactive) element\b|\ba salt or ester of\b"
    r"|\ban? (?:organic|inorganic) compound\b|\bany of a (?:class|group|series) of\b"
    r"|\b(?:a|an|any) (?:disease|disorder|infection|inflammation|abnormality) of\b"
    r"|\binflammation of the\b|\bsurgical (?:removal|incision)\b"
    # Targeted rather than a blanket ban on 'disease': that would also take
    # 'contagion' and 'quarantine', which are words worth having.
    r"|\b(?:skin|contagious|infectious|inherited|chronic|venereal) disease\b"
    r"|\bdisease (?:of|caused|characterized|marked|transmitted)\b|\bdrug used to treat\b",
    re.IGNORECASE,
)


def probit(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation)."""
    if p <= 0.0:
        return -6.0
    if p >= 1.0:
        return 6.0
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


# ------------------------------------------------------------------ sources
def load_prevalence() -> dict:
    """word -> {pknown, nobs, prev, zipf}. The calibration backbone."""
    out = {}
    with open(SRC / "brysbaert-prevalence.txt", encoding="utf-8") as fh:
        for row in csv.reader(fh):
            if len(row) < 5:
                continue
            w = row[0].strip().lower()
            try:
                pk, nobs, prev, zipf = float(row[1]), int(row[2]), float(row[3]), float(row[4])
            except ValueError:
                continue
            # The published probit is capped at +/-2.576, which flattens the top
            # of the scale. Recompute from Pknown with a continuity correction so
            # that words everyone knows stay finite but still ordered.
            adj = min(max((pk * nobs + 0.5) / (nobs + 1.0), 1e-4), 1 - 1e-4)
            out[w] = {"pknown": pk, "nobs": nobs, "prev": round(probit(adj), 4),
                      "zipf": zipf}
    return out


def load_excluded() -> set:
    """Words kept out of the bank however well they score on everything else.

    WordNet is a 1990s lexicon and records slurs and dated clinical terms
    without comment. A vocabulary game that serves one has failed, whatever the
    pipeline did correctly to get there. The generic obscenity list covers
    swearing rather than slurs, so it is combined with a hand-written list and
    then trimmed by an allow-list, because a moderation list is deliberately
    broad and would otherwise take 'prurient' and 'lascivious' with it.
    """
    ex = json.loads((CURATED / "excluded.json").read_text(encoding="utf-8"))
    out = {w.lower() for w in ex["slurs"]["words"]}
    ldnoobw = SRC / "ldnoobw-en.txt"
    if ldnoobw.exists():
        for line in ldnoobw.read_text(encoding="utf-8").splitlines():
            w = line.strip().lower()
            if w and " " not in w:
                out.add(w)
    return out - {w.lower() for w in ex["keep"]["words"]}


def is_clean_word(w: str) -> bool:
    return WORD_MIN <= len(w) <= WORD_MAX and re.fullmatch(r"[a-z]+", w) is not None


# suffix -> extra endings to try on the stem when hunting for the base word.
# The gap is how much better known the stem must be before the derived form
# counts as free: knowing 'scarce' hands you 'scarceness' at no cost.
TRANSPARENT = {
    "ly": [], "ingly": [], "edly": [], "ness": [], "ish": [], "like": [],
    "less": [], "able": [], "ably": [], "ful": [], "fully": [], "ify": [],
    "ility": ["le"], "ability": ["able"], "ibility": ["ible"], "iness": ["y"],
}
DERIV_GAP = 0.03


def transparent_derivation(w: str, prev: dict) -> bool:
    """Drop words whose meaning falls straight out of a much commoner stem.

    'hobblingly', 'domineeringness', 'scarceness' and 'illegibility' are in the
    prevalence norms because somebody had to be asked about them, but testing
    them teaches nothing: if you know the stem you know the word.
    """
    for suf, extra in TRANSPARENT.items():
        if not w.endswith(suf) or len(w) - len(suf) < 3:
            continue
        stem = w[: -len(suf)]
        cands = [stem, stem + "e", stem + "y"] + [stem + e for e in extra]
        if stem.endswith("i"):
            cands.append(stem[:-1] + "y")
        for cand in cands:
            if cand in prev and prev[cand]["pknown"] >= prev[w]["pknown"] + DERIV_GAP:
                return True
    return False


def transparent_compound(w: str, prev: dict) -> bool:
    """'hosepipe', 'ropewalk', 'kneepan' -- both halves obvious, nothing learned.

    Only splits where BOTH halves are near-universally known count, so opaque
    compounds worth owning ('bellwether', 'whetstone') survive.
    """
    if len(w) < 7 or prev[w]["pknown"] < 0.55:
        return False
    for i in range(3, len(w) - 2):
        a, b = w[:i], w[i:]
        if a in prev and b in prev and prev[a]["pknown"] >= 0.95 and prev[b]["pknown"] >= 0.95:
            return True
    return False


def spelling_variant(w: str, syns: list, prev: dict) -> bool:
    """'maffia', 'highjack', 'bogy' -- the same word, spelled the losing way.

    A synonym inside the same WordNet sense that is much better known and only
    a letter or two away is not a synonym; it is the standard spelling.
    """
    for s in syns:
        s = s.lower()
        if s == w or abs(len(s) - len(w)) > 2 or s not in prev:
            continue
        if prev[s]["pknown"] < prev[w]["pknown"] + 0.15:
            continue
        # cheap edit distance <= 2
        if len(set(s) ^ set(w)) <= 2 and abs(len(s) - len(w)) <= 2:
            shorter, longer = sorted((s, w), key=len)
            if any(longer[:i] + longer[i + 1:] == shorter for i in range(len(longer))) \
                    or sum(a != b for a, b in zip(s, w)) <= 2 and len(s) == len(w):
                return True
    return False


def plural_of_known(w: str, prev: dict) -> bool:
    if w.endswith("s") and not w.endswith("ss") and len(w) > 4:
        if w[:-1] in prev and prev[w[:-1]]["pknown"] >= prev[w]["pknown"] - 0.05:
            return True
        if w.endswith("es") and w[:-2] in prev:
            return True
    return False


# Fields whose senses do not travel: a gloss labelled with one of these is
# describing a term of art, not a word. Mathematics and physics are deliberately
# absent -- 'orthogonal' and 'equilibrium' earn their keep in ordinary prose.
NARROW_DOMAIN = {
    "physiology", "anatomy", "medicine", "pathology", "biology", "botany",
    "zoology", "entomology", "genetics", "chemistry", "dentistry", "psychiatry",
    "biochemistry", "immunology", "embryology", "veterinary medicine",
}


def clean_gloss(d: str) -> str:
    """Strip the usage examples and citations WordNet packs into its glosses.

    A gloss can run 'having the unity destroyed; "a divided nation"-Samuel
    Lubell; -E.B.White'. Everything from the first quoted example or attribution
    onward is illustration, not meaning, and shown as a multiple-choice option it
    reads as a mistake.
    """
    d = d.strip()
    for marker in ('; "', ' "'):
        i = d.find(marker)
        if i > 8:
            d = d[:i]
    # Trailing attributions, stripped one at a time because a gloss can carry
    # several: '...; -Samuel Lubell; -E.B.White'. Anchored to the end and
    # requiring a capitalised name so an ordinary dashed phrase survives.
    prev = None
    while prev != d:
        prev = d
        d = re.sub(r"\s*[;,]?\s*-{1,2}\s*[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*\s*$",
                   "", d).strip()
    # WordNet quotes with a backtick opening and a straight apostrophe closing,
    # which renders as a stray accent on screen.
    d = re.sub(r"`([^'`]{1,24})'", lambda m: "‘" + m.group(1) + "’", d)
    return re.sub(r"\s*[;,]\s*$", "", d)


def pick_sense(w: str):
    """Dominant WordNet sense: definition, POS, lexname, synonyms, example.

    WordNet orders senses by corpus frequency, so the first usable one is the
    sense a reader will have in mind. A sense is rejected when it is really a
    proper noun wearing lower case (Curie, Burke, Riley), when its gloss is an
    encyclopedia entry rather than a meaning, or when the gloss contains the
    word itself and would hand over the answer.
    """
    syns = wn.synsets(w)
    if not syns:
        return None
    stems = {w[:5]}
    for pre in ("un", "in", "im", "ir", "il", "dis", "non", "anti", "counter"):
        if w.startswith(pre) and len(w) - len(pre) >= 5:
            stems.add(w[len(pre):len(pre) + 5])
    for s in syns[:6]:
        if s.pos() not in POS_MAP:
            continue
        names = [n.replace("_", " ") for n in s.lemma_names()]
        lowered = [n.lower() for n in names]
        # nltk lemmatises on lookup, so synsets('bobbed') quietly returns the
        # senses of 'bob' and synsets('leapt') those of 'leap'. Requiring the
        # word to be a lemma of its own sense keeps inflected forms -- and the
        # base word's definition attached to them -- out of the bank entirely.
        if w not in lowered:
            continue
        # 'curie' the unit and 'Curie' the physicist share a spelling; if the
        # sense stores the word capitalised, this sense is the physicist.
        if any(n.lower() == w and n[0].isupper() for n in names):
            continue
        d = clean_gloss(s.definition() or "")
        # A leading '(physiology)' marks a sense that only lives inside one
        # field; other parentheticals ('(often followed by...)') are harmless
        # and just get tidied away.
        marker = re.match(r"^\(([a-z, ]+)\)\s*", d)
        if marker:
            if any(part.strip() in NARROW_DOMAIN for part in marker.group(1).split(",")):
                continue
            d = d[marker.end():]
        if not (DEF_MIN <= len(d) <= DEF_MAX):
            continue
        # 'insensibility' defined as 'a lack of sensibility' is not a question.
        # Checking the negated stem as well as the word's own catches the whole
        # family of these.
        if any(st in d.lower() for st in stems):
            continue
        if JUNK_DEF.search(d):
            continue
        ex = next((e for e in s.examples() if w in e.lower() and len(e) < 140), None)
        return {
            "def": d[0].upper() + d[1:],
            "pos": POS_MAP[s.pos()],
            "lex": s.lexname(),
            "syn": [n for n in names if n.lower() != w][:4],
            "ex": ex,
        }
    return None


# --------------------------------------------------------------- pseudowords
def build_pseudowords(real: set, train: set, n: int) -> list:
    """Length-matched pronounceable non-words, for the yes/no false-alarm rate.

    A letter 4-gram model trained on the real lexicon produces strings that obey
    English orthotactics ('brantle', 'quiscent') without being words. Anything
    that turns out to be real, or that differs from a real word by a single
    letter, is rejected -- a near-miss would measure spelling, not vocabulary.
    """
    ONSETS = ["b", "bl", "br", "c", "ch", "cl", "cr", "d", "dr", "f", "fl", "fr",
              "g", "gl", "gr", "h", "j", "k", "l", "m", "n", "p", "pl", "pr",
              "qu", "r", "s", "sc", "sh", "sk", "sl", "sm", "sn", "sp", "st",
              "str", "sw", "t", "th", "tr", "tw", "v", "w", "wh", "z", ""]
    NUCLEI = ["a", "e", "i", "o", "u", "ai", "ea", "ee", "oa", "oo", "ou", "ow",
              "au", "ie", "oi", "ur", "ar", "or", "y"]
    CODAS = ["", "", "b", "ck", "ct", "d", "ft", "g", "l", "ld", "lk", "lt", "m",
             "mp", "n", "nch", "nd", "ng", "nk", "nt", "p", "r", "rd", "rk",
             "rm", "rn", "rt", "s", "sh", "sk", "sp", "st", "t", "th", "x"]
    TAILS = ["", "", "", "le", "er", "ish", "ous", "ant", "ent", "id", "age",
             "ure", "ive", "y", "en", "et", "il", "ock", "um"]

    # An n-gram model over ordinary English, used to *score* candidates rather
    # than to generate them. Generating from it produces prefix salad
    # ('unvitomy', 'premetin'); scoring with it reliably separates 'flenge'
    # from 'epigorgh'.
    order = 4
    counts = defaultdict(lambda: defaultdict(int))
    for w in train:
        if not (4 <= len(w) <= 12):
            continue
        s = "^" * (order - 1) + w + "$"
        for i in range(len(s) - order + 1):
            counts[s[i:i + order - 1]][s[i + order - 1]] += 1
    totals = {k: sum(v.values()) for k, v in counts.items()}

    def score(w: str) -> float:
        """Mean log-probability per letter under the English n-gram model."""
        s = "^" * (order - 1) + w + "$"
        tot = 0.0
        for i in range(len(s) - order + 1):
            ctx, ch = s[i:i + order - 1], s[i + order - 1]
            c = counts.get(ctx)
            tot += math.log((c.get(ch, 0) + 0.1) / (totals.get(ctx, 0) + 2.6)) if c \
                else math.log(1e-4)
        return tot / (len(s) - order + 1)

    # Substrings that would let a real word show through: 'coatlaw' is not a
    # convincing non-word because you can see 'coat' and 'law' in it.
    embeddable = {w for w in real if 4 <= len(w) <= 8}
    alphabet = "abcdefghijklmnopqrstuvwxyz"

    # Three-consonant runs English actually permits. Anything else ('noindboap',
    # 'cluthhoun') is unpronounceable, and an unpronounceable decoy is one the
    # reader rejects on sight -- which understates how much they over-claim.
    LEGAL3 = {
        "str", "spr", "scr", "spl", "shr", "thr", "sch", "phr", "chr",
        "nch", "nkl", "ngl", "ntr", "ndr", "ndl", "ngr", "nst", "nsp", "nct",
        "mbl", "mpl", "mpt", "mps", "mbr", "ncl", "nkr", "nfl", "ntl",
        "rch", "rth", "rst", "rsh", "rkl", "rtl", "rdl", "rbl", "rfl", "rgl",
        "rpl", "rtr", "rdr", "rgr", "rkr", "rmb", "rnt", "rnd", "rmp", "rps",
        "lch", "lth", "lst", "lkl", "ltr", "ldr", "lfr", "lbr", "lpl",
        "ckl", "ctr", "ctl", "ghtl", "sts", "scl", "skr", "sthm",
    }

    def acceptable(w: str) -> bool:
        if not (5 <= len(w) <= 9) or w in real or not is_clean_word(w):
            return False
        if re.search(r"(.)\1\1|[^aeiouy]{4}|q(?!u)|[jvwx]$", w):
            return False
        for run in re.findall(r"[^aeiouy]{3}", w):
            if run not in LEGAL3:
                return False
        if any(w[i:i + k] in embeddable
               for k in range(4, 9) for i in range(len(w) - k + 1)):
            return False
        if any(w[:i] + w[i + 1:] in real for i in range(len(w))):
            return False  # one deletion away from a real word
        if any(w[:i] + c + w[i + 1:] in real for i in range(len(w)) for c in alphabet):
            return False  # one substitution away from a real word
        return True

    cands, seen = [], set()
    for _ in range(n * 300):
        w = ""
        for syl in range(RNG.choice([1, 2, 2, 2, 3])):
            w += RNG.choice(ONSETS) if syl == 0 or RNG.random() < 0.85 else ""
            w += RNG.choice(NUCLEI)
            w += RNG.choice(CODAS)
        w += RNG.choice(TAILS)
        if w in seen or not acceptable(w):
            continue
        seen.add(w)
        cands.append(w)
    # Use the score as a floor, not a ranking. Taking the top n by score returns
    # 1,200 variations on '-ive' and '-ous', and a test-taker who spots the
    # pattern stops judging the words and starts judging the shape.
    # Walk down in score order, but allow only a few words to share an ending.
    # Quality comes from the ordering; variety comes from the cap.
    scored = sorted(((score(w), w) for w in cands), reverse=True)
    used = defaultdict(int)
    out = []
    for _, w in scored:
        if used[w[-3:]] >= 3:
            continue
        used[w[-3:]] += 1
        out.append(w)
        if len(out) >= n:
            break
    RNG.shuffle(out)
    return out


# --------------------------------------------------------------------- build
def main() -> int:
    print("Wordhoard data build")
    print("=" * 64)

    prev = load_prevalence()
    print(f"prevalence norms          {len(prev):>7,} lemmas")

    excluded = load_excluded()
    print(f"excluded terms            {len(excluded):>7,} slurs and obscenities")

    real_words = set(prev)
    for w in wn.all_lemma_names():
        if "_" not in w and w.isalpha():
            real_words.add(w.lower())
    print(f"real-word rejection set   {len(real_words):>7,} forms")

    # ---- 1. the estimator's population model -------------------------------
    # V(theta) = sum over the whole inventory of Phi(theta + prev_i). Binning the
    # prevalence values costs nothing in accuracy and ships as 2 KB, not 300 KB.
    BIN = 0.05
    hist = defaultdict(int)
    for rec in prev.values():
        hist[int(round(rec["prev"] / BIN))] += 1
    hist_pairs = sorted((k * BIN, v) for k, v in hist.items())
    print(f"prevalence histogram      {len(hist_pairs):>7,} bins")

    # ---- 2. the playable word bank -----------------------------------------
    words = []
    skipped = defaultdict(int)
    for w, rec in prev.items():
        if not is_clean_word(w):
            skipped["shape"] += 1
            continue
        if w in excluded:
            skipped["slur or obscenity"] += 1
            continue
        if transparent_derivation(w, prev):
            skipped["transparent derivation"] += 1
            continue
        if transparent_compound(w, prev):
            skipped["transparent compound"] += 1
            continue
        if plural_of_known(w, prev):
            skipped["inflected form"] += 1
            continue
        sense = pick_sense(w)
        if sense is None:
            skipped["no usable WordNet sense"] += 1
            continue
        if spelling_variant(w, sense["syn"], prev):
            skipped["non-standard spelling"] += 1
            continue
        words.append({"w": w, **rec, **sense, "cal": 1})
    print(f"candidate word bank       {len(words):>7,} words")
    for k, v in sorted(skipped.items(), key=lambda kv: -kv[1]):
        print(f"    skipped: {k:<28} {v:>7,}")

    # ---- 3. packs ----------------------------------------------------------
    dom_path = CURATED / "domain.json"
    curated_domain = json.loads(dom_path.read_text(encoding="utf-8")) if dom_path.exists() else {"words": []}
    domain_note = {d["w"].lower(): d.get("note") for d in curated_domain.get("words", [])}

    # A hand-written definition beats WordNet's for the curated terms: WordNet
    # glosses 'stochastic' as "being or having a random variable", which is
    # true and useless.
    domain_def = {d["w"].lower(): d.get("def") for d in curated_domain.get("words", [])}

    kept = []
    for rec in words:
        w = rec["w"]
        pk, zipf = rec["pknown"], rec["zipf"]
        rec["note"] = domain_note.get(w)
        if domain_def.get(w):
            rec["def"] = domain_def[w]
        if w in domain_note:
            rec["pack"] = "builtform"          # curated, so it bypasses the filters
        elif rec["lex"] in BLOCKED_LEX:
            skipped["taxonomy / foodstuff"] += 1
            continue
        elif pk >= CORE_PKNOWN and zipf >= CORE_MIN_ZIPF:
            rec["pack"] = "core"
        elif PRECISION_MIN_PKNOWN <= pk < CORE_PKNOWN:
            rec["pack"] = "precision"
        elif RARE_MIN_PKNOWN <= pk < PRECISION_MIN_PKNOWN:
            rec["pack"] = "rare"
        else:
            # Either known by almost nobody, or known by everybody but too
            # obscure in print to be worth a warm-up slot.
            skipped["outside the playable range"] += 1
            continue
        kept.append(rec)
    words = kept

    # Curated terms that the automatic pipeline could not supply: absent from
    # the prevalence norms, absent from WordNet, or multi-word. They carry their
    # own definition, so they go in on the strength of the hand-written entry.
    have = {r["w"] for r in words}
    added, unusable = 0, []
    for d in curated_domain.get("words", []):
        w = d["w"].lower()
        if w in have:
            continue
        sense = pick_sense(w) if re.fullmatch(r"[a-z]+", w) else None
        definition = d.get("def") or (sense["def"] if sense else None)
        if not definition:
            unusable.append(w)
            continue
        base = prev.get(w)
        words.append({
            "w": w,
            "pknown": d.get("pknown", base["pknown"] if base else 0.3),
            "prev": base["prev"] if base else round(probit(d.get("pknown", 0.3)), 4),
            "zipf": d.get("zipf", base["zipf"] if base else 2.0),
            "def": definition,
            "pos": sense["pos"] if sense else 0,
            "lex": sense["lex"] if sense else "curated",
            "syn": sense["syn"] if sense else [],
            "ex": sense["ex"] if sense else None,
            "note": d.get("note"),
            "pack": "builtform",
            # Prevalence is measured for words in the norms and assumed for the
            # rest. Only measured words may inform the ability estimate.
            "cal": 1 if base else 0,
        })
        added += 1
    print(f"curated terms merged in   {added:>7,}"
          + (f"   (no definition available: {', '.join(unusable)})" if unusable else ""))

    counts = defaultdict(int)
    for rec in words:
        counts[rec["pack"]] += 1
    print("pack sizes                " + "  ".join(f"{k}={v:,}" for k, v in sorted(counts.items())))

    # ---- 4. write ----------------------------------------------------------
    lexnames = sorted({r["lex"] for r in words})
    lex_ix = {n: i for i, n in enumerate(lexnames)}
    packs = ["core", "precision", "rare", "builtform"]
    pack_ix = {n: i for i, n in enumerate(packs)}

    rows = []
    for r in sorted(words, key=lambda r: (-r["pknown"], r["w"])):
        rows.append([
            r["w"], round(r["pknown"], 3), round(r["prev"], 3), round(r["zipf"], 2),
            r["pos"], lex_ix[r["lex"]], pack_ix[r["pack"]], r["def"],
            r["ex"], r["syn"] or None, r["note"], r.get("cal", 1),
        ])

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "words.json").write_text(json.dumps({
        "lang": "en",
        "built": date.today().isoformat(),
        "cols": ["w", "pknown", "prev", "zipf", "pos", "lex", "pack", "def", "ex", "syn",
                 "note", "cal"],
        "pos": POS_NAMES,
        "lex": lexnames,
        "packs": packs,
        "rows": rows,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ---- 5. the estimator instrument ---------------------------------------
    # Items are drawn to cover the prevalence range evenly, because that is where
    # the information about theta lives: words everyone knows and words nobody
    # knows tell you almost nothing.
    have_def = {r["w"] for r in words}
    strata = defaultdict(list)
    for w, rec in prev.items():
        if is_clean_word(w) and w not in excluded:
            strata[min(int(rec["pknown"] * 20), 19)].append(w)
    items = []
    for band in range(20):
        pool = sorted(strata[band])
        RNG.shuffle(pool)
        for w in pool[:180]:
            rec = prev[w]
            items.append([w, round(rec["prev"], 3), round(rec["pknown"], 3),
                          round(rec["zipf"], 2), 1 if w in have_def else 0])
    RNG.shuffle(items)
    everyday = {w for w, rec in prev.items() if rec["pknown"] >= 0.5 and is_clean_word(w)}
    pseudo = build_pseudowords(real_words, everyday, 1200)
    print(f"estimator items           {len(items):>7,}")
    print(f"pseudowords               {len(pseudo):>7,}   e.g. {', '.join(pseudo[:10])}")

    (OUT / "estimator.json").write_text(json.dumps({
        "lang": "en",
        "built": date.today().isoformat(),
        "inventory": len(prev),
        "binWidth": BIN,
        "hist": [[round(c, 3), n] for c, n in hist_pairs],
        "itemCols": ["w", "prev", "pknown", "zipf", "hasDef"],
        "items": items,
        "pseudo": pseudo,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # sanity check: theta = 0 is the average respondent in Brysbaert's sample
    def V(theta):
        return sum(n * 0.5 * (1 + math.erf((theta + c) / math.sqrt(2))) for c, n in hist_pairs)

    print()
    print("estimator calibration     V(theta) = expected lemmas known")
    for t in (-2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 3.0):
        print(f"    theta {t:+.1f}   {V(t):>9,.0f} lemmas")

    # ---- 6. confusables ----------------------------------------------------
    # Hand-authored, so the build's job is to validate rather than generate: an
    # item whose answer is not among its own options would be unanswerable.
    # The two kinds are played differently, so they are checked differently:
    #   pair  -> fill the blank, choosing between the set's words
    #   drift -> "which sentence uses this word correctly?", so the set needs
    #            exactly one right use and at least one trap
    conf = json.loads((CURATED / "confusables.json").read_text(encoding="utf-8"))
    problems, n_items = [], 0
    for s in conf["sets"]:
        for it in s["items"]:
            n_items += 1
            if "___" not in it["sentence"]:
                problems.append(f"{s['id']}: no blank in '{it['sentence'][:40]}...'")
        if s["kind"] == "pair":
            if len(set(s["words"])) < 2:
                problems.append(f"{s['id']}: a pair set needs at least two words")
            for it in s["items"]:
                opts = it.get("options") or s["words"]
                if len(set(opts)) < 2:
                    problems.append(f"{s['id']}: '{it['answer']}' has fewer than two options")
                if it["answer"] not in opts:
                    problems.append(f"{s['id']}: '{it['answer']}' is not among its options {opts}")
        else:
            traps = [it for it in s["items"] if it.get("trap")]
            right = [it for it in s["items"] if not it.get("trap")]
            if len(right) != 1 or not traps:
                problems.append(f"{s['id']}: drift needs one correct use and at least one trap "
                                f"(has {len(right)} and {len(traps)})")
            if not s.get("wrong"):
                problems.append(f"{s['id']}: drift set has no 'wrong' gloss")
    if problems:
        print("  CONFUSABLE PROBLEMS:")
        for p in problems:
            print("    " + p)
    print(f"confusables               {len(conf['sets']):>7,} sets, {n_items} items")
    (OUT / "confusables.json").write_text(
        json.dumps(conf, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    (OUT / "meta.json").write_text(json.dumps({
        "built": date.today().isoformat(),
        "words": len(rows),
        "packs": dict(counts),
        "confusables": {"sets": len(conf["sets"]), "items": n_items},
        "inventory": len(prev),
        "sources": [
            {"name": "Word prevalence norms for 62,000 English lemmas",
             "who": "Brysbaert, Mandera, McCormick & Keuleers (2019)",
             "where": "Behavior Research Methods 51(2), 467-479",
             "use": "how many people know each word - the calibration behind the size estimate"},
            {"name": "WordNet 3.0", "who": "Princeton University",
             "where": "wordnet.princeton.edu",
             "use": "definitions, parts of speech, synonyms"},
        ],
    }, indent=2), encoding="utf-8")

    print()
    for f in ("words.json", "estimator.json", "confusables.json", "meta.json"):
        print(f"    wrote app/data/en/{f:<16} {(OUT / f).stat().st_size / 1024:>8,.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
