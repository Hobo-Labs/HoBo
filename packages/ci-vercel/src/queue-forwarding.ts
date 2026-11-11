import { createHash, timingSafeEqual } from "node:crypto";
import type { RetryHandler } from "@vercel/queue";
import { z } from "zod";
import { StoreUnavailable } from "./store-unavailable.js";
import { type QueueMessage, QueueMessageSchema } from "./worker.js";

const Wakeup = z.union([
	z.object({ deliveryId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) }).strict(),
	z
		.object({
			source: z.enum(["static", "hobo-ci"]),
			name: z.literal("hobo-ci-repair"),
		})
		.strict(),
	z.null(),
]);
const MAX_BODY = 4096;

function relayOrigin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("invalid queue handoff origin");
	return url.origin;
}

/** Drop nonessential producer metadata before forwarding a durable wakeup. */
export function normalizeQueueWakeup(
	message: QueueMessage,
): z.infer<typeof Wakeup> {
	message = QueueMessageSchema.parse(message);
	if (message === null) return null;
	if ("deliveryId" in message)
		return Wakeup.parse({ deliveryId: message.deliveryId });
	return Wakeup.parse({ source: message.source, name: message.name });
}

/**
 * The relay answered a wakeup with something other than 204.
 *
 * The message carries the status and, when the relay stated one, its
 * `Retry-After` in seconds: two numbers. It never carries the response body,
 * a header's text, the request or the handoff secret.
 */
export class QueueHandoffError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterSeconds: number | undefined,
	) {
		super(
			retryAfterSeconds === undefined
				? `queue handoff failed: status ${status}`
				: `queue handoff failed: status ${status}, retry-after ${retryAfterSeconds}s`,
		);
		this.name = "QueueHandoffError";
	}
}

/** `Retry-After` as whole seconds from now: delta-seconds, or an HTTP date. */
function parseRetryAfter(
	value: string | null,
	nowMs: number,
): number | undefined {
	const text = value?.trim() ?? "";
	if (/^\d{1,9}$/.test(text)) return Number(text);
	if (
		!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
			text,
		)
	)
		return undefined;
	const at = Date.parse(text);
	return Number.isNaN(at)
		? undefined
		: Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** The longest the queue is asked to hold a refused wakeup before redelivering it. */
export const QUEUE_REDELIVERY_MAX_SECONDS = 300;
const QUEUE_REDELIVERY_BASE_SECONDS = 5;

/**
 * Seconds until the queue should redeliver a wakeup the relay could not take.
 *
 * At least what the relay stated in `Retry-After`, and at least 5 s doubling
 * with each delivery of this message (5, 10, 20, ... by `deliveryCount`), so a
 * relay that keeps answering "come back in 5" is not asked every 5 s for the
 * message's whole hour. Never more than five minutes.
 */
export function queueRedeliveryDelaySeconds(options: {
	retryAfterSeconds?: number | undefined;
	deliveryCount: number;
}): number {
	const delivery =
		Number.isSafeInteger(options.deliveryCount) && options.deliveryCount > 0
			? options.deliveryCount
			: 1;
	const backoff =
		QUEUE_REDELIVERY_BASE_SECONDS * 2 ** Math.min(delivery - 1, 6);
	const stated =
		options.retryAfterSeconds !== undefined &&
		Number.isFinite(options.retryAfterSeconds)
			? Math.ceil(options.retryAfterSeconds)
			: 0;
	return Math.min(QUEUE_REDELIVERY_MAX_SECONDS, Math.max(backoff, stated));
}

/**
 * The queue consumer's `retry` policy (`@vercel/queue` calls it when the
 * callback throws).
 *
 * A relay that is temporarily unable to take the wakeup, which is a 503 from
 * the handoff or the store back-off raised in-process, gets the message back
 * after {@link queueRedeliveryDelaySeconds}: the queue holds it, and no
 * function runs meanwhile. Every other failure returns nothing, so the error
 * propagates and the queue applies its own default: a 4xx, a redirect or a
 * broken configuration is not something waiting a stated time repairs.
 */
export const redeliverRefusedWakeup: RetryHandler = (error, metadata) => {
	let stated: number | undefined;
	if (error instanceof QueueHandoffError) {
		if (error.status !== 503) return undefined;
		stated = error.retryAfterSeconds;
	} else if (error instanceof StoreUnavailable) {
		stated = error.retryAfterMs / 1000;
	} else return undefined;
	return {
		afterSeconds: queueRedeliveryDelaySeconds({
			retryAfterSeconds: stated,
			deliveryCount: metadata.deliveryCount,
		}),
	};
};

/**
 * A callback acknowledges only after the current relay confirms processing.
 *
 * One request, never retried here: any answer but 204 throws a
 * {@link QueueHandoffError} at once, and redelivery is the queue's job
 * ({@link redeliverRefusedWakeup}), not a loop inside a running function.
 */
export async function forwardQueueWakeup(options: {
	origin: string;
	secret: string;
	message: unknown;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Clock for an HTTP-date `Retry-After`; injectable for tests. */
	now?: () => number;
}): Promise<void> {
	const origin = relayOrigin(options.origin);
	if (Buffer.byteLength(options.secret) < 32)
		throw new Error("invalid queue handoff secret");
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("invalid queue handoff timeout");
	const message = normalizeQueueWakeup(
		QueueMessageSchema.parse(options.message),
	);
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(
			`${origin}/internal/queue-wakeup`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${options.secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(message),
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
	} catch {
		throw new Error("queue handoff unavailable");
	}
	void response.body?.cancel().catch(() => {});
	if (response.status !== 204)
		throw new QueueHandoffError(
			response.status,
			parseRetryAfter(
				response.headers.get("retry-after"),
				(options.now ?? Date.now)(),
			),
		);
}

/** A scheduled or self-continued repair, as opposed to a webhook delivery. */
function isRepairTick(message: z.infer<typeof Wakeup>): boolean {
	return message !== null && "name" in message;
}

/** Authenticate before reading a bounded payload and run only the active worker. */
export function createQueueWakeupHandler(options: {
	origin: string;
	secret: string;
	run(message: QueueMessage): Promise<void>;
}) {
	const origin = relayOrigin(options.origin);
	if (Buffer.byteLength(options.secret) < 32)
		throw new Error("invalid queue handoff secret");
	const expected = createHash("sha256")
		.update(`Bearer ${options.secret}`)
		.digest();
	return async (request: Request): Promise<Response> => {
		const headers = { "cache-control": "no-store" };
		const url = new URL(request.url);
		const actual = createHash("sha256")
			.update(request.headers.get("authorization") ?? "")
			.digest();
		if (
			request.method !== "POST" ||
			url.origin !== origin ||
			url.pathname !== "/internal/queue-wakeup" ||
			!timingSafeEqual(actual, expected)
		)
			return new Response(null, { status: 403, headers });
		if (
			request.headers.get("content-type")?.split(";")[0]?.trim() !==
			"application/json"
		)
			return new Response(null, { status: 415, headers });
		const declared = request.headers.get("content-length");
		if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
			return new Response(null, { status: 413, headers });
		if (!request.body) return new Response(null, { status: 400, headers });
		const reader = request.body.getReader();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("queue handoff timed out")),
					5000,
				);
			});
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const part = await Promise.race([reader.read(), timeout]);
				if (part.done) break;
				total += part.value.byteLength;
				if (total > MAX_BODY)
					return new Response(null, { status: 413, headers });
				chunks.push(part.value);
			}
			const parsed = Wakeup.safeParse(
				JSON.parse(Buffer.concat(chunks).toString("utf8")),
			);
			if (!parsed.success) return new Response(null, { status: 400, headers });
			if (timer) clearTimeout(timer);
			timer = undefined;
			try {
				await options.run(parsed.data);
				return new Response(null, { status: 204, headers });
			} catch (error) {
				// A repair tick is periodic and only re-reads the store, so one that
				// fails is acknowledged and dropped: the next tick does the same
				// work. Holding it would keep every deployment that ever scheduled
				// it (old production deployments keep their queue consumers and
				// schedules) retrying against this relay. Whatever the failure: the
				// first attempt after a store back-off fails with the store's own
				// error, not `StoreUnavailable`, and is no more worth repeating.
				if (isRepairTick(parsed.data))
					return new Response(null, { status: 204, headers });
				// The store back-off knows when it will look again; say so, and the
				// queue consumer holds the message until then.
				return new Response(null, {
					status: 503,
					headers:
						error instanceof StoreUnavailable
							? {
									...headers,
									"retry-after": String(
										Math.min(
											QUEUE_REDELIVERY_MAX_SECONDS,
											Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
										),
									),
								}
							: headers,
				});
			}
		} catch {
			return new Response(null, { status: 400, headers });
		} finally {
			if (timer) clearTimeout(timer);
			void reader.cancel().catch(() => {});
			try {
				reader.releaseLock();
			} catch {
				/* A timed-out read is still unwinding. */
			}
		}
	};
}
