# Wordhoard

A vocabulary game for the phone. It does three things: tests what you know,
adds to it, and puts a defensible number on the total.

Double-click **Wordhoard** on the Desktop to run it. Keep the black window open —
that is the server. Closing it stops the app.

---

## The five modes

| Mode | What it is |
|---|---|
| **Rapid Fire** | Timed multiple choice, a set number of questions, difficulty following your level. The scoreboard. |
| **Take the Measure** | The calibrated test: ~90 words, yes/no, with invented words and spot checks mixed in. Produces the vocabulary figure. |
| **Training** | Everything you have missed or starred, returning on a Leitner schedule. Words that survive two rounds switch from recognition to production. |
| **Sharpen** | The confusables — `disinterested`, `fulsome`, `militate`, `nonplussed`. Words you already think you know, used the way they actually mean. |
| **Summon** | Meaning first; you write the word. The step from recognising to using. |

**Pronunciation.** Words are read aloud in whichever English voice the device
provides — on the word as the question appears, on the answer once you have
chosen, or both. A word you are not sure how to say is a word you will not use.
Every word list has a speaker button too. Settings turns it off.

Every answer in every mode feeds the same estimate. Progress accumulates across
sessions rather than resetting.

## How the number works

Each word carries a **measured** difficulty — the proportion of about 220,000
people who said they knew it, from Brysbaert et al. (2019). That makes each word
a test item whose difficulty is known in advance, rather than inferred from how
often it turns up in print.

Your answers fit one number, θ, for how far above or below the average
respondent you sit. The vocabulary figure is then

    V(θ) = Σ over all 61,853 words in the inventory of Φ(θ + prevalence)

an expected count rather than a tally, which is why it carries a range. Three
different response types get three different links: yes/no answers are corrected
for a false-alarm rate estimated from the invented words, multiple choice
accounts for guessing, and written recall carries a fixed production penalty.

**Reference points on the same scale.** θ = −0.5 → about 42,000 lemmas, which is
what Brysbaert reports for the average American twenty-year-old. θ = 0 → about
48,800, the average respondent in the norming study (a self-selected crowd who
choose to take vocabulary tests).

**On comparing with other tests.** Numbers are not comparable across vocabulary
tests unless they agree on the unit. A *lemma* counts walk / walks / walked /
walking once. Tests reporting much larger figures are usually counting inflected
and derived **forms**, which roughly doubles the total — a result near 84,000
forms corresponds to roughly 42,000 lemmas here. The app shows both units and
labels the conversion as the convention it is.

### Is the instrument any good?

Double-click **Check Wordhoard** on the Desktop, or:

```bash
node build/check_estimator.mjs
```

It simulates respondents of known ability sitting the test and checks whether the
estimator recovers the ability it was given — the only way to validate a
vocabulary test, since no real person knows their own true count. Current result:
worst relative bias under 3%, 95% interval coverage 92–95% across the range.

## The look

Built in the same language as Halyard and Reckoner: soft filled cards with a
generous radius, layered shadow rather than outlines, 56px tap targets, gradient
icon tiles, chips and rings doing work that text would otherwise do.

**Two worlds, one palette.** The shelf (home) is the deep world — navy ground,
pale ink, gold. Every other screen inverts into parchment. The same components
arrive in either, because the tokens are re-pointed rather than the rules
rewritten. Both grounds are gradients, and each ramp is arranged so a card is
always clearly lighter than the ground behind it — including at the top, where
the gradient is lightest.

Colours are the Danish naval ensign's: a blue deeper than the flag's red is
bright, a parchment yellow, gold between them, and the ensign's crimson kept in
reserve for one job — being wrong. Nothing else in the app is red.

**Hierarchy.** The word under test is 3rem and bold; everything around it is a
small-caps label or a quiet surface. Colour is spent only where it means
something: gold for what to do next, green for right, crimson for wrong. A tick
and a cross replace the answer letters once you have chosen, because they land
before a letter does.

**The hero says what the tool is** — a drift of real words from your own packs,
reshuffled every visit, the way Halyard's bunting does.

**Two typefaces, two jobs.** Literata sets what you *read* — the word, its
definition, the numbers, the titles. Archivo sets what you *use* — every option,
button, label and stat. Both self-hosted, so they survive offline.

**It moves on by itself.** Tapping an answer shows the verdict and a line runs
down showing how long you have to read it — longer when you were wrong, longer
again when there is an explanation. A tap anywhere skips ahead.

This commits to a single art direction rather than following the system theme:
the inversion between the shelf and the pages *is* the identity.

## The word bank

19,353 playable words in four packs, built rather than hand-listed:

- **Precision** (8,700) — words that do work a common word cannot. `fulsome`,
  `implacable`, `obviate`, `locution`, `languorous`.
- **Rare & literary** (3,400) — `penury`, `philippic`, `poltroon`, `arrant`.
- **Built form & science** (123) — hand-curated. Architecture terms and the
  scientific words that carry meaning in general English, deliberately excluding
  taxonomic Latin, unit names and jargon that cannot travel outside its field.
- **Everyday** (7,150) — warm-ups and distractor stock, not a study pack.

Plus 62 confusable sets (124 items), hand-written.

**What is kept out.** WordNet is a 1990s lexicon and records slurs and dated
clinical terms without comment. `build/curated/excluded.json` holds a
hand-written list of them, combined with the standard obscenity list and then
trimmed by an allow-list — a moderation list is built to be broad, and would
otherwise take `prurient`, `courtesan` and `ribald` with it.

The pipeline's real work is exclusion. Frequency turned out to be a bad proxy for
usefulness — the high-frequency, low-prevalence cells are almost entirely
proper-noun homographs (`curie`, `burke`, `riley`) — so the packs are cut on
prevalence and frequency is ignored. Filters remove transparent derivations
(`scarceness`), transparent compounds (`hosepipe`), inflected forms whose
definition WordNet silently lemmatised away (`bobbed` glossed as `bob`),
non-standard spellings (`maffia`), and the domains where vocabulary is really a
parts catalogue: species, foodstuffs, the periodic table, anatomy, units.

## Building

```bash
.venv/Scripts/python.exe build/build_data.py     # sources -> app/data/en/*.json
node build/bundle-single.mjs                     # -> dist/wordhoard.html
node build/make-icons.mjs                        # -> app/icons/*.png
node build/check_estimator.mjs                   # validate the estimator
```

Sources are cached in `sources/`, so builds work offline. `build/curated/` holds
the two hand-written files — the confusables and the architecture/science pack.

## Layout

```
app/            the PWA — installable, works offline, no account, no server
  js/           ability.js (the model) · data.js · store.js · modes.js · app.js
  data/en/      the language pack
build/          the pipeline, the curated content, the estimator check
sources/        cached raw data
dist/           single-file build, for hosting anywhere
```

## Another language

The data path is `app/data/<lang>/` and the engine reads a language pack rather
than English specifically. Prevalence norms of the same kind exist for Dutch and
Spanish; a new pack drops in beside this one without the engine changing. The
confusables would have to be written by hand for each language, since that is
the one part no dataset provides.

## Where your answers live

On the device, in that browser, and nowhere else. No account, no sync, nothing
sent anywhere. Clearing site data clears the record — export it from Progress
first if you want to keep it.

## Sources

- Brysbaert, M., Mandera, P., McCormick, S. F., & Keuleers, E. (2019). *Word
  prevalence norms for 62,000 English lemmas.* Behavior Research Methods 51(2),
  467–479. — the difficulty of every word, and the calibration behind the number.
- Princeton University. *WordNet 3.0.* — definitions, parts of speech, synonyms.
- Literata (SIL Open Font License), self-hosted.
