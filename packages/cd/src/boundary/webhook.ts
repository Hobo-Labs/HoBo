// CloudEvents webhook sink (WP16, plan 0024 D17).
//
// - HTTP binding, binary content mode: `ce-*` headers carry the CloudEvents
//   context (from the CDEvent context per the CDEvents CloudEvents binding);
//   the body is the full CDEvent as JSON.
// - Signed with Standard Webhooks v1: `webhook-id`, `webhook-timestamp`,
//   `webhook-signature: v1,<base64 HMAC-SHA256(id.timestamp.body)>`. The
//   secret is resolved per delivery from the credential store and never kept.
//   No secret → no send (fail closed).
// - Retries 408/425/429/5xx and transport errors with exponential backoff
//   (1 s → 5 min, `Retry-After` honoured and capped, no jitter), at most
//   CD_DEFAULTS.webhookMaxAttempts attempts; then, or on any other 4xx, the
//   event is dead-lettered. Deterministic: injected clock and sleep.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpTransport, TransportResponse } from "@hobo/core";
import { CD_DEFAULTS } from "../events.js";
import type {
	CredentialResolver,
	OtelMetricPoint,
	TelemetrySink,
} from "../ports.js";
import { type CdEvent, canonicalJson } from "./cdevents.js";
import { BoundaryError, type BoundaryFailureCode } from "./errors.js";

// public-contract: CloudEvents HTTP binding header names (binary mode).
export const CLOUDEVENTS_HEADERS = Object.freeze({
	specversion: "ce-specversion",
	id: "ce-id",
	source: "ce-source",
	type: "ce-type",
	subject: "ce-subject",
	time: "ce-time",
} as const);

// public-contract: Standard Webhooks v1 signature headers.
export const WEBHOOK_SIGNATURE_HEADERS = Object.freeze({
	id: "webhook-id",
	timestamp: "webhook-timestamp",
	signature: "webhook-signature",
} as const);

// public-contract: credential scope used to resolve the signing secret.
export const WEBHOOK_SECRET_SCOPE = "cd.webhook.sign" as const;

/** Default receiver-side tolerance for webhook-timestamp (Standard Webhooks). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 300_000;

const RESPONSE_LIMIT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;

export type WebhookOutcome = "delivered" | "dead-lettered";

export type WebhookDelivery = Readonly<{
	outcome: WebhookOutcome;
	attempts: number;
	status?: number;
	code?: BoundaryFailureCode;
}>;

export type DeadLetterEntry = Readonly<{
	endpoint: string;
	event: CdEvent;
	attempts: number;
	code: BoundaryFailureCode;
	status?: number;
	detail: string;
	at: string;
}>;

/** Where undeliverable events go. Callers persist and replay them. */
export interface DeadLetterSink {
	put(entry: DeadLetterEntry): Promise<void>;
}

/** Anything that accepts projected CDEvents (the webhook sink, a test fake). */
export interface CdEventSink {
	deliver(event: CdEvent): Promise<WebhookDelivery>;
}

export type WebhookSinkOptions = Readonly<{
	endpoint: string;
	http: HttpTransport;
	credentials: CredentialResolver;
	/** Credential locator whose resolved `secret` signs every delivery. */
	secretRef: string;
	now: () => number;
	/** Injected wait between attempts (tests pass a recorder). */
	sleep?: (ms: number) => Promise<void>;
	deadLetter?: DeadLetterSink;
	telemetry?: TelemetrySink;
	maxAttempts?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	timeoutMs?: number;
	/** Permit plain http (loopback receivers only). */
	allowInsecureHttp?: boolean;
}>;

/** In-memory dead-letter queue with a listing, for local runs and tests. */
export function createMemoryDeadLetter(): DeadLetterSink & {
	entries(): readonly DeadLetterEntry[];
} {
	const entries: DeadLetterEntry[] = [];
	return {
		async put(entry) {
			entries.push(entry);
		},
		entries: () => [...entries],
	};
}

function validateEndpoint(endpoint: string, allowInsecureHttp: boolean): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new BoundaryError(
			"webhook-endpoint-invalid",
			`not an absolute URL: ${endpoint}`,
		);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && allowInsecureHttp && loopback)
	) {
		throw new BoundaryError(
			"webhook-endpoint-invalid",
			`scheme ${url.protocol} is not https`,
		);
	}
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		throw new BoundaryError(
			"webhook-endpoint-invalid",
			"credentials or fragment in URL",
		);
	}
	return url;
}

function decodeSecret(secret: string): Buffer {
	return secret.startsWith("whsec_")
		? Buffer.from(secret.slice("whsec_".length), "base64")
		: Buffer.from(secret, "utf8");
}

/** Standard Webhooks v1 signature value for one delivery. */
export function signWebhook(input: {
	readonly id: string;
	readonly timestampSeconds: number;
	readonly body: string;
	readonly secret: string;
}): string {
	const mac = createHmac("sha256", decodeSecret(input.secret))
		.update(`${input.id}.${input.timestampSeconds}.${input.body}`)
		.digest("base64");
	return `v1,${mac}`;
}

/**
 * Receiver-side verification (exported for receivers and conformance). Accepts
 * any of the space-separated `v1,` signatures; refuses a stale timestamp.
 */
export function verifyWebhookSignature(input: {
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly secret: string;
	readonly now: () => number;
	readonly toleranceMs?: number;
}): void {
	const header = (name: string): string =>
		Object.entries(input.headers).find(
			([key]) => key.toLowerCase() === name,
		)?.[1] ?? "";
	const id = header(WEBHOOK_SIGNATURE_HEADERS.id);
	const timestamp = Number(header(WEBHOOK_SIGNATURE_HEADERS.timestamp));
	const signatures = header(WEBHOOK_SIGNATURE_HEADERS.signature).split(" ");
	if (id === "" || !Number.isSafeInteger(timestamp)) {
		throw new BoundaryError(
			"webhook-signature-invalid",
			"missing webhook-id or webhook-timestamp",
		);
	}
	const tolerance = input.toleranceMs ?? WEBHOOK_TIMESTAMP_TOLERANCE_MS;
	if (Math.abs(input.now() - timestamp * 1000) > tolerance) {
		throw new BoundaryError(
			"webhook-timestamp-stale",
			`timestamp ${timestamp} outside ±${tolerance} ms`,
		);
	}
	const expected = Buffer.from(
		signWebhook({
			id,
			timestampSeconds: timestamp,
			body: input.body,
			secret: input.secret,
		}),
	);
	const ok = signatures.some((candidate) => {
		const given = Buffer.from(candidate);
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
	if (!ok)
		throw new BoundaryError(
			"webhook-signature-invalid",
			"no signature matched",
		);
}

function retryable(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(
	response: TransportResponse,
	nowMs: number,
): number | undefined {
	const raw = Object.entries(response.headers).find(
		([k]) => k.toLowerCase() === "retry-after",
	)?.[1];
	if (raw === undefined) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** Backoff before attempt n+1 (n ≥ 1): base·2^(n−1), capped. No jitter. */
export function webhookBackoffMs(
	attempt: number,
	baseMs: number,
	maxMs: number,
): number {
	return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Render the CloudEvents binary-mode request for one CDEvent. */
export function cloudEventRequest(event: CdEvent): {
	headers: Record<string, string>;
	body: string;
} {
	// SAFETY: CdEvent is a JSON-shaped record.
	const body = canonicalJson(event as never);
	return {
		headers: {
			"content-type": "application/json",
			[CLOUDEVENTS_HEADERS.specversion]: "1.0",
			[CLOUDEVENTS_HEADERS.id]: event.context.id,
			[CLOUDEVENTS_HEADERS.source]: event.context.source,
			[CLOUDEVENTS_HEADERS.type]: event.context.type,
			[CLOUDEVENTS_HEADERS.subject]: event.subject.id,
			[CLOUDEVENTS_HEADERS.time]: event.context.timestamp,
		},
		body,
	};
}

export function createCloudEventsWebhookSink(
	options: WebhookSinkOptions,
): CdEventSink {
	const url = validateEndpoint(
		options.endpoint,
		options.allowInsecureHttp === true,
	);
	const maxAttempts = Math.max(
		1,
		Math.min(
			options.maxAttempts ?? CD_DEFAULTS.webhookMaxAttempts,
			CD_DEFAULTS.webhookMaxAttempts,
		),
	);
	const baseMs = options.backoffBaseMs ?? CD_DEFAULTS.webhookBackoffBaseMs;
	const maxMs = options.backoffMaxMs ?? CD_DEFAULTS.webhookBackoffMaxMs;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	const metrics = async (points: readonly OtelMetricPoint[]): Promise<void> => {
		try {
			await options.telemetry?.metrics(points);
		} catch {
			// Telemetry is advisory; an exporter outage never fails delivery.
		}
	};

	const finish = async (
		event: CdEvent,
		delivery: WebhookDelivery,
		detail: string,
	): Promise<WebhookDelivery> => {
		const atMs = options.now();
		const attributes = {
			"cdevents.type": event.context.type,
			outcome: delivery.outcome,
		};
		const points: OtelMetricPoint[] = [
			{
				name: "hobo.cd.boundary.webhook.deliveries",
				kind: "counter",
				value: 1,
				unit: "{delivery}",
				atMs,
				attributes,
			},
			{
				name: "hobo.cd.boundary.webhook.attempts",
				kind: "histogram",
				value: delivery.attempts,
				unit: "{attempt}",
				atMs,
				attributes,
			},
		];
		if (delivery.outcome === "dead-lettered" && delivery.code !== undefined) {
			points.push({
				name: "hobo.cd.boundary.webhook.dead_letters",
				kind: "counter",
				value: 1,
				unit: "{event}",
				atMs,
				attributes: {
					"cdevents.type": event.context.type,
					code: delivery.code,
				},
			});
			await options.deadLetter?.put({
				endpoint: url.toString(),
				event,
				attempts: delivery.attempts,
				code: delivery.code,
				...(delivery.status !== undefined
					? { status: delivery.status }
					: undefined),
				detail,
				at: new Date(atMs).toISOString(),
			});
		}
		await metrics(points);
		return delivery;
	};

	return {
		async deliver(event) {
			const resolved = await options.credentials.resolve(
				options.secretRef,
				WEBHOOK_SECRET_SCOPE,
			);
			const secret = resolved.secret;
			if (secret === undefined || secret === "") {
				throw new BoundaryError(
					"webhook-secret-missing",
					`secretRef ${options.secretRef} has no secret`,
				);
			}
			const request = cloudEventRequest(event);
			let lastStatus: number | undefined;
			let lastDetail = "";
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				const timestampSeconds = Math.floor(options.now() / 1000);
				const headers = {
					...request.headers,
					[WEBHOOK_SIGNATURE_HEADERS.id]: event.context.id,
					[WEBHOOK_SIGNATURE_HEADERS.timestamp]: String(timestampSeconds),
					[WEBHOOK_SIGNATURE_HEADERS.signature]: signWebhook({
						id: event.context.id,
						timestampSeconds,
						body: request.body,
						secret,
					}),
				};
				let waitMs = webhookBackoffMs(attempt, baseMs, maxMs);
				try {
					const response = await options.http({
						method: "POST",
						url: url.toString(),
						headers,
						body: request.body,
						timeoutMs,
						maxResponseBytes: RESPONSE_LIMIT_BYTES,
					});
					lastStatus = response.status;
					if (response.status >= 200 && response.status < 300) {
						return finish(
							event,
							{
								outcome: "delivered",
								attempts: attempt,
								status: response.status,
							},
							"",
						);
					}
					if (!retryable(response.status)) {
						return finish(
							event,
							{
								outcome: "dead-lettered",
								attempts: attempt,
								status: response.status,
								code: "webhook-rejected",
							},
							`HTTP ${response.status}`,
						);
					}
					lastDetail = `HTTP ${response.status}`;
					const after = retryAfterMs(response, options.now());
					if (after !== undefined)
						waitMs = Math.min(maxMs, Math.max(waitMs, after));
				} catch (error) {
					lastStatus = undefined;
					lastDetail = `transport: ${error instanceof Error ? error.message : String(error)}`;
				}
				if (attempt < maxAttempts) await sleep(waitMs);
			}
			return finish(
				event,
				{
					outcome: "dead-lettered",
					attempts: maxAttempts,
					code: "webhook-retries-exhausted",
					...(lastStatus !== undefined ? { status: lastStatus } : undefined),
				},
				lastDetail,
			);
		},
	};
}
