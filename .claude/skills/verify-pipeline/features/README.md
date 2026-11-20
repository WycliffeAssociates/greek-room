# Alignment pipeline verification map

This directory is the maintained source for verifying the user-facing behavior of the Greek Room alignment pipeline. Its "users" are operators and the WACS event flow that submit repos and read back reports. Read this index before driving anything, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the repo root with `S=.claude/skills/verify-pipeline/scripts/verify.sh` and a fresh `VERIFY_RUN_ID`.
- `$S build` was run after the last Python change, and `$S doctor` shows `image:` equal to `checkout:`.
- `$S storage-up` is done, and doctor shows `storage: ok ... bucket=True`.
- The layer the recipe names is up (`$S runner-up` or `$S worker-up`), and doctor reports it `ok` / `[200]`.
- For raw worker HTTP, run `. /tmp/greekroom-verify/$VERIFY_RUN_ID/state.env` to get `WORKER_PORT` and `JOBS_TOKEN`.
- Never drive the deployed Worker, `wrangler dev --remote`, or `run-with-1password.sh`. They write to production R2 and Service Bus.

## Driving conventions

- Submit through `$S submit` or `curl` against `/jobs`. Never call Python or TypeScript internals.
- Use the test repos in `../SKILL.md`. `anonymouswalker/es_ulb_test` is the default for both layers. The `verify-*` fixtures are runner only.
- Wait with `$S wait`, never a fixed sleep. Worker status changes only on the Durable Object's 60 s check.
- Run `$S down` at the end, including after failures.

## Proof and skip reporting

- A job proof has three parts: the submit response (`<id>.submit.txt`), the final status (`<id>.final.json`), and the uploaded objects (`$S results` listing plus the files).
- A failure proof shows the recorded `last_error`/`error` and the matching log lines.
- Record which layer (runner or worker) and which entry point each proof used.
- Report an entry point this harness can't reach as skipped, with the reason. Never count it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`. Keep implementation details out. Name only user paths, required state, commands and observable proof.

## Features

- [Run checks for a repo](./run-checks.md): submit a repo and get its reports (Wildebeest, duplicate check, alignment, spellings) in the bucket, with runner and worker entry points. Also covers a repo with no source.
- [Duplicate check](./duplicate-check.md): repeated words found and reported, with exact expected findings for `es_ulb_test` and the planted fixture.
- [Wildebeest analysis](./wildebeest-analysis.md): script and character report. A clean baseline from `es_ulb_test`, and planted foreign-script and non-canonical findings from the fixture.
- [Job queue API](./job-queue-api.md): the token-protected `/jobs` routes. Auth, input validation, listing and per-repo merging.
- [Failed jobs and retry](./retry-failed-jobs.md): a job that fails in the container is recorded with its reason, isn't retried automatically, and `POST /jobs/retry` re-runs it.
