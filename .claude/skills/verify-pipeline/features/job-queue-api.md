# Job queue API

The Worker exposes token-protected routes for operators to list recent jobs and submit repos. Requests without the right bearer token are refused, malformed submissions are rejected with a reason, and repeated submissions for a repo that already has a pending job merge into that job.

## Sub-features

- `api-auth`: a missing or wrong token gets `401 Unauthorized`. With no `JOBS_TOKEN` secret configured, the routes return `404`.
- `api-list`: `GET /jobs` returns the 20 most recent jobs with status, attempts, timestamps and `last_error`, without payloads.
- `api-validate`: `POST /jobs` rejects a non-JSON body, missing fields, and a `RepoHtmlUrl` that doesn't end in `/<User>/<Repo>`.
- `api-merge`: a second submit for a repo with a pending job returns the same job id.
- `api-health`: `GET /health` (no token) answers 200 once the container is up.

## How to get to it (user POV)

- `curl -H "Authorization: Bearer <JOBS_TOKEN>" <worker>/jobs`, against `/jobs` (GET, POST) and `/jobs/retry` (POST).
- `curl <worker>/health`.

## Driving it with verify.sh

Preconditions:

- Baseline preconditions from the README, with `worker-up` done.
- Run `. /tmp/greekroom-verify/$VERIFY_RUN_ID/state.env; B=http://127.0.0.1:$WORKER_PORT; A="Authorization: Bearer $JOBS_TOKEN"`.

- **Health.** Run `curl -s -w ' [%{http_code}]' $B/health`. It returns `Pipeline worker container is running [200]`.
- **No token.** Run `curl -s -w ' [%{http_code}]' $B/jobs`. It returns `Unauthorized [401]`.
- **Wrong token.** Run `curl -s -w ' [%{http_code}]' -H 'Authorization: Bearer nope' $B/jobs`. It returns `Unauthorized [401]`.
- **Unknown route.** Run `curl -s -w ' [%{http_code}]' $B/nope`. It returns `Not found [404]`.
- **List.** Run `curl -s -H "$A" $B/jobs`. It returns a JSON array (`[]` on a fresh run). Each row has `id, repo_key, status, attempts, created_at, started_at, finished_at, last_error`.
- **Not JSON.** Run `curl -s -w ' [%{http_code}]' -H "$A" -d 'xx' $B/jobs`. It returns `Body must be JSON [400]`.
- **Missing fields.** Run `curl -s -w ' [%{http_code}]' -H "$A" -d '{"User":"a"}' $B/jobs`. It returns `User, Repo and RepoHtmlUrl are required strings; DefaultBranch is an optional string [400]`.
- **URL mismatch.** Run `curl -s -w ' [%{http_code}]' -H "$A" -d '{"User":"a","Repo":"b","RepoHtmlUrl":"https://content.bibletranslationtools.org/x/y"}' $B/jobs`. It returns `RepoHtmlUrl must be an https URL ending in /a/b [400]`, and `GET /jobs` shows no new row.
- **Merge.** While a job for repo R is `running`, submit R twice. The first submit creates a pending job with id P, and the second returns the same id P. `GET /jobs` shows one `running` and one `pending` row for R.

## Gotchas

- `api-merge` only merges into a pending job, not a running one. With nothing running, the first submit is dispatched within a second and becomes `running`, so the second submit creates a new pending job. Start a long job first, or submit three times and compare the second and third ids.
- `api-merge` hasn't been driven yet. Report it as unverified until a run captures it.
- `api-auth` 404-when-unset needs a `wrangler dev` without `JOBS_TOKEN`, which `worker-up` always sets. Treat it as unverified, or start wrangler by hand with an env file without the token and tear it down yourself.
- `/health` cold-starts the container. The first call after `worker-up` can take seconds, and minutes if wrangler has to build the image.
