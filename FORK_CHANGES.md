# Fork changes (WycliffeAssociates/greek-room)

This repo is a fork of [BibleNLP/greek-room](https://github.com/BibleNLP/greek-room) (`upstream`). Our work lives on `aw/dev`.

This file lists every change we made to files that upstream also owns, plus the decisions behind our own services. **Read it before merging upstream into `aw/dev`**, and check each item in [Changes to upstream files](#changes-to-upstream-files) after the merge. A merge that resolves a conflict as "take theirs" can silently undo a production fix.

Keep it current: when a PR touches an upstream file or makes a design decision, add an entry here in the same PR.

## Syncing with upstream

```sh
git fetch upstream
git checkout aw/dev
git log --oneline aw/dev..upstream/main          # what's new upstream
git diff aw/dev...upstream/main --stat           # files they touched
git merge upstream/main
```

After the merge:

1. For each file in the table below, check that every item marked **must keep** is still there (search for the snippet listed).
2. If upstream changed `utilities/ualign.py` or `greekroom/greekroom/owl/repeated_words.py`, run one alignment job and one repeated-words check locally before deploying.
3. If upstream merged one of our [upstream PRs](#fixes-sent-upstream), the conflict goes away. Mark it as merged below.

Last synced with upstream at merge base `e277571` (via `7cad361 merge from main`).

## Changes to upstream files

These are the files where our edits can be overwritten.

### `utilities/ualign.py` (alignment, runs in the pipeline container)

| Change | Why | Snippet to check | Source | Status |
|---|---|---|---|---|
| **Must keep.** Literal substring test in `SentenceAlignment.get_overlap_score` | Sub-words were used as regex patterns. A token containing `*` (e.g. `@*`) crashed ualign with `nothing to repeat at position 0` (repo `Tech_Advance/mxc-MZ-x-manika_reg`). | `if aligned_sub_word in lc_b_token:` | #6 (`16d7d97`) | Sent upstream as BibleNLP#100 (open) |
| **Must keep.** `.get((a, b), 0.0)` in `bi_stem_clustering` | Indexing the `defaultdict` stored a zero for every unaligned pair of word forms. Large repos (`now_reg`, `han_reg`) used 12.8 GiB and were killed in the 8 GiB container. With `.get` it peaks at 2.8 GiB. | `self.bi_weighted_counts.get((a, b), 0.0)` | #10 (`7f6c485`) | Not sent upstream |
| **Must keep.** `affix_morph_variant_check_dict = defaultdict(list)` and `if not d: return False` in `is_morph_variant` | ualign crashed when no affix morph data was loaded for the language. | `if not d:` | `dbc12ec` | Not sent upstream |

### `greekroom/greekroom/owl/repeated_words.py` (duplicate-word check, called by the pipeline and API)

| Change | Why | Snippet to check | Source | Status |
|---|---|---|---|---|
| **Must keep.** `process_repeated_words(...)` function; `main()` calls it | The pipeline and API import it as a library (`utilities/api_utils.py`). Losing it breaks the API and the pipeline's duplicate report. | `def process_repeated_words(` | `2e170db`, `c3f808c` | Not sent upstream |
| **Must keep.** Verse reference shown before each duplicate in the HTML report | Reviewers need the reference to find the verse. `repeated_word_dict` stores `(snt_id, marked_up_verse)` tuples. | `for snt_id_vref, marked_up_verse in` | `508ab6b`, `f78bde9` | Not sent upstream |
| Log the corpus size, not the whole corpus | A full Bible was written to stderr on one line and flooded the container logs. | `{len(check_corpus_list)} entries` | #3 (`507ad8a`) | Sent upstream as BibleNLP#99 (open) |

### `greekroom/greekroom/owl/data/legitimate_duplicates.jsonl`

| Change | Why | Snippet to check | Source |
|---|---|---|---|
| Vietnamese `đời đời` ("forever") marked as a legitimate duplicate | Stops it being flagged as a typo. | `"lang-code": "vi"` | `508ab6b` |

### Local-dev only (low risk)

These don't affect the deployed services. Losing them only affects running things locally.

| File | Change | Source |
|---|---|---|
| `utilities/parallel-corpus-prep.py` | Hard-coded `align_viz_root_dir`, `greek_room_data_root_dir` and `uroman_pl` point at a local machine instead of upstream's. | `dbc12ec` |
| `ephesus/ephesus/config.py` | Reads `.env.local` instead of `.env`. | `dc845f3` |
| `ephesus/ephesus/database/alembic/env.py` | `target_metadata = Base.metadata` so Alembic autogenerate works. | `dc845f3` |
| `ephesus/pyproject.toml` | Adds `[build-system]` and package discovery so Ephesus installs with pip. | `dc845f3` |
| `ephesus/docker-compose/*.env` | Local values. | `dc845f3` |
| `README.md` | Rewritten for this fork's setup. | `734677b` |
| `.gitignore` | Ignores `.virtual/`, `ephesus/.virtual/` and `pipeline-worker-container/node_modules/`. | `3ccd654` |

## Fork-only components

Upstream doesn't have these directories, so a merge won't conflict with them. They're listed here for the decisions behind them.

| Path | What it is |
|---|---|
| `api/`, `api-worker-container/` | FastAPI service (Wildebeest and repeated-words endpoints) and the Cloudflare Worker + container that host it. |
| `pipeline-worker/` | Python job runner: clone repo → Wildebeest → duplicate check → alignment → R2 uploads. |
| `pipeline-worker-container/` | Cloudflare Worker + Durable Object that queues jobs and runs `pipeline-worker` in a container. |
| `service-bus-cron-worker/` | Hourly Worker that reads the Service Bus subscription and queues jobs. |
| `utilities/api_utils.py`, `utilities/__init__.py` | Shared helpers for the API and pipeline. |

## PR log

PRs on `WycliffeAssociates/greek-room`, oldest first.

### #2 API and background service (merged 2026-03-13)

Added `api/`, `api-worker-container/`, `pipeline-worker/` and `pipeline-worker-container/`. Made `repeated_words.py` callable as a library (`process_repeated_words`).

Direct commits to `aw/dev` after #2:
- `f78bde9` Keep the verse reference in duplicate-check HTML.
- `cd78da5`, `1bc5da3` Complete Service Bus messages on success and renew the message lock (superseded by #3/#4).
- `d7a1834` Container instance type `standard-3`.

### #3 Queue webhook jobs in the container Durable Object (merged 2026-11-17)

Jobs take about 20 minutes, and `@cloudflare/containers` 0.0.28 renews the sleep timer only when a request starts, so jobs run inside an HTTP request were killed at 10 minutes.

Decisions:
- **No public `/webhook`.** Jobs are queued only through the `enqueue()` RPC on `PipelineWorker`, reachable by a service binding. Anyone with the workers.dev URL could otherwise overwrite another repo's reports.
- Jobs are stored in the Durable Object's SQLite and run one at a time. Repeated pushes to a repo merge into its pending job.
- `checkJobs` polls `GET /jobs/{id}` every 60 s. Timeout is 45 minutes.
- Hung jobs are killed with `destroy()` (SIGKILL), not `stop()`: on SIGTERM, Python waits for the non-daemon worker thread forever.
- `enqueue` doesn't await `dispatch()`, so callers don't wait out a cold start.
- A failed status check doesn't requeue the job (it may still be running; the timeout covers that case).
- `_run_job` also catches `SystemExit`, because `AlignmentPipeline` calls `sys.exit()`.
- Container sleeps after 5 minutes idle (scales to 0). Note: polling `GET /health` starts the container.

### #4 Service Bus cron Worker (merged 2026-11-17)

Added `service-bus-cron-worker/`, which runs hourly and forwards `consolidated` + `push|create` messages to `enqueue()`.

Decisions:
- Uses the Service Bus REST API with a SAS token, because the AMQP SDK needs raw TCP sockets that Workers don't have.
- Non-matching messages are acked, so they don't pile up in the subscription or dead-letter queue.
- Invalid or rejected messages stay locked, so they're redelivered and eventually dead-lettered.
- If the RPC throws, the run stops and the message is retried next hour.
- At most 300 messages per run.
- Deploy order: pipeline worker (#3) first, because the service binding points at it.

### #6 Fix two pipeline job failures (merged 2026-11-18)

- `pipeline-worker/utils.py`: a manifest with `source: []` (repo `rbnswartz/merged-abz`) now skips alignment with a warning instead of raising `IndexError`.
- `utilities/ualign.py`: the regex crash fix in the table above.

### #7 Token-protected routes to submit and retry jobs (merged 2026-11-19)

- `POST /jobs` queues a job for any repo. `RepoHtmlUrl` must be https and end in `/User/Repo`, so a typo can't write reports under another repo's name.
- `POST /jobs/retry` requeues the newest failed job per repo, skipping repos with a pending or running job.
- All `/jobs` routes return 404 until the `JOBS_TOKEN` secret is set. The token is compared in constant time.

### #8 Don't retry jobs that fail in the container (merged 2026-11-19)

A job that fails in the container fails the same way on retry (usually ualign running out of memory), and each retry held the queue for about 13 minutes.

Decisions:
- A job the container reports as `failed` is marked failed right away, with the container's error in `last_error`. Retry by hand with `POST /jobs/retry`.
- Still retried automatically (up to 3 attempts): failed dispatches, jobs lost by a container restart, timeouts, and a container that stopped mid-job.

### #10 Fix ualign running out of memory on large repos (merged 2026-11-19)

The `bi_stem_clustering` change in the table above.

### Direct commits since #10

- `4e43981` Upgrade `wrangler` to `^4.165.0` in `pipeline-worker-container/`.

## Fixes sent upstream

When upstream merges one of these, our copy and theirs match and the item no longer needs protecting. Update the status here and in the tables above.

| Upstream PR | Change | Status |
|---|---|---|
| [BibleNLP#99](https://github.com/BibleNLP/greek-room/pull/99) | Log check corpus size instead of the whole corpus (`repeated_words.py`) | Open |
| [BibleNLP#100](https://github.com/BibleNLP/greek-room/pull/100) | Literal substring test in ualign's overlap score | Open |

Candidates to send upstream next: the ualign memory fix (#10), the `is_morph_variant` guard, and the Vietnamese legitimate duplicate.
