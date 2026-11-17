import { SubscriptionClient, type ReceivedMessage } from "./serviceBus";

/**
 * Each message costs 3 subrequests (receive, forward, complete); this keeps a
 * run well inside the Workers subrequest limit. Anything left over is picked
 * up next hour.
 */
const MAX_MESSAGES_PER_RUN = 300;

type Env = {
	PIPELINE_WORKER: Fetcher;
	SERVICE_BUS_CONNECTION_STRING: string;
	TOPIC_NAME: string;
	SUBSCRIPTION_NAME: string;
};

type Outcome =
	| "accepted" // 202: the pipeline worker queued a job
	| "skipped" // not a consolidated push/create; acked without forwarding (or the webhook answered 200)
	| "rejected" // invalid JSON or 4xx: left for redelivery and then dead-lettering
	| "error"; // 5xx or unreachable: stop the run and retry next hour

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
	const body = message.body.replace(/^﻿/, "");
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

	const response = await env.PIPELINE_WORKER.fetch("https://pipeline-worker/webhook", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
	const detail = await response.text();
	if (response.status === 202) {
		return "accepted";
	}
	if (response.status === 200) {
		return "skipped";
	}
	console.error(`Webhook returned HTTP ${response.status} for message ${message.messageId}: ${detail}`);
	return response.status < 500 ? "rejected" : "error";
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
			// Ack once the webhook has taken the message, or when it was filtered out
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
