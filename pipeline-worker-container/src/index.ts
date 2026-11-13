import { Container, getContainer, type StopParams } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

/** A job that fails, is lost, or times out this many times is marked failed. */
const MAX_ATTEMPTS = 3;
/** About 2x a normal run. Only catches hung jobs; live jobs are never cut short. */
const MAX_RUN_MINUTES = 45;
/** How often checkJobs polls the container while jobs are pending or running. */
const CHECK_INTERVAL_S = 60;
/** Finished jobs are deleted after this long. */
const RETENTION_DAYS = 30;
/** Dispatch can include a container cold start. */
const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 30 * 1000;

// superseded: requeued while a newer job for the same repo was already pending
type JobStatus = "pending" | "running" | "done" | "failed" | "superseded";

type JobRow = {
	id: string;
	repo_key: string; // "User/Repo"
	payload: string; // JSON webhook message
	status: JobStatus;
	attempts: number;
	created_at: number; // ms since epoch, like the other timestamps
	started_at: number | null;
	finished_at: number | null;
	last_error: string | null;
};

export type WebhookMessage = Record<string, unknown> & { User: string; Repo: string };

/**
 * Container class for the pipeline-worker background service.
 *
 * The Durable Object is the job queue: each webhook is stored as a row in its
 * SQLite storage, sent to the container one at a time, and polled until it
 * finishes. The container is kept awake only while jobs are pending or running.
 */
export class PipelineWorkerContainer extends Container<Env> {
	/**
	 * Health check endpoint runs on port 8080
	 */
	defaultPort = 8080;

	/** Stop the container 5 minutes after the last activity, once no jobs are left. */
	sleepAfter = "5m";

	envVars = {
		CONTENT_SERVER_URL: (env as any).CONTENT_SERVER_URL,
		SERVICE_BUS_CONNECTION_STRING: (env as any).SERVICE_BUS_CONNECTION_STRING,
		R2_STORAGE_ENDPOINT: (env as any).R2_STORAGE_ENDPOINT,
		R2_ACCESS_KEY_ID: (env as any).R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY: (env as any).R2_SECRET_ACCESS_KEY,
		BLOB_OUTPUT_PREFIX: (env as any).BLOB_OUTPUT_PREFIX,
	};

	/** Stops overlapping dispatch() calls from sending two jobs. */
	private dispatching = false;

	constructor(state: DurableObjectState<{}>, bindings: Env) {
		super(state, bindings);
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				repo_key TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				last_error TEXT
			)
		`);
		// next_check_at: when the scheduled checkJobs run is due (unix seconds)
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS queue_state (
				key TEXT PRIMARY KEY,
				value INTEGER NOT NULL
			)
		`);
	}

	/**
	 * Store a webhook message as a job and start it if nothing is running.
	 * Returns the job id.
	 */
	async enqueue(message: WebhookMessage): Promise<string> {
		const repoKey = `${message.User}/${message.Repo}`;
		const payload = JSON.stringify(message);

		// Merge repeated pushes into the repo's pending job. The job clones the
		// repo when it starts, so it picks up the latest push either way. The
		// pending job may be a requeued one; the new push gets fresh attempts.
		const [pending] = this.query<{ id: string }>(
			"SELECT id FROM jobs WHERE repo_key = ? AND status = 'pending' LIMIT 1",
			repoKey,
		);
		let id: string;
		if (pending) {
			id = pending.id;
			this.query(
				"UPDATE jobs SET payload = ?, attempts = 0, last_error = NULL WHERE id = ?",
				payload, id,
			);
		} else {
			id = crypto.randomUUID();
			this.query(
				"INSERT INTO jobs (id, repo_key, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
				id, repoKey, payload, Date.now(),
			);
		}
		console.log(`Enqueued job ${id} for ${repoKey}${pending ? " (merged)" : ""}`);

		await this.ensureChecker();
		// Don't make the webhook caller wait for a container cold start. If this
		// dispatch is lost, the next checkJobs picks the job up.
		this.ctx.waitUntil(this.dispatch());
		return id;
	}

	/** The most recent jobs, without payloads, for debugging. */
	async recentJobs(limit = 20): Promise<Omit<JobRow, "payload">[]> {
		return this.query<Omit<JobRow, "payload">>(
			`SELECT id, repo_key, status, attempts, created_at, started_at, finished_at, last_error
			 FROM jobs ORDER BY created_at DESC LIMIT ?`,
			limit,
		);
	}

	/**
	 * Scheduled callback: runs every CHECK_INTERVAL_S while jobs are pending or
	 * running. Public because the library's alarm calls it by name.
	 */
	async checkJobs(): Promise<void> {
		try {
			const [job] = this.query<JobRow>("SELECT * FROM jobs WHERE status = 'running' LIMIT 1");
			const killed = job ? await this.checkRunningJob(job) : false;
			// A killed container can still report running for a moment, so the
			// requeued job is dispatched on the next check.
			if (!killed) await this.dispatch();
			this.query(
				"DELETE FROM jobs WHERE status IN ('done', 'failed', 'superseded') AND finished_at < ?",
				Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
			);
		} finally {
			// Reschedule even if a step threw: the library deletes this schedule
			// after the callback, so a missed reschedule would strand the queue.
			if (this.hasActiveJobs()) await this.ensureChecker();
		}
	}

	/**
	 * Keep the container while jobs are pending or running; the library renews
	 * the activity timer after this returns. Otherwise stop it (scale to 0).
	 */
	override async onActivityExpired(): Promise<void> {
		if (this.hasActiveJobs()) {
			await this.ensureChecker();
			return;
		}
		await super.onActivityExpired();
	}

	override onStop(params: StopParams): void {
		console.log("Container stopped", params);
	}

	/**
	 * Send the next pending job to the container if no job is running. Jobs
	 * with fewer attempts go first, so a retried job doesn't hold up other repos.
	 */
	private async dispatch(): Promise<void> {
		if (this.dispatching) return;
		this.dispatching = true;
		try {
			if (this.query("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1").length) return;
			const [job] = this.query<JobRow>(
				"SELECT * FROM jobs WHERE status = 'pending' ORDER BY attempts, created_at LIMIT 1",
			);
			if (!job) return;

			let error: string;
			try {
				// Starts the container first if it isn't running.
				const res = await this.containerFetch("http://container/jobs", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: job.id, payload: JSON.parse(job.payload) }),
					signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
				});
				if (res.ok) {
					this.query(
						"UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?",
						Date.now(), job.id,
					);
					console.log(`Dispatched job ${job.id} for ${job.repo_key}, attempt ${job.attempts + 1}`);
					return;
				}
				error = `dispatch failed: HTTP ${res.status} ${await res.text()}`;
				if (res.status >= 400 && res.status < 500) {
					// The container rejected the job itself; retrying won't help and
					// would block the queue.
					this.finish(job, "failed", error);
					console.error(`Job ${job.id} for ${job.repo_key} rejected: ${error}`);
					return;
				}
			} catch (e) {
				error = `dispatch failed: ${e}`;
			}
			// Leave the job pending; the next checkJobs retries it.
			console.warn(`Job ${job.id} for ${job.repo_key}: ${error}`);
			this.query("UPDATE jobs SET last_error = ? WHERE id = ?", error, job.id);
		} catch (e) {
			console.error("dispatch error", e);
		} finally {
			this.dispatching = false;
		}
	}

	/**
	 * Ask the container about the running job and act on the answer.
	 * Returns true if it killed the container.
	 */
	private async checkRunningJob(job: JobRow): Promise<boolean> {
		if (!this.ctx.container?.running) {
			this.requeue(job, "container stopped while the job was running");
			return false;
		}

		let status: string;
		try {
			const res = await this.containerFetch(`http://container/jobs/${job.id}`, {
				signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			status = ((await res.json()) as { status: string }).status;
		} catch (e) {
			// Treat as transient; MAX_RUN_MINUTES still catches a container that
			// never answers.
			console.warn(`Job ${job.id}: status check failed: ${e}`);
			status = "running";
		}

		switch (status) {
			case "done":
				this.finish(job, "done");
				console.log(`Job ${job.id} for ${job.repo_key} done`);
				return false;
			case "failed":
				this.requeue(job, "job failed in the container (see container logs)");
				return false;
			case "running":
				if (Date.now() - (job.started_at ?? 0) > MAX_RUN_MINUTES * 60 * 1000) {
					// SIGKILL: on SIGTERM the container waits for the hung job thread.
					await this.destroy();
					this.requeue(job, `timed out after ${MAX_RUN_MINUTES} minutes`);
					return true;
				}
				return false;
			default:
				// "unknown": the container restarted and lost its in-memory job state.
				this.requeue(job, "container lost the job");
				return false;
		}
	}

	/**
	 * Put a job back in the queue, or mark it failed after MAX_ATTEMPTS. If a
	 * newer job for the same repo is already pending, that job covers this one.
	 */
	private requeue(job: JobRow, reason: string): void {
		const [newer] = this.query<{ id: string }>(
			"SELECT id FROM jobs WHERE repo_key = ? AND status = 'pending' AND id != ? LIMIT 1",
			job.repo_key, job.id,
		);
		if (newer) {
			this.finish(job, "superseded", `${reason}; superseded by job ${newer.id}`);
			console.warn(`Job ${job.id} for ${job.repo_key} superseded by ${newer.id}: ${reason}`);
		} else if (job.attempts >= MAX_ATTEMPTS) {
			this.finish(job, "failed", reason);
			console.error(`Job ${job.id} for ${job.repo_key} failed after ${job.attempts} attempts: ${reason}`);
		} else {
			this.query("UPDATE jobs SET status = 'pending', last_error = ? WHERE id = ?", reason, job.id);
			console.warn(`Job ${job.id} for ${job.repo_key} requeued after attempt ${job.attempts}: ${reason}`);
		}
	}

	private finish(job: JobRow, status: "done" | "failed" | "superseded", error?: string): void {
		this.query(
			"UPDATE jobs SET status = ?, finished_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?",
			status, Date.now(), error ?? null, job.id,
		);
	}

	/** Schedule checkJobs unless a future run is already scheduled. */
	private async ensureChecker(): Promise<void> {
		// While checkJobs runs, its own due time has passed, so it can schedule
		// the next run; an enqueue during that run schedules it instead, and
		// checkJobs then sees a future time and doesn't add a second one.
		const [next] = this.query<{ value: number }>(
			"SELECT value FROM queue_state WHERE key = 'next_check_at'",
		);
		if (next && next.value > Date.now() / 1000) return;
		// The library runs the callback once `time` (unix seconds) has passed,
		// so store that exact value.
		const { time } = await this.schedule(CHECK_INTERVAL_S, "checkJobs");
		this.query(
			"INSERT OR REPLACE INTO queue_state (key, value) VALUES ('next_check_at', ?)",
			time,
		);
	}

	private hasActiveJobs(): boolean {
		return this.query("SELECT 1 FROM jobs WHERE status IN ('pending', 'running') LIMIT 1").length > 0;
	}

	private query<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
		sql: string,
		...params: unknown[]
	): T[] {
		return this.ctx.storage.sql.exec<T>(sql, ...params).toArray();
	}
}

/** Only consolidated-repo pushes and creates are processed. */
function shouldProcess(message: Record<string, unknown>): boolean {
	const topics = Array.isArray(message.Topics) ? message.Topics : [];
	return topics.includes("consolidated") && ["push", "create"].includes(message.EventType as string);
}

/**
 * Worker entry point for pipeline-worker container.
 */
export default {

	async fetch(request: Request, env: Env): Promise<Response> {
		const container = getContainer(env.PIPELINE_WORKER_CONTAINER, "pipeline-worker");

		try {
			const url = new URL(request.url);
			const path = url.pathname;

			// Store webhook messages as jobs; the container runs them in the background
			if (path === "/webhook" && request.method === "POST") {
				let message: Record<string, unknown>;
				try {
					message = await request.json();
				} catch {
					return Response.json({ status: "error", detail: "Invalid JSON" }, { status: 400 });
				}
				if (!message || typeof message !== "object" || Array.isArray(message)) {
					return Response.json({ status: "error", detail: "Expected a JSON object" }, { status: 400 });
				}

				if (!shouldProcess(message)) {
					console.log(
						`Skipping message - 'consolidated' not in Topics or invalid EventType: ` +
						`Topics=${JSON.stringify(message.Topics ?? [])}, EventType=${message.EventType}`,
					);
					return Response.json({ status: "skipped" }, { status: 200 });
				}
				if (!message.User || !message.Repo || !message.RepoHtmlUrl) {
					return Response.json(
						{ status: "error", detail: "User, Repo and RepoHtmlUrl are required" },
						{ status: 400 },
					);
				}

				const id = await container.enqueue(message as WebhookMessage);
				return Response.json({ status: "accepted", id }, { status: 202 });
			}

			// Handle health check endpoint
			if (path === "/health" && request.method === "GET") {
				const healthResponse = await container.fetch(new Request("http://container/health"));

				if (healthResponse.ok) {
					return new Response("Pipeline worker container is running", {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					});
				} else {
					return new Response("Container health check failed", { status: 503 });
				}
			}

			// Recent jobs for debugging; only enabled when the JOBS_TOKEN secret is set
			const jobsToken = (env as any).JOBS_TOKEN as string | undefined;
			if (path === "/jobs" && request.method === "GET" && jobsToken) {
				if (request.headers.get("Authorization") !== `Bearer ${jobsToken}`) {
					return new Response("Unauthorized", { status: 401 });
				}
				return Response.json(await container.recentJobs(20));
			}

			// Return 404 for unknown routes
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error("Container request failed", error);
			return new Response("Container error", { status: 500 });
		}
	}
};
