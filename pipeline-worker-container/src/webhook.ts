export type WebhookMessage = Record<string, unknown> & {
	User: string;
	Repo: string;
	RepoHtmlUrl: string;
};

export type ParsedWebhook =
	| { action: "enqueue"; message: WebhookMessage }
	| { action: "skip" }
	| { action: "reject"; detail: string };

/** Check a WACSEvent message. Only consolidated-repo pushes and creates are enqueued. */
export function parseWebhook(value: unknown): ParsedWebhook {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { action: "reject", detail: "Expected a JSON object" };
	}
	const message = value as Record<string, unknown>;

	const topics = Array.isArray(message.Topics) ? message.Topics : [];
	if (!topics.includes("consolidated") || !["push", "create"].includes(message.EventType as string)) {
		return { action: "skip" };
	}
	if (!message.User || !message.Repo || !message.RepoHtmlUrl) {
		return { action: "reject", detail: "User, Repo and RepoHtmlUrl are required" };
	}
	return { action: "enqueue", message: message as WebhookMessage };
}
