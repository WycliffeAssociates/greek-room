import { getContainer } from "@cloudflare/containers";
import type { PipelineWorkerContainer } from "./container";
import { parseWebhook } from "./webhook";

// Durable Object classes must be exported from the Worker's main module.
export { PipelineWorkerContainer } from "./container";

type ContainerStub = DurableObjectStub<PipelineWorkerContainer>;

/** Store webhook messages as jobs; the container runs them in the background. */
async function handleWebhook(request: Request, container: ContainerStub): Promise<Response> {
	const parsed = await parseWebhook(request);
	switch (parsed.action) {
		case "reject":
			return Response.json({ status: "error", detail: parsed.detail }, { status: 400 });
		case "skip":
			return Response.json({ status: "skipped" }, { status: 200 });
		case "enqueue": {
			const id = await container.enqueue(parsed.message);
			return Response.json({ status: "accepted", id }, { status: 202 });
		}
	}
}

async function handleHealth(container: ContainerStub): Promise<Response> {
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

/** Recent jobs for debugging. */
async function handleJobs(request: Request, container: ContainerStub, token: string): Promise<Response> {
	if (request.headers.get("Authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	return Response.json(await container.recentJobs(20));
}

/**
 * Worker entry point for pipeline-worker container.
 */
export default {

	async fetch(request: Request, env: Env): Promise<Response> {
		const container = getContainer(env.PIPELINE_WORKER_CONTAINER, "pipeline-worker");

		try {
			const path = new URL(request.url).pathname;

			if (path === "/webhook" && request.method === "POST") {
				return await handleWebhook(request, container);
			}

			if (path === "/health" && request.method === "GET") {
				return await handleHealth(container);
			}

			// Only enabled when the JOBS_TOKEN secret is set
			const jobsToken = (env as any).JOBS_TOKEN as string | undefined;
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
};
