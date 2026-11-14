export type WebhookMessage = Record<string, unknown> & {
	User: string;
	Repo: string;
	RepoHtmlUrl: string;
};

export type ParsedWebhook =
	| { action: "enqueue"; message: WebhookMessage }
	| { action: "skip" }
	| { action: "reject"; detail: string };

/** Parse a webhook request. Only consolidated-repo pushes and creates are enqueued. */
export async function parseWebhook(request: Request): Promise<ParsedWebhook> {
	let message: Record<string, unknown>;
	try {
		message = await request.json();
	} catch {
		return { action: "reject", detail: "Invalid JSON" };
	}
	if (!message || typeof message !== "object" || Array.isArray(message)) {
		return { action: "reject", detail: "Expected a JSON object" };
	}

	const topics = Array.isArray(message.Topics) ? message.Topics : [];
	if (!topics.includes("consolidated") || !["push", "create"].includes(message.EventType as string)) {
		console.log(
			`Skipping message - 'consolidated' not in Topics or invalid EventType: ` +
			`Topics=${JSON.stringify(message.Topics ?? [])}, EventType=${message.EventType}`,
		);
		return { action: "skip" };
	}
	if (!message.User || !message.Repo || !message.RepoHtmlUrl) {
		return { action: "reject", detail: "User, Repo and RepoHtmlUrl are required" };
	}
	return { action: "enqueue", message: message as WebhookMessage };
}
