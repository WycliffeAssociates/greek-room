# Run checks for a repo

Given a WACS repo, the pipeline clones it and runs the Wildebeest analysis, the repeated-words check and the alignment against the source text named in its `manifest.yaml`. It then uploads its reports under `<User>/<Repo>/` in the `greekroom-results` bucket and reports the job `done`.

## Sub-features

- `run-runner` runs a job sent straight to the Python job runner (`POST /jobs` with an id).
- `run-worker` runs a job queued through the Worker. The Durable Object dispatches and polls it to `done`.
- `run-reports` uploads every report with the right content type and real content: three HTML reports, `alignment.zip`, one `alignments/<BOOK>.zip` per book, and `alignments/index.json`.
- `run-no-source` handles a repo whose manifest lists no source: only the Wildebeest and repeated-words reports are uploaded, and the job is still `done`.
- `run-wacs-event` handles a WACSEvent push or create on a `consolidated` repo, which reaches the Worker's `enqueue()` RPC through the service-bus cron Worker.

## How to get to it (user POV)

- An operator submits a repo: `POST /jobs` on the Worker with `{"User","Repo","RepoHtmlUrl","DefaultBranch"?}` and the bearer token.
- A WACS push or create on a consolidated repo is forwarded by `service-bus-cron-worker` to the Worker's `enqueue()` RPC.
- The Durable Object (or a developer) sends `POST /jobs` `{"id","payload"}` to the Python runner directly.

## Driving it with verify.sh

Preconditions:

- Baseline preconditions from the README.
- `runner-up` for `run-runner`, `worker-up` for `run-worker`.

- **Set the repo.** Run `R="anonymouswalker es_ulb_test https://content.bibletranslationtools.org/anonymouswalker/es_ulb_test master"`.
- **Runner submit.** Run `id=$($S submit runner $R)`. stderr shows `{"status":"running"}` and `[202]`.
- **Runner finish.** Run `$S wait runner "$id"`. It prints `{"status":"done"}` in about 3 min. `<id>.runner.log` contains `Finished job <id> for anonymouswalker/es_ulb_test` and no `ERROR` or `Traceback`.
- **Worker submit.** Run `id=$($S submit worker $R)`. stderr shows `{"id":"<uuid>"}` and `[202]`. `$S status worker "$id"` shows `status: running, attempts: 1` within seconds.
- **Worker finish.** Run `$S wait worker "$id"`. It prints a row with `"status": "done"`, `"attempts": 1`, `"last_error": null` after about 3 min.
- **Reports.** Run `$S results anonymouswalker/es_ulb_test`. The listing has exactly these 7 objects:
  - `alignment.zip` (~11 MB): application/zip
  - `alignments/EXO.zip`, `alignments/GEN.zip`: application/zip
  - `alignments/index.json`: application/json
  - `duplicate-check-output.html`, `tgt-spellings.html` (~2 MB), `wildebeest-results.html`: text/html
- **Report content.** `alignments/index.json` is `{"GEN": "anonymouswalker/es_ulb_test/alignments/GEN.zip", "EXO": "anonymouswalker/es_ulb_test/alignments/EXO.zip"}`. Each book zip contains `visualization/<BOOK>-<NNN>.html` chapter pages. The duplicate and Wildebeest reports match [Duplicate check](./duplicate-check.md) and [Wildebeest analysis](./wildebeest-analysis.md).
- **No source.** Submit `verify verify-nosource_3jn_text_ulb file:///fixtures/verify-nosource_3jn_text_ulb master` to the runner and wait. It ends `done`, and `$S results verify/verify-nosource_3jn_text_ulb` lists exactly 2 objects (`duplicate-check-output.html`, `wildebeest-results.html`). The runner log has `No source listed in .../manifest.yaml` and `Skipping alignment for verify-nosource_3jn_text_ulb`.

## Gotchas

- `done` without the full set of objects isn't a pass. Always run `results`.
- `run-wacs-event` can't be driven by this harness: the `enqueue()` RPC is reached only through a service binding from `service-bus-cron-worker`, which reads a real Azure Service Bus. Report it as skipped. The HTTP `POST /jobs` path skips the WACSEvent `Topics`/`EventType` filter, so it doesn't stand in for this entry point.
- The runner keeps job state in memory. Restarting the runner container forgets ids, and `GET /jobs/<id>` then returns `{"status":"unknown"}`.
- Results for the same `<User>/<Repo>` overwrite each other in the bucket and in the evidence folder. When proving both layers in one run, rename the evidence folder after the first `results`.
- `RepoHtmlUrl` must end in `/<User>/<Repo>` for the worker route (see the job queue API). The runner doesn't check this.
