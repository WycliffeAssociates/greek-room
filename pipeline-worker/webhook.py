#!/usr/bin/env python3
"""
FastAPI job runner for the Greek Room pipeline container.

The PipelineWorkerContainer Durable Object owns the job queue. It sends
one job at a time to POST /jobs and polls GET /jobs/{id} until the job
is done or failed. Job state here is in memory only: if the container
restarts, unknown ids tell the Durable Object to dispatch the job again.
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import logging
import tempfile
from pathlib import Path
from typing import Any, Dict
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from git import Repo
from jinja2 import Environment, FileSystemLoader
from alignment_pipeline import AlignmentPipeline
from utils import extract_file_from_zip, split_alignment_zip_by_prefix, fetch_source_for_alignment
from utilities.api_utils import (
    run_duplicate_check,
    run_wildebeest_analysis,
    upload_to_blob_storage,
    DUPLICATE_CHECK_OUTPUT_FILENAME,
    WILDEBEEST_RESULTS_FILENAME,
    ALIGNMENT_RESULTS_FILENAME,
    TGT_SPELLINGS_FILENAME,
    INDEX_JSON,
)


R2_BUCKET_NAME = "greekroom-results"
R2_STORAGE_ENDPOINT = os.getenv("R2_STORAGE_ENDPOINT")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
BLOB_OUTPUT_PREFIX = os.getenv("BLOB_OUTPUT_PREFIX")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Greek Room Pipeline Job Runner",
    description="Runs Greek Room checks for jobs dispatched by the PipelineWorkerContainer Durable Object",
    version="1.1.0",
)

# One job at a time; the Durable Object also dispatches one at a time.
# The worker thread is not a daemon, so a SIGTERM (deploy, idle stop) lets
# the current job finish. The Durable Object uses SIGKILL for hung jobs.
executor = ThreadPoolExecutor(max_workers=1)
# job id -> "running" | "done" | "failed"
jobs: Dict[str, str] = {}


class JobRequest(BaseModel):
    id: str
    payload: Dict[str, Any]


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


@app.post("/jobs")
async def submit_job(job: JobRequest):
    """
    Start a job in the background and return immediately.

    A repeated dispatch of a job that is already running or done is a no-op,
    so the Durable Object can safely retry the request.
    """
    status = jobs.get(job.id)
    if status in ("running", "done"):
        return JSONResponse(status_code=200, content={"status": status})

    jobs[job.id] = "running"
    executor.submit(_run_job, job.id, job.payload)
    return JSONResponse(status_code=202, content={"status": "running"})


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Return the job's status, or "unknown" if this container never ran it."""
    return {"status": jobs.get(job_id, "unknown")}


def _run_job(job_id: str, payload: Dict[str, Any]) -> None:
    user = payload.get("User")
    repo = payload.get("Repo")
    logger.info(f"Starting job {job_id} for {user}/{repo}")
    try:
        with tempfile.TemporaryDirectory() as tempdir:
            run_greekroom_checks(payload, tempdir)
        jobs[job_id] = "done"
        logger.info(f"Finished job {job_id} for {user}/{repo}")
    # AlignmentPipeline calls sys.exit() on some errors, which raises
    # SystemExit (not an Exception) in this thread.
    except (Exception, SystemExit) as e:
        jobs[job_id] = "failed"
        logger.error(f"Job {job_id} for {user}/{repo} failed: {e}", exc_info=True)


def run_greekroom_checks(message: Dict[str, Any], tempdir: str):
    repo_html_url = message.get("RepoHtmlUrl")
    default_branch = message.get("DefaultBranch")
    user = message.get("User")
    repo = message.get("Repo")
    tempdir_path = Path(tempdir)

    repo_dir = tempdir_path / repo
    Repo.clone_from(repo_html_url, str(repo_dir))
    
    wildebeest_results, ref_id_dict = run_wildebeest_analysis(repo_dir)
    
    # Render HTML template
    template_dir = Path(__file__).parent
    env = Environment(loader=FileSystemLoader(str(template_dir)))
    template = env.get_template('analysis.html')
    
    html_content = template.render(
        wb_analysis_data=wildebeest_results,
        repo_name=f"{user}/{repo}",
        report_create_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        ref_id_dict=ref_id_dict
    )
    
    # Write HTML file instead of JSON
    wildebeest_result_path = tempdir_path / WILDEBEEST_RESULTS_FILENAME
    with open(wildebeest_result_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    logger.info(f"Wildebeest results saved to {wildebeest_result_path}")
    
    # Run duplicate check
    duplicate_result_path = tempdir_path / DUPLICATE_CHECK_OUTPUT_FILENAME
    run_duplicate_check(repo_dir, "", "", duplicate_result_path)
    logger.info(f"Duplicate results saved to {duplicate_result_path}")

    # Define object keys for R2 storage
    wildebeest_object_key = f"{user}/{repo}/{WILDEBEEST_RESULTS_FILENAME}"
    duplicate_object_key = f"{user}/{repo}/{DUPLICATE_CHECK_OUTPUT_FILENAME}"

    upload_to_blob_storage(
        wildebeest_result_path, 
        wildebeest_object_key,
        R2_BUCKET_NAME,
        R2_STORAGE_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY
    )
    upload_to_blob_storage(
        duplicate_result_path, 
        duplicate_object_key,
        R2_BUCKET_NAME,
        R2_STORAGE_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY
    )

    logger.info(f"Wildebeest result saved to: {wildebeest_object_key}")
    logger.info(f"Duplicate result saved to: {duplicate_object_key}")

    alignment_dir = tempdir_path / "alignment"
    os.makedirs(str(alignment_dir), exist_ok=True)
    source_repo_dir = fetch_source_for_alignment(repo_dir, tempdir_path / "source", default_branch)
    if source_repo_dir is None:
        logger.error(f"Failed to fetch source for alignment. Skipping alignment for {repo}")
        return

    alignment_output_path = run_alignment(source_repo_dir, repo_dir, str(alignment_dir))

    alignment_object_key = f"{user}/{repo}/{ALIGNMENT_RESULTS_FILENAME}"
    upload_to_blob_storage(
        alignment_output_path, 
        alignment_object_key,
        R2_BUCKET_NAME,
        R2_STORAGE_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        "application/zip"
    )

    # Upload splits of the large alignment zip
    index = {}
    zip_splits = split_alignment_zip_by_prefix(alignment_output_path, alignment_dir)
    for zip_split in zip_splits:
        upload_to_blob_storage(
            zip_split, 
            f"{user}/{repo}/alignments/{zip_split.stem}.zip",
            R2_BUCKET_NAME,
            R2_STORAGE_ENDPOINT,
            R2_ACCESS_KEY_ID,
            R2_SECRET_ACCESS_KEY,
            "application/zip"
        )
        index[zip_split.stem] = f"{user}/{repo}/alignments/{zip_split.stem}.zip"

    # upload index.json
    index_json_path = alignment_dir / INDEX_JSON
    with open(index_json_path, 'w') as f:
        json.dump(index, f)
    
    upload_to_blob_storage(
        index_json_path, 
        f"{user}/{repo}/alignments/{INDEX_JSON}",
        R2_BUCKET_NAME,
        R2_STORAGE_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        "application/json"
    )

    # upload spell-check result
    tgt_spelling_file = alignment_dir / TGT_SPELLINGS_FILENAME
    extract_file_from_zip(
        alignment_output_path, 
        TGT_SPELLINGS_FILENAME,
        tgt_spelling_file
    )

    upload_to_blob_storage(
        tgt_spelling_file, 
        f"{user}/{repo}/{TGT_SPELLINGS_FILENAME}",
        R2_BUCKET_NAME,
        R2_STORAGE_ENDPOINT,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        "text/html"
    )
    logger.info(f"Alignment result saved to {alignment_object_key}")


def run_alignment(source_repo_path: str, target_repo_path: str, temp_dir: str) -> Path:
    config = AlignmentPipeline.load_config_from_repos(source_repo_path, target_repo_path, temp_dir=temp_dir)
    pipeline = AlignmentPipeline(config=config, temp_dir=temp_dir)
    output = pipeline.run()
    logger.info(f"Alignment completed.")
    return output

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)

