# Extraction fixtures

Eleven real-shaped syllabi. Accuracy on this set is the regression gate for the
extractor: `npm run test:accuracy` scores every case and fails the build when
recall or precision drops below the floor declared in its `.expected.json`.

| # | Fixture | The messy case it covers |
|---|---------|--------------------------|
| 01 | `01-cs2110-table.txt` | Whitespace-aligned schedule table; a grading table that must not become items |
| 02 | `02-hist105-week-relative.txt` | Week-relative dates only — no calendar date appears anywhere |
| 03 | `03-math200-no-times.txt` | Dates with no times; every item must default to 23:59 *and say so* |
| 04 | `04-two-courses.txt` | Two courses in one document, both with a "Final Exam" |
| 05 | `05-canvas-paste.txt` | Raw Canvas copy/paste including LMS navigation chrome |
| 06 | `06-psych240-messy.txt` | "The class after fall break", "TBD" — dates that must stay null |
| 07 | `07-engl210-prose.txt` | Deadlines buried in prose, dates spelled as words |
| 08 | `08-nurs210-eu-dates.txt` | Day-first `DD/MM/YYYY` dates, declared in the document |
| 09 | `09-chem103-long.txt` | Long document that is mostly policy — a precision test |
| 10 | `10-arch350-table.pdf` | A **real PDF** whose table extracts as run-together columns |
| 11 | `11-canvas-screenshot.png` | A **real screenshot** — no text layer, vision path only |

## Running

```bash
RUN_ACCURACY_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... npm run test:accuracy
```

The suite is skipped by default because it makes real API calls and costs real
money. Everything else in `npm test` runs offline.

## Scoring

An extracted item matches an expected item when the course code and the
canonical title agree (`canonicalTitle` collapses "PS4" and "Problem Set 4").
A match with the wrong date is scored as a **miss, not a hit** — a plausible
wrong date is the failure this product exists to avoid.

Three gates, all of which must hold:

- **Recall** ≥ `minRecall` — did we find the work?
- **Precision** ≥ `minPrecision` — did we avoid inventing work? `allowedExtraTitles`
  lists items a case may legitimately produce beyond the expected set (recurring
  weekly homework, for instance) and they are excluded from the precision
  denominator rather than counted as errors.
- **No invented dates** — every item listed in `expectedDatelessItems` must come
  back with a null date. This gate is absolute and has no threshold.

`mustNotExtract` catches the classic false positives: office hours, grading
tables, LMS navigation, academic-integrity boilerplate.

## Regenerating the binary fixtures

`10-arch350-table.pdf` and `11-canvas-screenshot.png` are generated from the
HTML in `html/` and committed, so the suite needs no browser:

```bash
node tests/fixtures/generate.mjs   # needs Chromium; CHROME_PATH overrides
```
