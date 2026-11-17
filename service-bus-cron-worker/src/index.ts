import { SubscriptionClient, type ReceivedMessage } from "./serviceBus";

/**
 * Each message costs up to 3 subrequests (receive, enqueue, complete); this keeps a
 * run well inside the Workers subrequest limit. Anything left over is picked
 * up next hour.
 */
const MAX_MESSAGES_PER_RUN = 300;

/** Mirrors EnqueueResult in pipeline-worker-container/src/index.ts. */
type EnqueueResult =
	| { status: "accepted"; id: string }
	| { status: "skipped" }
	| { status: "rejected"; detail: string };

/** The pipeline worker's RPC entrypoint, reached through the service binding. */
type PipelineWorker = {
	enqueue(message: Record<string, unknown>): Promise<EnqueueResult>;
};

type Env = {
	PIPELINE_WORKER: PipelineWorker;
	SERVICE_BUS_CONNECTION_STRING: string;
	TOPIC_NAME: string;
	SUBSCRIPTION_NAME: string;
};

type Outcome =
	| "accepted" // the pipeline worker queued a job
	| "skipped" // not a consolidated push/create; acked without forwarding
	| "rejected" // invalid JSON or rejected by the pipeline worker: left for redelivery and then dead-lettering
	| "error"; // the pipeline worker threw or is unreachable: stop the run and retry next hour

/**
 * Only consolidated-repo pushes and creates are forwarded; the same filter as
 * the pipeline worker's parseWebhook and the old Python Service Bus listener.
 */
function isConsolidatedPush(message: Record<string, unknown>): boolean {
	const topics = Array.isArray(message.Topics) ? message.Topics : [];
	return topics.includes("consolidated") && ["push", "create"].includes(message.EventType as string);
}

async function forward(env: Env, message: ReceivedMessage): Promise<Outcome> {
	// Strip a UTF-8 BOM, which JSON.parse rejects
	const body = message.body.replace(/^\uFEFF/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		console.error(`Message ${message.messageId} is not valid JSON`);
		return "rejected";
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		console.error(`Message ${message.messageId} is not a JSON object`);
		return "rejected";
	}
	if (!isConsolidatedPush(parsed as Record<string, unknown>)) {
		return "skipped";
	}

	const result = await env.PIPELINE_WORKER.enqueue(parsed as Record<string, unknown>);
	if (result.status === "rejected") {
		console.error(`Pipeline worker rejected message ${message.messageId}: ${result.detail}`);
	}
	return result.status;
}

async function drainSubscription(env: Env): Promise<void> {
	const client = await SubscriptionClient.create(
		env.SERVICE_BUS_CONNECTION_STRING,
		env.TOPIC_NAME,
		env.SUBSCRIPTION_NAME,
	);
	const counts: Record<Outcome, number> = { accepted: 0, skipped: 0, rejected: 0, error: 0 };
	const seen = new Set<number>();

	for (let i = 0; i < MAX_MESSAGES_PER_RUN; i++) {
		const message = await client.receive();
		if (!message) {
			break;
		}
		// A message left locked earlier in this run came back after its lock expired
		if (seen.has(message.sequenceNumber)) {
			break;
		}
		seen.add(message.sequenceNumber);

		let outcome: Outcome;
		try {
			outcome = await forward(env, message);
		} catch (error) {
			console.error(`Forwarding message ${message.messageId} failed`, error);
			outcome = "error";
		}
		counts[outcome]++;

		if (outcome === "accepted" || outcome === "skipped") {
			// Ack once the pipeline worker has queued the message, or when it was filtered out
			await client.complete(message);
		} else if (outcome === "error") {
			// The pipeline worker is down; the lock expires and the message is redelivered
			break;
		}
		// "rejected" stays locked and isn't seen again this run
	}

	console.log(
		`Service Bus run finished: ${counts.accepted} accepted, ${counts.skipped} skipped, ` +
		`${counts.rejected} rejected, ${counts.error} errors`,
	);
}

export default {
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await drainSubscription(env);
	},
} satisfies ExportedHandler<Env>;
