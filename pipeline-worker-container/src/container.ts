import { Container, type StopParams } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { JobStore, type JobRow, type JobSummary } from "./jobs";
import type { WebhookMessage } from "./webhook";

/** About 2x a normal run. Only catches hung jobs; live jobs are never cut short. */
const MAX_RUN_MINUTES = 45;
/** How often checkJobs polls the container while jobs are pending or running. */
const CHECK_INTERVAL_S = 60;
/** Dispatch can include a container cold start. */
const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 30 * 1000;

/**
 * Container class for the pipeline-worker background service.
 *
 * The Durable Object is the job queue: each webhook is stored as a job in its
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

	private readonly jobs: JobStore;

	/** Stops overlapping dispatch() calls from sending two jobs. */
	private dispatching = false;

	constructor(state: DurableObjectState<{}>, bindings: Env) {
		super(state, bindings);
		this.jobs = new JobStore(state.storage.sql);
	}

	/**
	 * Store a webhook message as a job and start it if nothing is running.
	 * Returns the job id.
	 */
	async enqueue(message: WebhookMessage): Promise<string> {
		const id = this.jobs.enqueue(message);
		await this.ensureChecker();
		// Don't make the webhook caller wait for a container cold start. If this
		// dispatch is lost, the next checkJobs picks the job up.
		this.ctx.waitUntil(this.dispatch());
		return id;
	}

	/** The most recent jobs, without payloads, for debugging. */
	async recentJobs(limit = 20): Promise<JobSummary[]> {
		return this.jobs.recent(limit);
	}

	/**
	 * Scheduled callback: runs every CHECK_INTERVAL_S while jobs are pending or
	 * running. Public because the library's alarm calls it by name.
	 */
	async checkJobs(): Promise<void> {
		try {
			const job = this.jobs.running();
			const killed = job ? await this.checkRunningJob(job) : false;
			// A killed container can still report running for a moment, so the
			// requeued job is dispatched on the next check.
			if (!killed) await this.dispatch();
			this.jobs.purgeFinished();
		} finally {
			// Reschedule even if a step threw: the library deletes this schedule
			// after the callback, so a missed reschedule would strand the queue.
			if (this.jobs.hasActive()) await this.ensureChecker();
		}
	}

	/**
	 * Keep the container while jobs are pending or running; the library renews
	 * the activity timer after this returns. Otherwise stop it (scale to 0).
	 */
	override async onActivityExpired(): Promise<void> {
		if (this.jobs.hasActive()) {
			await this.ensureChecker();
			return;
		}
		await super.onActivityExpired();
	}

	override onStop(params: StopParams): void {
		console.log("Container stopped", params);
	}

	/** Send the next pending job to the container if no job is running. */
	private async dispatch(): Promise<void> {
		if (this.dispatching) return;
		this.dispatching = true;
		try {
			if (this.jobs.running()) return;
			const job = this.jobs.nextPending();
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
					this.jobs.markRunning(job);
					return;
				}
				error = `dispatch failed: HTTP ${res.status} ${await res.text()}`;
				if (res.status >= 400 && res.status < 500) {
					// The container rejected the job itself; retrying won't help and
					// would block the queue.
					this.jobs.finish(job, "failed", error);
					console.error(`Job ${job.id} for ${job.repo_key} rejected: ${error}`);
					return;
				}
			} catch (e) {
				error = `dispatch failed: ${e}`;
			}
			// Leave the job pending; the next checkJobs retries it.
			this.jobs.recordError(job, error);
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
			this.jobs.requeue(job, "container stopped while the job was running");
			return false;
		}

		switch (await this.fetchJobStatus(job)) {
			case "done":
				this.jobs.finish(job, "done");
				console.log(`Job ${job.id} for ${job.repo_key} done`);
				return false;
			case "failed":
				this.jobs.requeue(job, "job failed in the container (see container logs)");
				return false;
			case "running":
				if (Date.now() - (job.started_at ?? 0) > MAX_RUN_MINUTES * 60 * 1000) {
					// SIGKILL: on SIGTERM the container waits for the hung job thread.
					await this.destroy();
					this.jobs.requeue(job, `timed out after ${MAX_RUN_MINUTES} minutes`);
					return true;
				}
				return false;
			default:
				// "unknown": the container restarted and lost its in-memory job state.
				this.jobs.requeue(job, "container lost the job");
				return false;
		}
	}

	/** The container's status for the job; "running" if the check fails. */
	private async fetchJobStatus(job: JobRow): Promise<string> {
		try {
			const res = await this.containerFetch(`http://container/jobs/${job.id}`, {
				signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return ((await res.json()) as { status: string }).status;
		} catch (e) {
			// Treat as transient; MAX_RUN_MINUTES still catches a container that
			// never answers.
			console.warn(`Job ${job.id}: status check failed: ${e}`);
			return "running";
		}
	}

	/** Schedule checkJobs unless a future run is already scheduled. */
	private async ensureChecker(): Promise<void> {
		// While checkJobs runs, its own due time has passed, so it can schedule
		// the next run; an enqueue during that run schedules it instead, and
		// checkJobs then sees a future time and doesn't add a second one.
		const next = this.jobs.nextCheckAt();
		if (next !== undefined && next > Date.now() / 1000) return;
		// The library runs the callback once `time` (unix seconds) has passed,
		// so store that exact value.
		const { time } = await this.schedule(CHECK_INTERVAL_S, "checkJobs");
		this.jobs.setNextCheckAt(time);
	}
}
