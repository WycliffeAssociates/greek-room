# Failed jobs and retry

When a job crashes inside the container (bad repo, a check that exits non-zero, out of memory), the Durable Object marks it `failed` after one attempt, with the container's error as `last_error`, and does not retry it automatically. An operator re-runs failed jobs with `POST /jobs/retry`, either chosen ids or every failed job.

## Sub-features

- `fail-record`: a job that fails in the container ends `failed` with `attempts: 1` and `last_error` starting `job failed in the container:`.
- `fail-no-auto-retry`: the failed job stays `failed` across later checks and isn't dispatched again.
- `retry-ids`: `POST /jobs/retry {"ids":[...]}` requeues those failed jobs and dispatches them.
- `retry-all`: `POST /jobs/retry` with no body requeues the newest failed job per repo.
- `retry-reject`: a malformed body gets 400, and an unknown id is reported in `skipped`.

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

## Gotchas

- Retry resets `attempts` to 0, and dispatch makes it 1 again, so `attempts` alone doesn't show a retry. Compare `started_at` and `finished_at`.
- `retry-all` skips a repo that already has a pending or running job, and retries only the newest failed job per repo. The skip reason is `repo already has job <id>`.
- A dispatch the container rejects with a 4xx also ends `failed`, but with `last_error` starting `dispatch failed: HTTP 4xx`, not `job failed in the container`. That's a different path.
- Jobs that time out (45 min) or are lost by a container restart are requeued up to 3 attempts, not marked failed at once. That can't be driven quickly with this harness. Report it as unverified.
