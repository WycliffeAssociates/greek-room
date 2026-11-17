import { getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { PipelineWorkerContainer } from "./container";
import { parseWebhook } from "./webhook";

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

/** Recent jobs for debugging. */
async function handleJobs(request: Request, container: ContainerStub, token: string): Promise<Response> {
	if (request.headers.get("Authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	return Response.json(await container.recentJobs(20));
}

/**
 * Worker entry point for pipeline-worker container.
 *
 * Jobs are queued only through the enqueue() RPC method, which other Workers
 * on this account reach through a service binding. There's no public HTTP
 * route for it, so nobody outside the account can queue jobs.
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

			// Only enabled when the JOBS_TOKEN secret is set
			const jobsToken = (this.env as any).JOBS_TOKEN as string | undefined;
			if (path === "/jobs" && request.method === "GET" && jobsToken) {
				return await handleJobs(request, container, jobsToken);
			}

			// Return 404 for unknown routes
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error("Container request failed", error);
			return new Response("Container error", { status: 500 });
		}
	}
}
