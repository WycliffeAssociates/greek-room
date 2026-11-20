---
name: verify-pipeline
description: Drive the Greek Room alignment pipeline locally and prove it works end to end. Covers the Python job runner (pipeline-worker/webhook.py in its Docker image) and the Cloudflare Worker + Durable Object job queue (pipeline-worker-container under wrangler dev), with reports written to a disposable local S3 mock instead of R2. Use after changing pipeline-worker/, pipeline-worker-container/, utilities/ (ualign, api_utils, prep), greekroom/ checks, or smart_edit_distance/, or whenever you need evidence that a job runs and uploads its reports.
---

# Verify the alignment pipeline

The pipeline takes a WACS repo (`User`, `Repo`, `RepoHtmlUrl`, `DefaultBranch`), clones it, runs the Wildebeest character analysis, the duplicate (repeated-words) check and the alignment (prep → fast_align → ualign), and uploads the reports to the `greekroom-results` bucket under `User/Repo/`. There are two layers to drive:

| Layer | What it is | Drive it when you changed |
|---|---|---|
| **runner** | `pipeline-worker/webhook.py` (FastAPI) in the `pipeline-worker/Dockerfile` image. `POST /jobs`, `GET /jobs/{id}`, `GET /health`. | Python: `pipeline-worker/`, `utilities/`, `greekroom/`, `smart_edit_distance/`, the Dockerfile |
| **worker** | `pipeline-worker-container` Worker under `wrangler dev`. The Durable Object queues jobs in SQLite, dispatches them to a locally run copy of the same image, and polls every 60 s. Token-protected `GET/POST /jobs`, `POST /jobs/retry`, plus `GET /health`. | TypeScript in `pipeline-worker-container/src/`, `wrangler.jsonc`, or anything about dispatch, polling, retry and status |

A Python change that affects how jobs finish or fail (exit codes, `failed` status, errors) needs both layers: the runner proves the job, and the worker proves the Durable Object reads its status correctly.

Everything goes through one helper. Run it from the repo root:

```bash
S=pipeline-worker/e2e/verify.sh
export VERIFY_RUN_ID=my-change      # one id per verification run; isolates ports, names and state
$S                                  # prints usage
```

Requirements: the repo venv at `.virtual` (host-side Python for the helper and the test; `VERIFY_PYTHON` overrides it), Docker running, `git` on the host (to stage the fixture repos), `node`/`npx` with `pipeline-worker-container/node_modules` installed (`pnpm install` there if missing), and network access to `content.bibletranslationtools.org` (clones and the source-text archive). No 1Password, R2 or Cloudflare credentials are needed. The S3 mock accepts any key.

## Launch

```bash
$S build          # docker build of pipeline-worker/Dockerfile from the current checkout (~15 s cached; first build is minutes). Prints the rev, with -dirty if uncommitted.
$S storage-up     # adobe/s3mock with bucket greekroom-results; prints "storage up: http://127.0.0.1:<port>"
$S runner-up      # runner container; ready when it prints "runner up: http://127.0.0.1:<port>"
$S worker-up      # wrangler dev; ready when it prints "worker up: ..." (log line "Ready on")
```

- Rebuild (`$S build`, then `$S down` and bring everything up again) after every Python change. The runner runs the image, not your working tree.
- `worker-up` makes wrangler build its own image from the current checkout (tagged `cloudflare-dev/pipelineworkercontainer:*`), so it always runs current code. The first `/health` or job after `worker-up` cold-starts that container (a few seconds once the image exists).
- Start only the layers you need. `storage-up` is required by both.

## Doctor

```bash
$S doctor
```

Read-only. Run it first, and again whenever anything looks off. A healthy report looks like this:

```
checkout: 4e43981
image:    4e43981 built ...          <- the runner image's rev; must equal checkout or you're testing stale code
storage:  ok  http://127.0.0.1:38203 (gr-verify-s3-<run>) bucket=True
runner:   ok  http://127.0.0.1:34931 (gr-verify-runner-<run>) endpoint=http://172.17.0.1:38203
worker:   wrangler pid N on http://127.0.0.1:55529; /health -> Pipeline worker container is running [200]
          /jobs auth -> 200 (want 200)
```

`endpoint=` must point at the run's own mock (`172.17.0.1:<storage port>`). If it shows anything else, stop: the runner would upload to a real bucket. The script never passes real R2 credentials. Doctor exits non-zero when a started layer is down.

## Drive

### Test repos

| Repo (submit args) | What it is | Layers | Time |
|---|---|---|---|
| `anonymouswalker es_ulb_test https://content.bibletranslationtools.org/anonymouswalker/es_ulb_test master` | **The project's test repo.** Real Spanish (`es-419`) Genesis + Exodus, ~400 KB USFM, `consolidated` topic, source `en_ulb` v12. Has real repeated words. | runner and worker | ~3 min each |
| `verify verify-fixture_3jn_text_ulb file:///fixtures/verify-fixture_3jn_text_ulb master` | Local fixture in `pipeline-worker/e2e/fixtures/`: made-up 3 John with planted findings (repeated words, a Cyrillic letter in a Latin word, a decomposed accent). Source `en_ulb`. | runner only | ~30 s |
| `verify verify-nosource_3jn_text_ulb file:///fixtures/verify-nosource_3jn_text_ulb master` | Same fixture with `source` removed from the manifest, generated by `runner-up`. | runner only | ~20 s |

Use `es_ulb_test` as the default for any change. Add the fixture when the change touches the Wildebeest or duplicate checks: `es_ulb_test` has no Wildebeest anomalies, so only the fixture proves those findings are detected. The `file:///fixtures/...` repos exist only inside the runner container, which `runner-up` mounts them into. The worker's `POST /jobs` requires an `https` URL, so fixtures can't go through it.

The worker reports a status change only on its 60 s check, so a worker job takes at least about a minute longer than on the runner.

```bash
R="anonymouswalker es_ulb_test https://content.bibletranslationtools.org/anonymouswalker/es_ulb_test master"
id=$($S submit runner $R)
$S wait runner "$id"                         # polls to done/failed; saves final status + container log
$S results anonymouswalker/es_ulb_test       # lists and downloads every uploaded object
$S report-text anonymouswalker/es_ulb_test duplicate-check-output.html   # report as one line of text, for grep

id=$($S submit worker $R)
$S status worker "$id"                       # one row from GET /jobs (status, attempts, last_error)
$S wait worker "$id"
$S results anonymouswalker/es_ulb_test
```

Runner and worker write the same `anonymouswalker/es_ulb_test/` keys, and `results` downloads into the same evidence folder. To keep both, rename `evidence/results/anonymouswalker/es_ulb_test` (and its `.listing.txt`) after the first `results`.

For raw HTTP against the worker (auth, retry, bad input), read the port and token from the run's state:

```bash
. /tmp/greekroom-verify/$VERIFY_RUN_ID/state.env
curl -s -H "Authorization: Bearer $JOBS_TOKEN" http://127.0.0.1:$WORKER_PORT/jobs
```

The feature map in [`features/`](features/README.md) has the recipe for each user-facing behavior. Read it before you claim a feature works.

## Evidence

Everything goes to `/tmp/greekroom-verify/$VERIFY_RUN_ID/evidence/` and survives `down`:

- `<id>.request.json` / `worker-submit.request.json`: what was submitted. `<id>.submit.txt`: the HTTP response and status code.
- `<id>.final.json`: the terminal job status (worker rows include `attempts` and `last_error`).
- `<id>.runner.log` or `<id>.wrangler.log`: the container log or the wrangler (Worker + Durable Object + container) log.
- `results/<User>/<Repo>/...`: the downloaded reports, plus `<Repo>.listing.txt` with size, content type and key for each.
- `wrangler.log`: the full wrangler log, copied at `down`.

What counts as proof:

- **Drive the real path.** Use `POST /jobs` on the layer you changed. Don't call `run_greekroom_checks` or the TypeScript classes directly.
- **Show the side effect, not just `done`.** A `done` job proves nothing by itself. A good job uploads `wildebeest-results.html`, `duplicate-check-output.html`, `tgt-spellings.html` (text/html), `alignment.zip` plus one `alignments/<BOOK>.zip` per book (application/zip), and `alignments/index.json` (application/json). That's 7 objects for `es_ulb_test` (GEN, EXO) and 6 for the 3 John fixture. Then check the content against the recipes in [`features/`](features/README.md). The duplicate and Wildebeest reports have exact expected findings for each test repo.
- **Prove failures by their recorded reason.** `last_error` / `error` in the final status must name the cause (e.g. `job failed in the container: GitCommandError: ...`), and the log must agree.
- The S3 mock stands in for R2 at the boto3 boundary only. Everything up to the upload call is real, including clones and source downloads from WACS.

## Cleanup

```bash
$S down
```

This stops the wrangler dev session it started (the whole process session, by recorded leader pid), removes the `workerd-*greekroom-pipeline-worker-PipelineWorkerContainer*` containers that appeared after `worker-up`, and removes the `gr-verify-*-$VERIFY_RUN_ID` containers. It then deletes Durable Object state, env files and the token. Evidence stays. It never kills by process name and never touches containers it didn't start. Run `down` after every failed attempt too, then check `docker ps` for leftover `gr-verify-` or `workerd-` containers.

## End-to-end test

`pipeline-worker/e2e/test_e2e.py` runs the core recipes as one test: it brings a run up with this helper, sends `POST /jobs` for each case, waits for `done`, and asserts the exact object set, content types and report findings from `features/`. Python stdlib only.

```bash
.virtual/bin/python pipeline-worker/e2e/test_e2e.py                # all cases, about 4 min once images are built
E2E_CASES=runner_fixture_3jn,runner_nosource_3jn .virtual/bin/python pipeline-worker/e2e/test_e2e.py   # runner only, about 1 min
E2E_KEEP=1 .virtual/bin/python pipeline-worker/e2e/test_e2e.py     # leave the run up for debugging
```

- Cases: `worker_es_ulb_test` (worker, `es_ulb_test`), `runner_fixture_3jn` (runner, planted findings) and `runner_nosource_3jn` (runner, no source). A layer with no selected case isn't started.
- Each run uses its own `VERIFY_RUN_ID=e2e-<timestamp>` and runs `down` at the end, even after a failure. With `E2E_KEEP=1` it prints the `down` command instead. Evidence stays in `/tmp/greekroom-verify/e2e-<timestamp>/evidence/` either way.
- When a pinned finding changes on purpose, update the case's `markers` in `CASES` together with the feature file.
- It doesn't cover the job queue API or retry recipes. Drive those by hand.

## Isolation and gotchas

- Runs with different `VERIFY_RUN_ID`s don't collide: every port is picked fresh and every name carries the run id. Worker runs each get their own `--persist-to` state, but the worker container's image tag is shared (`max_instances: 1` per wrangler session is fine locally).
- Never `wrangler deploy` or `wrangler dev --remote` from this skill. The deployed Worker writes to production R2.
- `pipeline-worker/run-with-1password.sh` and `.env.op` run against real Service Bus and R2. Don't use them for verification.
- `wrangler dev` reaches the S3 mock through the docker0 gateway (`172.17.0.1`). If Docker uses a different bridge, the script reads the docker0 address. Doctor's `endpoint=` line shows what the containers got.
- The worker only reports `done`/`failed` on its 60 s check, so `wait worker` takes at least about a minute even for a fast job.
- A job whose repo `manifest.yaml` lists no `dublin_core.source` uploads only the Wildebeest and duplicate reports, and still finishes `done`. That's by design (`fetch_source_for_alignment` returns None), not a pass for alignment. The `verify-nosource_3jn_text_ulb` fixture covers it.
- Don't push to `anonymouswalker/es_ulb_test` as part of verification. Its expected findings in `features/` are pinned to its current content (commit `f665550`). If the repo changes, re-baseline those numbers from one run and say so.
- `minio/minio` is no longer pullable from Docker Hub. That's why the mock is `adobe/s3mock:3.12.0`.

## Helpers

- `pipeline-worker/e2e/fixtures/verify-fixture_3jn_text_ulb/`: the planted-findings repo (`manifest.yaml`, `65-3JN.usfm`). `runner-up` copies it into the run directory as two git repos (with and without source). Change the USFM only together with the expected findings in `features/duplicate-check.md` and `features/wildebeest-analysis.md`.
- `pipeline-worker/e2e/verify.sh`: the only helper (executable). Run it with no arguments for usage. State for a run lives in `/tmp/greekroom-verify/$VERIFY_RUN_ID/state.env`. `VERIFY_RUN_DIR` overrides the whole directory.
- `pipeline-worker/e2e/test_e2e.py`: the end-to-end test built on this helper. See [End-to-end test](#end-to-end-test).
