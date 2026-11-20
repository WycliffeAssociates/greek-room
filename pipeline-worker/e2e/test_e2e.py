"""End-to-end test for the alignment pipeline: POST /jobs in, reports in storage out.

Each case submits a repo over HTTP to the runner (pipeline-worker/webhook.py) or
the Worker (pipeline-worker-container), waits for the job to finish, and reads the
bucket back through verify.sh. It passes only when the exact set of report
objects is there with the right content types and the reports contain the
findings measured in .claude/skills/verify-pipeline/features/.

Run from the repo root with `.virtual/bin/python pipeline-worker/e2e/test_e2e.py`,
or `../../.virtual/bin/python -m unittest` from this directory. Needs the repo
venv (`.virtual`), Docker, node with pipeline-worker-container/node_modules
installed, and network access to WACS. A full run takes about 4 minutes once the
images are built; the first build adds several more.

Env:
  E2E_CASES  comma list of case names to run (default: all). See CASES.
  E2E_KEEP   set to 1 to leave the run up for debugging instead of `verify.sh down`.
  VERIFY_PYTHON  run with another interpreter than the repo's .virtual (also used by verify.sh).
"""

import json
import os
import re
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

VERIFY = Path(__file__).resolve().parent / "verify.sh"
VENV = VERIFY.parents[2] / ".virtual"
if Path(sys.prefix).resolve() != VENV.resolve() and not os.environ.get("VERIFY_PYTHON"):
    raise SystemExit(
        f"test_e2e.py must run from the repo venv: {VENV}/bin/python {Path(__file__).resolve()}\n"
        f"(running {sys.executable}; set VERIFY_PYTHON to use another interpreter on purpose)"
    )
HTML, ZIP, JSON = "text/html", "application/zip", "application/json"


@dataclass(frozen=True)
class Case:
    name: str
    layer: str  # "worker" | "runner"
    user: str
    repo: str
    repo_url: str
    # Key under <user>/<repo>/ -> content type. The bucket must hold exactly these.
    objects: dict[str, str]
    # Report file -> substrings its visible text must contain, matched as whole words.
    markers: dict[str, list[str]]
    branch: str = "master"

    @property
    def books(self) -> list[str]:
        return [m[1] for k in self.objects if (m := re.fullmatch(r"alignments/(\w+)\.zip", k))]


CASES = [
    Case(
        name="worker_es_ulb_test",
        layer="worker",
        user="anonymouswalker",
        repo="es_ulb_test",
        repo_url="https://content.bibletranslationtools.org/anonymouswalker/es_ulb_test",
        objects={
            "alignment.zip": ZIP,
            "alignments/GEN.zip": ZIP,
            "alignments/EXO.zip": ZIP,
            "alignments/index.json": JSON,
            "duplicate-check-output.html": HTML,
            "tgt-spellings.html": HTML,
            "wildebeest-results.html": HTML,
        },
        markers={
            "duplicate-check-output.html": [
                "consecutive duplicates): 40 instances",
                "el el (8)",
                "él él (4)",
                "abraham abraham (3)",
            ],
            "wildebeest-results.html": [
                "Wildebeest Analysis Report for anonymouswalker/es_ulb_test",
                "Letter scripts: 1 LATIN (283588 instances)",
                "Non-canonical character combinations: 0",
                "Character conflict sets: 0",
            ],
        },
    ),
    Case(
        name="runner_fixture_3jn",
        layer="runner",
        user="verify",
        repo="verify-fixture_3jn_text_ulb",
        repo_url="file:///fixtures/verify-fixture_3jn_text_ulb",
        objects={
            "alignment.zip": ZIP,
            "alignments/3JN.zip": ZIP,
            "alignments/index.json": JSON,
            "duplicate-check-output.html": HTML,
            "tgt-spellings.html": HTML,
            "wildebeest-results.html": HTML,
        },
        markers={
            "duplicate-check-output.html": [
                "consecutive duplicates): 2 instances",
                "the the (1) [3JN 1:1] The elder writes to the the beloved friend",
                "truly truly (1) [3JN 1:2] Truly, truly , he prays",
            ],
            "wildebeest-results.html": [
                "Wildebeest Analysis Report for verify/verify-fixture_3jn_text_ulb",
                "Letter scripts: 2 LATIN (780 instances) CYRILLIC (1 instances)",
                "Non-canonical character combinations: 1",
                "U+0301 COMBINING ACUTE ACCENT count: 1",
                "Character conflict sets: 0",
            ],
        },
    ),
    Case(
        name="runner_nosource_3jn",
        layer="runner",
        user="verify",
        repo="verify-nosource_3jn_text_ulb",
        repo_url="file:///fixtures/verify-nosource_3jn_text_ulb",
        objects={
            "duplicate-check-output.html": HTML,
            "wildebeest-results.html": HTML,
        },
        markers={
            "duplicate-check-output.html": ["consecutive duplicates): 2 instances"],
            "wildebeest-results.html": [
                "Wildebeest Analysis Report for verify/verify-nosource_3jn_text_ulb"
            ],
        },
    ),
]

TIMEOUT_S = {"worker": 30 * 60, "runner": 10 * 60}
POLL_S = {"worker": 15, "runner": 5}


def selected_cases() -> list[Case]:
    names = [n.strip() for n in os.environ.get("E2E_CASES", "").split(",") if n.strip()]
    unknown = set(names) - {c.name for c in CASES}
    if unknown:
        raise SystemExit(f"E2E_CASES has unknown names {sorted(unknown)}; known: {[c.name for c in CASES]}")
    return [c for c in CASES if not names or c.name in names]


def http(method: str, url: str, body=None, token=None) -> tuple[int, object]:
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


class PipelineE2E(unittest.TestCase):
    run_id: str
    run_dir: Path
    state: dict[str, str]
    cases: list[Case]

    @classmethod
    def verify(cls, *args: str) -> str:
        env = {**os.environ, "VERIFY_RUN_ID": cls.run_id, "VERIFY_PYTHON": sys.executable}
        p = subprocess.run([str(VERIFY), *args], env=env, stdout=subprocess.PIPE, text=True)
        if p.returncode != 0:
            raise AssertionError(f"verify.sh {' '.join(args)} exited {p.returncode}:\n{p.stdout}")
        return p.stdout

    @classmethod
    def setUpClass(cls):
        cls.cases = selected_cases()
        cls.run_id = f"e2e-{time.strftime('%Y%m%d-%H%M%S')}"
        cls.run_dir = Path(os.environ.get("VERIFY_RUN_DIR") or f"/tmp/greekroom-verify/{cls.run_id}")
        print(f"\ne2e run {cls.run_id}: {', '.join(c.name for c in cls.cases)}", file=sys.stderr)
        cls.addClassCleanup(cls.teardown_run)
        cls.verify("build")
        cls.verify("storage-up")
        for layer in ("runner", "worker"):
            if any(c.layer == layer for c in cls.cases):
                cls.verify(f"{layer}-up")
        print(cls.verify("doctor"), file=sys.stderr)
        cls.state = {}
        for line in (cls.run_dir / "state.env").read_text().splitlines():
            key, _, value = line.partition("=")
            cls.state[key] = value

    @classmethod
    def teardown_run(cls):
        if os.environ.get("E2E_KEEP") == "1":
            print(f"\nE2E_KEEP=1: run left up. Tear down with: VERIFY_RUN_ID={cls.run_id} {VERIFY} down", file=sys.stderr)
            return
        cls.verify("down")

    def run_case(self, case: Case):
        if case not in self.cases:
            self.skipTest("not selected by E2E_CASES")
        status = self.submit_and_wait(case)
        self.assertEqual(status.get("status"), "done", f"{case.name}: job did not finish done: {status}")
        if case.layer == "worker":
            self.assertEqual(status.get("attempts"), 1, f"{case.name}: {status}")
            self.assertIsNone(status.get("last_error"), f"{case.name}: {status}")
        self.check_storage(case)

    def submit_and_wait(self, case: Case) -> dict:
        payload = {"User": case.user, "Repo": case.repo, "RepoHtmlUrl": case.repo_url, "DefaultBranch": case.branch}
        if case.layer == "worker":
            base, token = f"http://127.0.0.1:{self.state['WORKER_PORT']}", self.state["JOBS_TOKEN"]
            code, body = http("POST", f"{base}/jobs", payload, token)
            self.assertEqual(code, 202, f"{case.name}: worker POST /jobs: {body}")
            job_id = body["id"]
        else:
            base, token = f"http://127.0.0.1:{self.state['RUNNER_PORT']}", None
            job_id = f"{self.run_id}-{case.name}"
            code, body = http("POST", f"{base}/jobs", {"id": job_id, "payload": payload})
            self.assertEqual(code, 202, f"{case.name}: runner POST /jobs: {body}")

        deadline = time.monotonic() + TIMEOUT_S[case.layer]
        while True:
            if case.layer == "worker":
                code, rows = http("GET", f"{base}/jobs", token=token)
                self.assertEqual(code, 200, f"{case.name}: worker GET /jobs: {rows}")
                status = next((r for r in rows if r["id"] == job_id), {"status": "missing"})
            else:
                code, status = http("GET", f"{base}/jobs/{job_id}")
                self.assertEqual(code, 200, f"{case.name}: runner GET /jobs/{job_id}: {status}")
            if status.get("status") in ("done", "failed", "superseded"):
                return status
            if time.monotonic() > deadline:
                self.fail(f"{case.name}: job {job_id} not finished after {TIMEOUT_S[case.layer]} s: {status}")
            time.sleep(POLL_S[case.layer])

    def check_storage(self, case: Case):
        prefix = f"{case.user}/{case.repo}/"
        listing = {}
        for line in self.verify("results", prefix.rstrip("/")).splitlines():
            m = re.fullmatch(r"\s*\d+\s+(.+?)\s+(\S+)", line)
            if m and m[2].startswith(prefix):
                listing[m[2][len(prefix):]] = m[1]
        self.assertEqual(sorted(listing), sorted(case.objects), f"{case.name}: object keys under {prefix}")
        self.assertEqual(listing, case.objects, f"{case.name}: content types under {prefix}")

        results = self.run_dir / "evidence" / "results" / case.user / case.repo
        if case.books:
            index = json.loads((results / "alignments/index.json").read_text())
            self.assertEqual(index, {b: f"{prefix}alignments/{b}.zip" for b in case.books}, f"{case.name}: index.json")
            for book in case.books:
                names = zipfile.ZipFile(results / f"alignments/{book}.zip").namelist()
                pages = [n for n in names if re.fullmatch(rf"visualization/{book}-\d+\.html", n)]
                self.assertTrue(pages, f"{case.name}: alignments/{book}.zip has no visualization/{book}-NNN.html; has {names[:10]}")

        for report, markers in case.markers.items():
            text = self.verify("report-text", prefix.rstrip("/"), report)
            missing = [m for m in markers if not re.search(rf"(?<!\w){re.escape(m)}(?!\w)", text)]
            self.assertFalse(missing, f"{case.name}: {report} is missing {missing}; text in {results / report}.txt")


for _case in CASES:
    setattr(PipelineE2E, f"test_{_case.name}", lambda self, c=_case: self.run_case(c))


if __name__ == "__main__":
    unittest.main(verbosity=2)
