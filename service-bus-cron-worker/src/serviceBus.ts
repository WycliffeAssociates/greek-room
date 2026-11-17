/**
 * Minimal Azure Service Bus client over the REST API. The AMQP SDK needs raw
 * TCP sockets, which Workers don't provide.
 *
 * https://learn.microsoft.com/rest/api/servicebus/peek-lock-message-non-destructive-read
 */

/** SAS tokens are signed for this long. */
const TOKEN_TTL_SECONDS = 60 * 60;

export type ReceivedMessage = {
	body: string;
	messageId: string;
	sequenceNumber: number;
	lockToken: string;
	deliveryCount: number;
};

type BrokerProperties = {
	MessageId: string;
	SequenceNumber: number;
	LockToken: string;
	DeliveryCount: number;
};

type ConnectionString = {
	host: string; // e.g. "my-namespace.servicebus.windows.net"
	keyName: string;
	key: string;
};

function parseConnectionString(connectionString: string): ConnectionString {
	const parts = new Map<string, string>();
	for (const part of connectionString.split(";")) {
		const i = part.indexOf("=");
		if (i > 0) {
			// The key is base64 and can contain "=", so split on the first one only
			parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
		}
	}
	const endpoint = parts.get("Endpoint");
	const keyName = parts.get("SharedAccessKeyName");
	const key = parts.get("SharedAccessKey");
	if (!endpoint || !keyName || !key) {
		throw new Error("Connection string needs Endpoint, SharedAccessKeyName and SharedAccessKey");
	}
	return { host: new URL(endpoint).host, keyName, key };
}

async function sasToken(resourceUri: string, keyName: string, key: string): Promise<string> {
	const encodedUri = encodeURIComponent(resourceUri);
	const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
	const encoder = new TextEncoder();
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`${encodedUri}\n${expiry}`));
	const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return (
		`SharedAccessSignature sr=${encodedUri}&sig=${encodeURIComponent(sig)}` +
		`&se=${expiry}&skn=${encodeURIComponent(keyName)}`
	);
}

/** Peek-lock receiver for one topic subscription. */
export class SubscriptionClient {
	private constructor(
		private readonly baseUrl: string,
		private readonly token: string,
	) {}

	static async create(connectionString: string, topic: string, subscription: string): Promise<SubscriptionClient> {
		const { host, keyName, key } = parseConnectionString(connectionString);
		const baseUrl = `https://${host}/${encodeURIComponent(topic)}/subscriptions/${encodeURIComponent(subscription)}`;
		// Scoped to the subscription, which works for namespace- and topic-level policies
		return new SubscriptionClient(baseUrl, await sasToken(baseUrl, keyName, key));
	}

	/**
	 * Lock and return the next message, or null when the subscription is empty.
	 * The message stays in the subscription until it's completed; if it isn't,
	 * the lock expires and it's redelivered (and dead-lettered once its
	 * delivery count passes the subscription's max delivery count).
	 */
	async receive(timeoutSeconds = 5): Promise<ReceivedMessage | null> {
		const response = await fetch(`${this.baseUrl}/messages/head?timeout=${timeoutSeconds}`, {
			method: "POST",
			headers: { Authorization: this.token },
		});
		if (response.status === 204) {
			return null;
		}
		if (response.status !== 201) {
			throw new Error(`Receive failed: HTTP ${response.status} ${await response.text()}`);
		}
		const header = response.headers.get("BrokerProperties");
		if (!header) {
			throw new Error("Receive response has no BrokerProperties header");
		}
		const props = JSON.parse(header) as BrokerProperties;
		return {
			body: await response.text(),
			messageId: props.MessageId,
			sequenceNumber: props.SequenceNumber,
			lockToken: props.LockToken,
			deliveryCount: props.DeliveryCount,
		};
	}

	/** Delete a locked message from the subscription. */
	async complete(message: ReceivedMessage): Promise<void> {
		const response = await fetch(this.messageUrl(message), {
			method: "DELETE",
			headers: { Authorization: this.token },
		});
		if (!response.ok) {
			throw new Error(`Complete failed: HTTP ${response.status} ${await response.text()}`);
		}
	}

	private messageUrl(message: ReceivedMessage): string {
		return `${this.baseUrl}/messages/${message.sequenceNumber}/${encodeURIComponent(message.lockToken)}`;
	}
}
