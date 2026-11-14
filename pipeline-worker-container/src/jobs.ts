import type { WebhookMessage } from "./webhook";

/** A job that fails, is lost, or times out this many times is marked failed. */
const MAX_ATTEMPTS = 3;
/** Finished jobs are deleted after this long. */
const RETENTION_DAYS = 30;

// superseded: requeued while a newer job for the same repo was already pending
export type JobStatus = "pending" | "running" | "done" | "failed" | "superseded";

export type JobRow = {
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

export type JobSummary = Omit<JobRow, "payload">;

/**
 * The job queue, stored in the Durable Object's SQLite storage. Every method
 * is synchronous, so each one runs without interleaving with other requests.
 */
export class JobStore {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(`
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
		sql.exec(`
			CREATE TABLE IF NOT EXISTS queue_state (
				key TEXT PRIMARY KEY,
				value INTEGER NOT NULL
			)
		`);
	}

	/**
	 * Add a pending job for the message. Repeated pushes merge into the repo's
	 * pending job: the job clones the repo when it starts, so it picks up the
	 * latest push either way. The pending job may be a requeued one; the new
	 * push gets fresh attempts.
	 */
	enqueue(message: WebhookMessage): JobRow["id"] {
		const repoKey = `${message.User}/${message.Repo}`;
		const payload = JSON.stringify(message);

		const pending = this.pendingFor(repoKey);
		if (pending) {
			this.query(
				"UPDATE jobs SET payload = ?, attempts = 0, last_error = NULL WHERE id = ?",
				payload, pending.id,
			);
			console.log(`Enqueued job ${pending.id} for ${repoKey} (merged)`);
			return pending.id;
		}

		const id = crypto.randomUUID();
		this.query(
			"INSERT INTO jobs (id, repo_key, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
			id, repoKey, payload, Date.now(),
		);
		console.log(`Enqueued job ${id} for ${repoKey}`);
		return id;
	}

	running(): JobRow | undefined {
		return this.query<JobRow>("SELECT * FROM jobs WHERE status = 'running' LIMIT 1")[0];
	}

	/** Jobs with fewer attempts go first, so a retried job doesn't hold up other repos. */
	nextPending(): JobRow | undefined {
		return this.query<JobRow>(
			"SELECT * FROM jobs WHERE status = 'pending' ORDER BY attempts, created_at LIMIT 1",
		)[0];
	}

	hasActive(): boolean {
		return this.query("SELECT 1 FROM jobs WHERE status IN ('pending', 'running') LIMIT 1").length > 0;
	}

	recent(limit: number): JobSummary[] {
		return this.query<JobSummary>(
			`SELECT id, repo_key, status, attempts, created_at, started_at, finished_at, last_error
			 FROM jobs ORDER BY created_at DESC LIMIT ?`,
			limit,
		);
	}

	markRunning(job: JobRow): void {
		this.query(
			"UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?",
			Date.now(), job.id,
		);
		console.log(`Dispatched job ${job.id} for ${job.repo_key}, attempt ${job.attempts + 1}`);
	}

	/** Record why a dispatch failed; the job stays pending and is retried. */
	recordError(job: JobRow, error: string): void {
		this.query("UPDATE jobs SET last_error = ? WHERE id = ?", error, job.id);
		console.warn(`Job ${job.id} for ${job.repo_key}: ${error}`);
	}

	finish(job: JobRow, status: "done" | "failed" | "superseded", error?: string): void {
		this.query(
			"UPDATE jobs SET status = ?, finished_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?",
			status, Date.now(), error ?? null, job.id,
		);
	}

	/**
	 * Put a job back in the queue, or mark it failed after MAX_ATTEMPTS. If a
	 * newer job for the same repo is already pending, that job covers this one.
	 */
	requeue(job: JobRow, reason: string): void {
		const newer = this.pendingFor(job.repo_key, job.id);
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

	purgeFinished(): void {
		this.query(
			"DELETE FROM jobs WHERE status IN ('done', 'failed', 'superseded') AND finished_at < ?",
			Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
		);
	}

	/** When the scheduled checkJobs run is due, in unix seconds. */
	nextCheckAt(): number | undefined {
		return this.query<{ value: number }>(
			"SELECT value FROM queue_state WHERE key = 'next_check_at'",
		)[0]?.value;
	}

	setNextCheckAt(time: number): void {
		this.query("INSERT OR REPLACE INTO queue_state (key, value) VALUES ('next_check_at', ?)", time);
	}

	private pendingFor(repoKey: string, excludeId = ""): { id: string } | undefined {
		return this.query<{ id: string }>(
			"SELECT id FROM jobs WHERE repo_key = ? AND status = 'pending' AND id != ? LIMIT 1",
			repoKey, excludeId,
		)[0];
	}

	private query<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
		sql: string,
		...params: unknown[]
	): T[] {
		return this.sql.exec<T>(sql, ...params).toArray();
	}
}
