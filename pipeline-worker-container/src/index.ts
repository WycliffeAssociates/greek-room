import { getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { PipelineWorkerContainer } from "./container";
import { parseJobRequest, parseWebhook } from "./webhook";

// Durable Object classes must be exported from the Worker's main module.
export { PipelineWorkerContainer } from "./container";

type ContainerStub = DurableObjectStub<PipelineWorkerContainer>;

export type EnqueueResult =
	| { status: "accepted"; id: string }
	| { status: "skipped" } // not a consolidated push/create
	| { status: "rejected"; detail: string };

async function handleHealth(container: ContainerStub): Promise<Response> {
	if (await container.healthCheck()) {
		return new Response("Pipeline worker container is running", {
			status: 200,
			headers: { "Content-Type": "text/plain" },
		});
	}
	return new Response("Container health check failed", { status: 503 });
}

/** Whether the request carries `Authorization: Bearer <token>`, compared in constant time. */
function isAuthorized(request: Request, token: string): boolean {
	const encoder = new TextEncoder();
	const given = encoder.encode(request.headers.get("Authorization") ?? "");
	const expected = encoder.encode(`Bearer ${token}`);
	return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

/** Recent jobs for debugging. */
async function handleJobs(container: ContainerStub): Promise<Response> {
	return Response.json(await container.recentJobs(20));
}

/** Queue a job for a repo: `{"User", "Repo", "RepoHtmlUrl", "DefaultBranch"?}`. */
async function handleSubmit(request: Request, container: ContainerStub): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response("Body must be JSON", { status: 400 });
	}
	const parsed = parseJobRequest(body);
	if ("error" in parsed) {
		return new Response(parsed.error, { status: 400 });
	}
	return Response.json({ id: await container.enqueue(parsed.message) }, { status: 202 });
}

/**
 * Requeue failed jobs. The body is optional: `{"ids": ["<job id>", ...]}`
 * retries those jobs; no body retries every failed job.
 */
async function handleRetry(request: Request, container: ContainerStub): Promise<Response> {
	let ids: string[] | undefined;
	const body = await request.text();
	if (body.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return new Response("Body must be JSON", { status: 400 });
		}
		const value = (parsed as { ids?: unknown })?.ids;
		if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === "string")) {
			return new Response('Body must be {"ids": ["<job id>", ...]}', { status: 400 });
		}
		ids = value;
	}
	return Response.json(await container.retryFailed(ids));
}

/**
 * Worker entry point for pipeline-worker container.
 *
 * WACSEvent jobs are queued through the enqueue() RPC method, which other
 * Workers on this account reach through a service binding. The HTTP /jobs
 * routes (list, submit, retry) need the JOBS_TOKEN secret, and are disabled
 * (404) until it is set.
 */
export default class PipelineWorker extends WorkerEntrypoint<Env> {
	private container() {
		const env: Env = this.env;
		return getContainer(env.PIPELINE_WORKER_CONTAINER, "pipeline-worker");
	}

	/** Store a WACSEvent message as a job; the container runs it in the background. */
	async enqueue(message: unknown): Promise<EnqueueResult> {
		const parsed = parseWebhook(message);
		switch (parsed.action) {
			case "reject":
				return { status: "rejected", detail: parsed.detail };
			case "skip":
				return { status: "skipped" };
			case "enqueue":
				return { status: "accepted", id: await this.container().enqueue(parsed.message) };
		}
	}

	async fetch(request: Request): Promise<Response> {
		const container = this.container();

		try {
			const path = new URL(request.url).pathname;

			if (path === "/health" && request.method === "GET") {
				return await handleHealth(container);
			}

			// The /jobs routes are only enabled when the JOBS_TOKEN secret is set
			const jobsToken = (this.env as any).JOBS_TOKEN as string | undefined;
			const jobsRoutes: Record<string, () => Promise<Response>> = {
				"GET /jobs": () => handleJobs(container),
				"POST /jobs": () => handleSubmit(request, container),
				"POST /jobs/retry": () => handleRetry(request, container),
			};
			const route = jobsRoutes[`${request.method} ${path}`];
			if (route && jobsToken) {
				if (!isAuthorized(request, jobsToken)) {
					return new Response("Unauthorized", { status: 401 });
				}
				return await route();
			}

			// Return 404 for unknown routes
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error("Container request failed", error);
			return new Response("Container error", { status: 500 });
		}
	}
}
