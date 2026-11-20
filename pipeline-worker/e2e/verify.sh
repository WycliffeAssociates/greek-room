#!/usr/bin/env bash
# Drive the Greek Room alignment pipeline locally for verification.
# See .claude/skills/verify-pipeline/SKILL.md for the workflow. Every instance this script starts is
# recorded in $RUN_DIR/state.env, and `down` removes only those.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${VERIFY_PYTHON:-$REPO_ROOT/.virtual/bin/python}"   # host Python; containers use their own
[ -x "$PY" ] || { echo "error: venv missing at $PY; create it from the repo root: python3 -m venv .virtual" >&2; exit 1; }
RUN_ID="${VERIFY_RUN_ID:-default}"
RUN_DIR="${VERIFY_RUN_DIR:-/tmp/greekroom-verify/$RUN_ID}"
EVIDENCE="$RUN_DIR/evidence"
STATE="$RUN_DIR/state.env"
IMAGE="greekroom-pipeline-verify:latest"
S3_IMAGE="adobe/s3mock:3.12.0"   # S3-compatible stand-in for R2; accepts any credentials
BUCKET="greekroom-results"           # hard-coded in pipeline-worker/webhook.py
S3_KEY="verify"
S3_SECRET="verify"
# Containers reach the host (and so the S3 mock) through the docker0 gateway.
DOCKER_HOST_IP="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
DOCKER_HOST_IP="${DOCKER_HOST_IP:-172.17.0.1}"

mkdir -p "$RUN_DIR" "$EVIDENCE"
touch "$STATE"
# shellcheck disable=SC1090
source "$STATE"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[verify $RUN_ID] $*" >&2; }
save() { # save KEY VALUE into state.env
  grep -v "^$1=" "$STATE" > "$STATE.tmp" || true
  echo "$1=$(printf %q "$2")" >> "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
  eval "$1=$(printf %q "$2")"
}
free_port() { "$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
wait_http() { # wait_http URL SECONDS
  local url=$1 deadline=$((SECONDS + $2))
  until curl -sf -o /dev/null "$url"; do
    [ $SECONDS -lt $deadline ] || return 1
    sleep 2
  done
}
s3py() { # run python with boto3 against the run's S3 mock (uses the pipeline image)
  [ -n "${S3_PORT:-}" ] || die "storage not up; run: $0 storage-up"
  docker run --rm --network host -v "$EVIDENCE:/evidence" \
    -e S3=http://127.0.0.1:$S3_PORT -e AK=$S3_KEY -e SK=$S3_SECRET -e BUCKET=$BUCKET \
    --entrypoint python "$IMAGE" -c "
import boto3, os, sys
s3 = boto3.client('s3', endpoint_url=os.environ['S3'], aws_access_key_id=os.environ['AK'], aws_secret_access_key=os.environ['SK'])
B = os.environ['BUCKET']
$1" "${@:2}"
}

cmd_build() {
  local rev; rev="$(git -C "$REPO_ROOT" rev-parse --short HEAD)$(git -C "$REPO_ROOT" diff --quiet HEAD || echo -dirty)"
  log "building $IMAGE from $REPO_ROOT at $rev"
  docker build -q -f "$REPO_ROOT/pipeline-worker/Dockerfile" --label "greekroom.verify.rev=$rev" -t "$IMAGE" "$REPO_ROOT" >/dev/null
  echo "$rev"
}

cmd_storage_up() {
  if [ -n "${S3_NAME:-}" ] && docker ps -q -f "name=^${S3_NAME}$" | grep -q .; then
    log "storage already up: $S3_NAME on port $S3_PORT"; return
  fi
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image missing; run: $0 build"
  save S3_NAME "gr-verify-s3-$RUN_ID"
  save S3_PORT "$(free_port)"
  docker run -d --name "$S3_NAME" --label greekroom.verify.run="$RUN_ID" \
    -p "127.0.0.1:$S3_PORT:9090" -p "$DOCKER_HOST_IP:$S3_PORT:9090" \
    -e initialBuckets="$BUCKET" "$S3_IMAGE" >/dev/null
  wait_http "http://127.0.0.1:$S3_PORT/" 90 || { docker logs "$S3_NAME" | tail -20; die "S3 mock did not come up"; }
  s3py "assert any(b['Name']==B for b in s3.list_buckets()['Buckets']); print('bucket', B, 'ready')"
  log "storage up: http://127.0.0.1:$S3_PORT (containers use http://$DOCKER_HOST_IP:$S3_PORT)"
}

storage_env() { # env flags pointing the pipeline at this run's S3 mock
  echo "R2_STORAGE_ENDPOINT=http://$DOCKER_HOST_IP:$S3_PORT"
  echo "R2_ACCESS_KEY_ID=$S3_KEY"
  echo "R2_SECRET_ACCESS_KEY=$S3_SECRET"
}

FIXTURE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/fixtures" && pwd)"
# Stage the fixture repo as local git repos the runner clones via file:///fixtures/<repo>:
#   verify-fixture_3jn_text_ulb   planted findings, manifest lists en_ulb as source (all 6 reports)
#   verify-nosource_3jn_text_ulb  same text, no dublin_core.source (alignment skipped, 2 reports)
stage_fixtures() {
  rm -rf "$RUN_DIR/fixtures"; mkdir -p "$RUN_DIR/fixtures"
  printf '[safe]\n\tdirectory = *\n' > "$RUN_DIR/fixtures.gitconfig"
  local src="$FIXTURE_SRC/verify-fixture_3jn_text_ulb" name dir
  for name in verify-fixture_3jn_text_ulb verify-nosource_3jn_text_ulb; do
    dir="$RUN_DIR/fixtures/$name"
    cp -r "$src" "$dir"
    if [ "$name" = verify-nosource_3jn_text_ulb ]; then
      "$PY" - "$dir/manifest.yaml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s2 = re.sub(r"\n    source:\n(?:        .*\n|            .*\n)+", "\n", s)
assert s2 != s, "could not strip source from fixture manifest"
open(p, "w").write(s2)
PY
    fi
    git -C "$dir" init -q -b master
    git -C "$dir" -c user.name=verify -c user.email=verify@localhost add -A
    git -C "$dir" -c user.name=verify -c user.email=verify@localhost commit -qm fixture
  done
}

cmd_runner_up() {
  [ -n "${S3_PORT:-}" ] || die "storage not up; run: $0 storage-up"
  if [ -n "${RUNNER_NAME:-}" ] && docker ps -q -f "name=^${RUNNER_NAME}$" | grep -q .; then
    log "runner already up on http://127.0.0.1:$RUNNER_PORT"; return
  fi
  save RUNNER_NAME "gr-verify-runner-$RUN_ID"
  save RUNNER_PORT "$(free_port)"
  storage_env > "$RUN_DIR/runner.env"
  stage_fixtures
  # The fixtures are owned by the host user, so let the container's git clone them.
  docker run -d --name "$RUNNER_NAME" --label greekroom.verify.run="$RUN_ID" \
    -p "127.0.0.1:$RUNNER_PORT:8080" --env-file "$RUN_DIR/runner.env" \
    -e CONTENT_SERVER_URL=https://content.bibletranslationtools.org/WA-Catalog \
    -v "$RUN_DIR/fixtures:/fixtures:ro" \
    -v "$RUN_DIR/fixtures.gitconfig:/verify/gitconfig:ro" -e GIT_CONFIG_GLOBAL=/verify/gitconfig \
    "$IMAGE" >/dev/null
  wait_http "http://127.0.0.1:$RUNNER_PORT/health" 120 || { docker logs "$RUNNER_NAME" | tail -20; die "runner not healthy"; }
  log "runner up: http://127.0.0.1:$RUNNER_PORT"
}

cmd_worker_up() {
  [ -n "${S3_PORT:-}" ] || die "storage not up; run: $0 storage-up"
  if [ -n "${WRANGLER_PID:-}" ] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    log "worker already up on http://127.0.0.1:$WORKER_PORT"; return
  fi
  save WORKER_PORT "$(free_port)"
  save INSPECTOR_PORT "$(free_port)"
  save JOBS_TOKEN "verify-$("$PY" -c 'import secrets;print(secrets.token_hex(12))')"
  { storage_env; echo "JOBS_TOKEN=$JOBS_TOKEN"; } > "$RUN_DIR/worker.env"
  # Containers that exist before launch are not ours; record them so `down` spares them.
  docker ps -aq --no-trunc | sort > "$RUN_DIR/containers.before"
  rm -f "$RUN_DIR/wrangler.pid"
  # setsid may fork, so $! is not reliable: the inner shell writes its own pid,
  # which is the new session's leader, then execs wrangler. `down` kills that session.
  # Redirect the whole background list: a subshell left holding the caller's stdout
  # would keep a pipe reader (e.g. test_e2e.py) waiting for EOF until wrangler exits.
  ({ cd "$REPO_ROOT/pipeline-worker-container" && \
    setsid bash -c 'echo $$ > "$0"; exec npx wrangler dev "$@"' "$RUN_DIR/wrangler.pid" \
      --ip 127.0.0.1 --port "$WORKER_PORT" --inspector-port "$INSPECTOR_PORT" \
      --persist-to "$RUN_DIR/wrangler-state" --env-file "$RUN_DIR/worker.env" \
      --show-interactive-dev-session=false; } > "$RUN_DIR/wrangler.log" 2>&1 < /dev/null &)
  for _ in $(seq 20); do [ -s "$RUN_DIR/wrangler.pid" ] && break; sleep 0.5; done
  save WRANGLER_PID "$(cat "$RUN_DIR/wrangler.pid")"
  local deadline=$((SECONDS + 900))
  until grep -q "Ready on" "$RUN_DIR/wrangler.log"; do
    kill -0 "$WRANGLER_PID" 2>/dev/null || { tail -30 "$RUN_DIR/wrangler.log"; die "wrangler dev exited"; }
    [ $SECONDS -lt $deadline ] || die "wrangler dev not ready after 15 min; see $RUN_DIR/wrangler.log"
    sleep 3
  done
  log "worker up: http://127.0.0.1:$WORKER_PORT (log: $RUN_DIR/wrangler.log)"
}

record_worker_containers() { # containers created since worker-up are this run's
  [ -f "$RUN_DIR/containers.before" ] || return 0
  # New since launch AND named by wrangler for this Worker's container class.
  docker ps -aq --no-trunc -f name=workerd-.*greekroom-pipeline-worker-PipelineWorkerContainer | sort \
    | comm -13 "$RUN_DIR/containers.before" - > "$RUN_DIR/containers.worker" || true
}

cmd_doctor() {
  local ok=0
  echo "run:      $RUN_ID ($RUN_DIR)"
  echo "checkout: $(git -C "$REPO_ROOT" rev-parse --short HEAD)$(git -C "$REPO_ROOT" diff --quiet HEAD || echo -dirty)"
  echo "image:    $(docker image inspect -f '{{index .Config.Labels "greekroom.verify.rev"}} built {{.Created}}' "$IMAGE" 2>/dev/null || echo MISSING)"
  if [ -n "${S3_PORT:-}" ] && curl -sf -o /dev/null "http://127.0.0.1:$S3_PORT/"; then
    echo "storage:  ok  http://127.0.0.1:$S3_PORT ($S3_NAME) bucket=$(s3py 'print(any(b["Name"]==B for b in s3.list_buckets()["Buckets"]))')"
  else echo "storage:  DOWN"; ok=1; fi
  if [ -n "${RUNNER_PORT:-}" ]; then
    if curl -sf "http://127.0.0.1:$RUNNER_PORT/health" >/dev/null; then
      echo "runner:   ok  http://127.0.0.1:$RUNNER_PORT ($RUNNER_NAME) endpoint=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$RUNNER_NAME" | grep ^R2_STORAGE_ENDPOINT= | cut -d= -f2)"
    else echo "runner:   DOWN"; ok=1; fi
  else echo "runner:   not started"; fi
  if [ -n "${WRANGLER_PID:-}" ]; then
    if kill -0 "$WRANGLER_PID" 2>/dev/null; then
      # /health cold-starts the container, so allow a long timeout.
      echo "worker:   wrangler pid $WRANGLER_PID on http://127.0.0.1:$WORKER_PORT; /health -> $(curl -s -m 600 -w ' [%{http_code}]' "http://127.0.0.1:$WORKER_PORT/health")"
      echo "          /jobs auth -> $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JOBS_TOKEN" "http://127.0.0.1:$WORKER_PORT/jobs") (want 200)"
    else echo "worker:   DEAD (pid $WRANGLER_PID gone)"; ok=1; fi
  else echo "worker:   not started"; fi
  return $ok
}

job_payload() { # job_payload USER REPO URL [BRANCH]
  "$PY" -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"User":a[0],"Repo":a[1],"RepoHtmlUrl":a[2],"DefaultBranch":(a[3] if len(a)>3 else "master")}))' "$@"
}

cmd_submit() { # submit runner|worker USER REPO URL [BRANCH]
  local target=$1; shift
  local payload; payload="$(job_payload "$@")"
  case $target in
    runner)
      local id="verify-$(date +%s)"
      local body; body="$("$PY" -c 'import json,sys;print(json.dumps({"id":sys.argv[1],"payload":json.loads(sys.argv[2])}))' "$id" "$payload")"
      echo "$body" > "$EVIDENCE/$id.request.json"
      curl -s -w '\n[%{http_code}]\n' -X POST -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:$RUNNER_PORT/jobs" | tee "$EVIDENCE/$id.submit.txt" >&2
      echo "$id" ;;
    worker)
      echo "$payload" > "$EVIDENCE/worker-submit.request.json"
      local out; out="$(curl -s -w '\n[%{http_code}]' -X POST -H "Authorization: Bearer $JOBS_TOKEN" -H 'Content-Type: application/json' -d "$payload" "http://127.0.0.1:$WORKER_PORT/jobs")"
      echo "$out" >&2
      local id; id="$(echo "$out" | head -1 | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
      echo "$out" > "$EVIDENCE/$id.submit.txt"
      echo "$id" ;;
    *) die "submit target must be runner or worker" ;;
  esac
}

job_status() { # job_status runner|worker ID -> prints JSON for that job
  case $1 in
    runner) curl -s "http://127.0.0.1:$RUNNER_PORT/jobs/$2" ;;
    worker) curl -s -H "Authorization: Bearer $JOBS_TOKEN" "http://127.0.0.1:$WORKER_PORT/jobs" \
      | "$PY" -c 'import json,sys; j=[x for x in json.load(sys.stdin) if x["id"]==sys.argv[1]]; print(json.dumps(j[0] if j else {"status":"missing"}))' "$2" ;;
  esac
}

cmd_status() { job_status "$1" "$2"; echo; }

cmd_wait() { # wait runner|worker ID [TIMEOUT_S]
  local deadline=$((SECONDS + ${3:-1800})) s
  while :; do
    s="$(job_status "$1" "$2")"
    case "$(echo "$s" | "$PY" -c 'import json,sys;print(json.load(sys.stdin).get("status"))')" in
      done|failed|superseded) echo "$s" | tee "$EVIDENCE/$2.final.json"; break ;;
    esac
    [ $SECONDS -lt $deadline ] || { echo "$s"; die "job $2 still not finished"; }
    sleep 15
  done
  [ "$1" = runner ] && docker logs "$RUNNER_NAME" > "$EVIDENCE/$2.runner.log" 2>&1 || true
  [ "$1" = worker ] && cp "$RUN_DIR/wrangler.log" "$EVIDENCE/$2.wrangler.log" || true
}

cmd_results() { # results USER/REPO -> list and download objects under that prefix
  local prefix=$1 dest="$EVIDENCE/results/$1"
  mkdir -p "$dest"
  s3py "
prefix, dest = sys.argv[1] + '/', sys.argv[2]
objs = s3.list_objects_v2(Bucket=B, Prefix=prefix).get('Contents', [])
for o in objs:
    rel = o['Key'][len(prefix):]
    path = os.path.join(dest, rel); os.makedirs(os.path.dirname(path), exist_ok=True)
    s3.download_file(B, o['Key'], path)
    ct = s3.head_object(Bucket=B, Key=o['Key'])['ContentType']
    print(f\"{o['Size']:>10}  {ct:<18} {o['Key']}\")
print(f'{len(objs)} objects')
" "$prefix" "/evidence/results/$prefix" | tee "$dest.listing.txt"
}

cmd_report_text() { # report-text USER/REPO FILE -> visible text of a downloaded HTML report, one line
  local f="$EVIDENCE/results/$1/$2"
  [ -f "$f" ] || die "$f not found; run: $0 results $1"
  "$PY" -c '
import html, re, sys
t = open(sys.argv[1], encoding="utf-8").read()
t = re.sub(r"<(style|script)\b.*?</\1>", " ", t, flags=re.S | re.I)
print(re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t))).strip())
' "$f" | tee "$f.txt"
}

cmd_down() {
  record_worker_containers
  if [ -n "${WRANGLER_PID:-}" ] && [ -n "$(ps -o pid= -s "$WRANGLER_PID" 2>/dev/null)" ]; then
    log "stopping wrangler dev (session $WRANGLER_PID)"
    kill -TERM -- "-$WRANGLER_PID" 2>/dev/null || true
    for _ in $(seq 20); do [ -n "$(ps -o pid= -s "$WRANGLER_PID")" ] || break; sleep 1; done
    kill -KILL -- "-$WRANGLER_PID" 2>/dev/null || true
    [ -z "$(ps -o pid= -s "$WRANGLER_PID")" ] || die "wrangler session $WRANGLER_PID still has processes"
  fi
  if [ -s "$RUN_DIR/containers.worker" ]; then
    log "removing containers wrangler dev started: $(wc -l < "$RUN_DIR/containers.worker")"
    xargs -r docker rm -f < "$RUN_DIR/containers.worker" >/dev/null 2>&1 || true
  fi
  local ours; ours="$(docker ps -aq -f "label=greekroom.verify.run=$RUN_ID")"
  [ -z "$ours" ] || { log "removing runner/storage containers"; docker rm -f $ours >/dev/null; }
  [ ! -f "$RUN_DIR/wrangler.log" ] || cp "$RUN_DIR/wrangler.log" "$EVIDENCE/wrangler.log"
  rm -rf "$RUN_DIR/wrangler-state" "$RUN_DIR/fixtures" "$RUN_DIR/fixtures.gitconfig" "$RUN_DIR"/*.env "$RUN_DIR"/containers.* "$RUN_DIR/wrangler.pid" "$RUN_DIR/wrangler.log"
  : > "$STATE"
  log "down. evidence kept in $EVIDENCE"
}

usage() {
  cat <<EOF
usage: $(basename "$0") <command> [args]   (env: VERIFY_RUN_ID, VERIFY_RUN_DIR)
  build                              build $IMAGE from the current checkout
  storage-up                         start a disposable S3 mock standing in for R2
  runner-up                          start the Python job runner container
  worker-up                          start the Worker + Durable Object with wrangler dev
  doctor                             read-only health report for this run
  submit runner|worker USER REPO URL [BRANCH]   submit a job; prints its id
  status runner|worker ID            one status check
  wait   runner|worker ID [TIMEOUT]  poll until done/failed; saves logs to evidence
  results USER/REPO                  list + download uploaded reports into evidence
  report-text USER/REPO FILE         print an HTML report's visible text (also saved as FILE.txt)
  down                               remove everything this run started (keeps evidence)
EOF
}

case "${1:-}" in
  build) cmd_build ;;
  storage-up) cmd_storage_up ;;
  runner-up) cmd_runner_up ;;
  worker-up) cmd_worker_up ;;
  doctor) cmd_doctor ;;
  submit) shift; cmd_submit "$@" ;;
  status) shift; cmd_status "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  results) shift; cmd_results "$@" ;;
  report-text) shift; cmd_report_text "$@" ;;
  down) cmd_down ;;
  *) usage; exit 2 ;;
esac
