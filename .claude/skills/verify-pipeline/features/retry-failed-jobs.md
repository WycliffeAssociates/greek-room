# Failed jobs and retry

When a job crashes inside the container (bad repo, a check that exits non-zero, out of memory), the Durable Object marks it `failed` after one attempt, with the container's error as `last_error`, and does not retry it automatically. An operator re-runs failed jobs with `POST /jobs/retry`, either chosen ids or every failed job. A container that dies mid-job is different: the Durable Object requeues the job and runs it again, up to 3 attempts, before it marks the job `failed`.

## Sub-features

- `fail-record`: a job that fails in the container ends `failed` with `attempts: 1` and `last_error` starting `job failed in the container:`.
- `fail-no-auto-retry`: the failed job stays `failed` across later checks and isn't dispatched again.
- `retry-ids`: `POST /jobs/retry {"ids":[...]}` requeues those failed jobs and dispatches them.
- `retry-all`: `POST /jobs/retry` with no body requeues the newest failed job per repo.
- `retry-reject`: a malformed body gets 400, and an unknown id is reported in `skipped`.
- `retry-crash`: the container dies mid-job, so the job is requeued and attempt 2 runs it to `done`.
- `retry-cap`: the container dies on every attempt, so the job ends `failed` after 3 attempts and is never `done`.

## How to get to it (user POV)

- Read `GET /jobs` to find failed jobs and their `last_error`.
- `curl -X POST -H "Authorization: Bearer <JOBS_TOKEN>" <worker>/jobs/retry [-d '{"ids":["<id>"]}']`.

## Driving it with verify.sh

Preconditions:

- Baseline preconditions from the README, with `worker-up` done.
- `. /tmp/greekroom-verify/$VERIFY_RUN_ID/state.env; B=http://127.0.0.1:$WORKER_PORT; A="Authorization: Bearer $JOBS_TOKEN"`.

- **Failing submit.** Submit a repo that doesn't exist on WACS. Run `id=$($S submit worker verify-nobody no-such-repo-xyz https://content.bibletranslationtools.org/verify-nobody/no-such-repo-xyz master)`. The response is `[202]` with an id.
- **Recorded failure.** Run `$S wait worker "$id" 600`. It ends with `"status": "failed"`, `"attempts": 1`, and `last_error` starting `job failed in the container: GitCommandError: Cmd('git') failed due to: exit code(128)` and containing `repository '.../verify-nobody/no-such-repo-xyz/' not found`.
- **No auto-retry.** Wait one more 60 s check, then run `$S status worker "$id"`. It is still `failed` with `attempts: 1` and the same `finished_at`.
- **Bad retry body.** Run `curl -s -w ' [%{http_code}]' -H "$A" -d '{"ids":[]}' $B/jobs/retry`. It returns `Body must be {"ids": ["<job id>", ...]} [400]`.
- **Unknown id.** Run `curl -s -H "$A" -d '{"ids":["nope"]}' $B/jobs/retry`. It returns `{"retried":[],"skipped":[{"id":"nope","repo_key":null,"reason":"no failed job with this id"}]}`.
- **Retry by id.** Run `curl -s -H "$A" -d "{\"ids\":[\"$id\"]}" $B/jobs/retry`. It returns `{"retried":[{"id":"<id>","repo_key":"verify-nobody/no-such-repo-xyz"}],"skipped":[]}`. `$S status worker "$id"` then shows `running` with a new `started_at` and `last_error: null`.
- **Re-run result.** Run `$S wait worker "$id" 600`. It is `failed` again with a new `finished_at`, which proves the job really re-ran.

For `retry-crash` and `retry-cap`, submit `es_ulb_test` (see `../SKILL.md`) and crash its container with `$S fault kill-container`. That runs `docker kill` on the worker's running app container (never the `-proxy` sidecar, never a container from before `worker-up`) and prints its name. `test_e2e.py` drives both as `worker_crash_then_retry` and `worker_crash_every_attempt`.

- **Crash mid-job.** Run `$S status worker "$id"` until it shows `running` with `attempts: 1` and `started_at` at least 20 s ago, then run `$S fault kill-container`. It prints `workerd-...-PipelineWorkerContainer-<hash>`.
- **Requeued.** Within the next 60 s check, the row shows `running`, `attempts: 2`, `last_error: "container stopped while the job was running"`. Measured: the kills at 30, 90 and 151 s after submit were each followed by the next attempt starting on the following check, about 60 s apart.
- **Retry runs to done (`retry-crash`).** `$S wait worker "$id"` ends `done` with `attempts: 2`, and `last_error` still holds the crash reason. `$S results anonymouswalker/es_ulb_test` lists all 7 objects. Run `$S clear anonymouswalker/es_ulb_test` before the submit, or the listing can show an earlier job's uploads. Measured: `done` 255 s after submit, about 4 min.
- **Cap (`retry-cap`).** Kill again once each new attempt is 20 s in, on attempts 1, 2 and 3. The check after the third kill marks the job `failed`, `attempts: 3`, with the same `last_error`. Measured: `failed` 196 s after submit, about 3.5 min.

## Gotchas

- Retry resets `attempts` to 0, and dispatch makes it 1 again, so `attempts` alone doesn't show a retry. Compare `started_at` and `finished_at`.
- `retry-all` skips a repo that already has a pending or running job, and retries only the newest failed job per repo. The skip reason is `repo already has job <id>`.
- A dispatch the container rejects with a 4xx also ends `failed`, but with `last_error` starting `dispatch failed: HTTP 4xx`, not `job failed in the container`. That's a different path.
- A `done` job can carry a `last_error`: the reason from its last requeue stays after the retry succeeds. Read `status`, not `last_error`, for the outcome.
- Each retry starts the same `workerd-...` container again, so `fault kill-container` prints the same name every time. Between a kill and the next dispatch no app container is running, and `fault` exits non-zero.
- `docker restart` on the app container takes the same path as `docker kill` (it stops the container first) and records the same reason.
- Two other requeue reasons stay unverified. `container lost the job` needs the container to answer `unknown` for a running job, which a kill or restart from outside doesn't produce, and `timed out after 45 minutes` needs a job that hangs for 45 min. Report both as unverified.
