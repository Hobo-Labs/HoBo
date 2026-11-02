import { createHash } from "node:crypto";

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
export const WEBHOOK_BODY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_RATE_WINDOW_MS = 60 * 1000;
export const MAX_WEBHOOKS_PER_INSTALLATION_WINDOW = 600;
export const MAX_OUTSTANDING_WEBHOOKS_PER_INSTALLATION = 10000;
export const MAX_OUTSTANDING_WEBHOOK_BYTES_PER_INSTALLATION = 64 * 1024 * 1024;
export const MAX_WEBHOOK_ATTEMPTS = 8;

export interface WebhookInput {
	deliveryId: string;
	event: string;
	installationId: number;
	repositoryId: number;
	rawBody: Uint8Array;
	receivedAt: string;
}
export interface ClaimedWebhook extends WebhookInput {
	token: string;
}

export function isWebhookDeliveryId(deliveryId: string): boolean {
	return /^[A-Za-z0-9-]{1,128}$/.test(deliveryId);
}

/** One parser for every inbox engine: the envelope, its identity, and its replay key. */
export interface WebhookEnvelope {
	readonly receivedMs: number;
	readonly fingerprint: string;
	readonly bodyHash: string;
}

export function parseWebhookEnvelope(input: WebhookInput): WebhookEnvelope {
	const receivedMs = Date.parse(input.receivedAt);
	if (
		!isWebhookDeliveryId(input.deliveryId) ||
		!["workflow_job", "workflow_run"].includes(input.event) ||
		!Number.isSafeInteger(input.installationId) ||
		input.installationId <= 0 ||
		!Number.isSafeInteger(input.repositoryId) ||
		input.repositoryId <= 0 ||
		input.rawBody.byteLength > MAX_WEBHOOK_BYTES ||
		!Number.isSafeInteger(receivedMs)
	)
		throw new Error("invalid webhook envelope");
	const fingerprint = createHash("sha256")
		.update(input.event)
		.update("\0")
		.update(String(input.installationId))
		.update("\0")
		.update(String(input.repositoryId))
		.update("\0")
		.update(input.rawBody)
		.digest("hex");
	// GitHub signs body bytes only, not delivery ID or event headers. Exact
	// signed-body replays have identical semantics and need no extra row.
	const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
	return { receivedMs, fingerprint, bodyHash };
}

export function webhookRetryDelayMs(attempts: number): number {
	return Math.min(300000, 1000 * 2 ** (attempts - 1));
}
