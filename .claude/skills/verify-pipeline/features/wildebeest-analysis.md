# Wildebeest analysis

Each job runs the Wildebeest character analysis over the repo's text (converted to verse-per-line form) and uploads `wildebeest-results.html`, rendered from `pipeline-worker/analysis.html`. The report gives an overview of the scripts and character groups in use, and flags characters that point to typing or encoding problems: letters from an unexpected script, non-canonical (non-NFC) character sequences, and character conflict sets. Each finding has counts and verse references.

## Sub-features

- `wb-overview`: the header names the repo (`Wildebeest Analysis Report for <User>/<Repo>`), with letter scripts, number scripts and other character groups, each with counts.
- `wb-foreign-script`: a letter from a second script is counted under `Letter scripts`, with examples.
- `wb-non-canonical`: decomposed sequences (e.g. `e` + U+0301) are counted under `Non-canonical character combinations`, and the combining mark is listed with its verse reference.
- `wb-char-details`: each character block lists every character with its code point, name, count and example references.
- `wb-mixed-token`: a word mixing scripts (e.g. Latin `chur` plus Cyrillic `с` plus `h`) is detected by Wildebeest, but **not rendered** in the report; see Gotchas.

## How to get to it (user POV)

- Submit a repo (see [Run checks](./run-checks.md)) and open `<User>/<Repo>/wildebeest-results.html` from the bucket.

## Driving it with verify.sh

Preconditions:

- Baseline preconditions from the README. `runner-up` for the fixture.

- **Clean real repo.** After an `es_ulb_test` job and `results`, run `$S report-text anonymouswalker/es_ulb_test wildebeest-results.html`. The text contains:
  - `Wildebeest Analysis Report for anonymouswalker/es_ulb_test`
  - `Letter scripts: 1 LATIN (283588 instances)`
  - `Number scripts: 1 ASCII_DIGIT (140 instances)`
  - `Non-canonical character combinations: 0`
  - `Character conflict sets: 0`
- **Planted findings.** After the `verify-fixture_3jn_text_ulb` runner job and `results`, run `$S report-text verify/verify-fixture_3jn_text_ulb wildebeest-results.html`. The text contains:
  - `Wildebeest Analysis Report for verify/verify-fixture_3jn_text_ulb`
  - `Letter scripts: 2 LATIN (780 instances) CYRILLIC (1 instances) examples: с`. That's the Cyrillic `с` planted in "church" in 3JN 1:9.
  - `Non-canonical character combinations: 1`. That's the decomposed `é` planted in "Démetrius" in 3JN 1:12.
  - `U+0301 COMBINING ACUTE ACCENT count: 1 example: ́ (3JN 1:12)`
  - `Character conflict sets: 0`

## Gotchas

- Unverified: a Wildebeest exception should fail the job with `RuntimeError: Wildebeest analysis failed: ...` as its `error` before anything is uploaded (per `utilities/api_utils.py`). No run has triggered it yet, so report it as unverified until one does.
- `es_ulb_test` has no Wildebeest anomalies, so it only proves the report renders. Detection is proven only by the fixture.
- **Mixed-script words aren't rendered.** Wildebeest's analysis has a `notable-token` section (`WORDS WITH CHARACTERS FROM MULTIPLE SCRIPTS (CYRILLIC, LATIN)` → `churсh`), but `pipeline-worker/analysis.html` doesn't render it, so the word itself never appears in the report. Found 2026-11-20. If the template starts rendering it, add `churсh` to the planted-findings assertions.
- The `File size: ... lines` figure counts the whole `vref.txt` verse grid (~41,899 lines), not the repo's verses. It's the same for every repo, so don't assert on it.
- `report-text` prints one long line, so search it with Python or `grep -o` and a short pattern. ugrep rejects long `.{0,N}` windows around multibyte text.
