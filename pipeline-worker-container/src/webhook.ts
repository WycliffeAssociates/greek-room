export type WebhookMessage = Record<string, unknown> & {
	User: string;
	Repo: string;
	RepoHtmlUrl: string;
};

export type ParsedWebhook =
	| { action: "enqueue"; message: WebhookMessage }
	| { action: "skip" }
	| { action: "reject"; detail: string };

/**
 * Check a manually submitted job: `{User, Repo, RepoHtmlUrl, DefaultBranch?}`.
 * Unlike parseWebhook there's no Topics/EventType filter. RepoHtmlUrl must end
 * in /User/Repo, so a typo can't write one repo's reports under another's name.
 */
export function parseJobRequest(value: unknown): { message: WebhookMessage } | { error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { error: "Expected a JSON object" };
	}
	const { User, Repo, RepoHtmlUrl, DefaultBranch = "master" } = value as Record<string, unknown>;
	if (![User, Repo, RepoHtmlUrl, DefaultBranch].every((v) => typeof v === "string" && v.trim() !== "")) {
		return { error: "User, Repo and RepoHtmlUrl are required strings; DefaultBranch is an optional string" };
	}
	let url: URL;
	try {
		url = new URL(RepoHtmlUrl as string);
	} catch {
		return { error: "RepoHtmlUrl must be a URL" };
	}
	const path = url.pathname.replace(/(\.git)?\/*$/, "");
	if (url.protocol !== "https:" || path !== `/${User}/${Repo}`) {
		return { error: `RepoHtmlUrl must be an https URL ending in /${User}/${Repo}` };
	}
	return {
		message: {
			User: User as string,
			Repo: Repo as string,
			RepoHtmlUrl: RepoHtmlUrl as string,
			DefaultBranch: DefaultBranch as string,
		},
	};
}

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
