# Duplicate check (repeated words)

Each job runs the Greek Room repeated-word check (`greekroom/owl/repeated_words.py`) over every verse in the repo and uploads `duplicate-check-output.html`. The report lists each consecutive repeated word ("el el"), how often it occurs, and every verse it occurs in, with the verse text.

## Sub-features

- `dup-detect`: consecutive repeated words are found, case-insensitively and across punctuation ("Truly, truly").
- `dup-report`: the report shows the total instance count, each repeated pair with its count, and the reference plus full verse text for each instance.
- `dup-clean`: a repo with no repeats still gets a report, showing `0 instance`.
- `dup-allowlist`: legitimate repeats in `owl/data/legitimate_duplicates.jsonl` (e.g. English "truly, truly") are not reported. **Currently not applied by the pipeline; see Gotchas.**

## How to get to it (user POV)

- Submit a repo (see [Run checks](./run-checks.md)) and open `<User>/<Repo>/duplicate-check-output.html` from the bucket.

## Driving it with verify.sh

Preconditions:

- Baseline preconditions from the README. `runner-up` for the fixture. `runner-up` or `worker-up` for `es_ulb_test`.

- **Real repo.** Submit and wait for `anonymouswalker es_ulb_test https://content.bibletranslationtools.org/anonymouswalker/es_ulb_test master`, then run `$S results anonymouswalker/es_ulb_test`.
- **Real repo findings.** Run `$S report-text anonymouswalker/es_ulb_test duplicate-check-output.html`. The text contains:
  - `Checking for repeated words (consecutive duplicates): 40 instances`.
  - 24 pairs. The first is `el el (8)`, whose first instance is `[EXO 5:3] ... sacrificar para el el SEÑOR nuestro Dios ...`. Next come `él él (4)` and `abraham abraham (3)`.
  - Pairs with 2 instances: `ellos ellos`, `jacob jacob`, `moisés moisés`, `señor señor`.
  - Pairs with 1 instance: `a a`, `de de`, `ella ella`, `esa esa`, `irad irad`, `josé josé`, `labán labán`, `lo lo`, `mehujael mehujael`, `metusael metusael`, `noé noé`, `padre padre`, `para para`, `potifar potifar`, `sem sem`, `taré taré`, `ustedes ustedes`.
- **Planted findings.** Submit `verify verify-fixture_3jn_text_ulb file:///fixtures/verify-fixture_3jn_text_ulb master` to the runner, wait, run `results`, then `$S report-text verify/verify-fixture_3jn_text_ulb duplicate-check-output.html`. The text contains `2 instances`, `the the (1) [3JN 1:1] The elder writes to the the beloved friend` and `truly truly (1) [3JN 1:2] Truly, truly , he prays`.
- **Same result on both layers.** When `es_ulb_test` ran through both runner and worker, the two `duplicate-check-output.html` files differ only in the generation timestamp in the header.

## Gotchas

- **The allowlist isn't applied.** The pipeline calls the check with an empty language code (`run_duplicate_check(repo_dir, "", "", ...)` in `pipeline-worker/webhook.py`). So `truly truly` in the fixture is reported even though `legitimate_duplicates.jsonl` exempts it for `eng`. That's current behavior, recorded as found on 2026-11-20. If a change passes the repo's language code, the fixture should drop to `1 instance` and `es_ulb_test` may drop too. Re-baseline both and say so.
- Real repeated names in genealogies (e.g. `abraham abraham` in "Abraham, Abraham" calls) are legitimately reported today. A drop in those counts after a change is a behavior change to explain, not an improvement to claim.
- The counts are pinned to `es_ulb_test` at commit `f665550`. Check `git ls-remote https://content.bibletranslationtools.org/anonymouswalker/es_ulb_test master` before treating a count change as a regression.
- The report has a generation timestamp. Compare findings, not bytes.
