import type { HostedInboxStore } from "./hosted-runtime.js";

/** Per-delivery processing cap so one poison webhook cannot wedge the worker tick. */
// public-contract: inbox drain timeout for box worker poll decoupling.
export const DEFAULT_INBOX_DELIVERY_TIMEOUT_MS = 5_000;

/** Per drain pass budget; admission ticks stay under slow-tick alerting. */
// public-contract: inbox drain budget for box worker poll decoupling.
export const DEFAULT_INBOX_DRAIN_BUDGET_MS = 30_000;

export const DEFAULT_INBOX_DRAIN_CLAIM_MS = 120_000;

export type InboxDrainResult = Readonly<{
	processed: number;
	failed: number;
	timedOut: number;
	budgetExhausted: boolean;
	deliveriesMs: number;
	ingressWantsDispatch: boolean;
}>;

export type InboxDrainOptions = Readonly<{
	store: HostedInboxStore;
	processWebhook: (rawBody: Buffer, event: string) => Promise<string>;
	now: () => string;
	deliveryTimeoutMs?: number;
	budgetMs?: number;
	maxDeliveries?: number;
	claimLeaseMs?: number;
	onIngressOutcome?: (outcome: string) => void;
	onDeliveryEvent?: (
		event: "hobo_ci_inbox_delivery_failed" | "hobo_ci_inbox_delivery_timed_out",
		fields: Readonly<{
			deliveryId: string;
			webhookEvent: string;
			durationMs: number;
			reason: string;
		}>,
	) => void;
}>;

function inboxDeliveryReason(error: Error): string {
	const message = error.message.trim();
	if (!message) return "unknown";
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function ingressWantsDispatch(outcome: string): boolean {
	return (
		outcome === "queued" ||
		outcome === "requeued" ||
		outcome.startsWith("reserved:")
	);
}

async function runWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<
	| { ok: true; value: T }
	| { ok: false; timedOut: true }
	| { ok: false; timedOut: false; error: unknown }
> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				(value) => ({ ok: true as const, value }),
				(error) => ({ ok: false as const, timedOut: false as const, error }),
			),
			new Promise<{ ok: false; timedOut: true }>((resolve) => {
				timer = setTimeout(
					() => resolve({ ok: false, timedOut: true }),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function drainWebhookInbox(
	options: InboxDrainOptions,
): Promise<InboxDrainResult> {
	const deliveryTimeoutMs =
		options.deliveryTimeoutMs ?? DEFAULT_INBOX_DELIVERY_TIMEOUT_MS;
	const budgetMs = options.budgetMs ?? DEFAULT_INBOX_DRAIN_BUDGET_MS;
	const maxDeliveries = options.maxDeliveries ?? 50;
	const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_INBOX_DRAIN_CLAIM_MS;
	if (
		!Number.isInteger(deliveryTimeoutMs) ||
		deliveryTimeoutMs < 500 ||
		!Number.isInteger(budgetMs) ||
		budgetMs < 1_000
	)
		throw new Error("invalid inbox drain limits");
	const startedAt = Date.now();
	let processed = 0;
	let failed = 0;
	let timedOut = 0;
	let ingressDispatch = false;
	let budgetExhausted = false;
	for (let attempt = 0; attempt < maxDeliveries; attempt += 1) {
		const elapsed = Date.now() - startedAt;
		if (elapsed >= budgetMs) {
			budgetExhausted = true;
			break;
		}
		const claim = await options.store.claimWebhook(options.now(), claimLeaseMs);
		if (!claim) break;
		const deliveryStartedAt = Date.now();
		const remainingBudget = budgetMs - elapsed;
		const attemptTimeout = Math.min(
			deliveryTimeoutMs,
			Math.max(1, remainingBudget),
		);
		const result = await runWithTimeout(
			options.processWebhook(Buffer.from(claim.rawBody), claim.event),
			attemptTimeout,
		);
		const durationMs = Date.now() - deliveryStartedAt;
		if (!result.ok) {
			processed += 1;
			if (result.timedOut) {
				timedOut += 1;
				options.onDeliveryEvent?.("hobo_ci_inbox_delivery_timed_out", {
					deliveryId: claim.deliveryId,
					webhookEvent: claim.event,
					durationMs,
					reason: "delivery-timeout",
				});
			} else {
				failed += 1;
				options.onDeliveryEvent?.("hobo_ci_inbox_delivery_failed", {
					deliveryId: claim.deliveryId,
					webhookEvent: claim.event,
					durationMs,
					reason: inboxDeliveryReason(
						result.error instanceof Error ? result.error : new Error("unknown"),
					),
				});
			}
			if (
				(await options.store.failWebhook(
					claim.deliveryId,
					claim.token,
					options.now(),
				)) === "stale"
			)
				throw new Error("inbox claim lost");
			continue;
		}
		try {
			const outcome = result.value;
			options.onIngressOutcome?.(outcome);
			if (ingressWantsDispatch(outcome)) ingressDispatch = true;
			if (!(await options.store.ackWebhook(claim.deliveryId, claim.token)))
				throw new Error("inbox claim lost");
			processed += 1;
		} catch (error) {
			failed += 1;
			processed += 1;
			options.onDeliveryEvent?.("hobo_ci_inbox_delivery_failed", {
				deliveryId: claim.deliveryId,
				webhookEvent: claim.event,
				durationMs,
				reason: inboxDeliveryReason(
					error instanceof Error ? error : new Error("unknown"),
				),
			});
			if (
				(await options.store.failWebhook(
					claim.deliveryId,
					claim.token,
					options.now(),
				)) === "stale"
			)
				throw new Error("inbox claim lost");
		}
	}
	return {
		processed,
		failed,
		timedOut,
		budgetExhausted,
		deliveriesMs: Date.now() - startedAt,
		ingressWantsDispatch: ingressDispatch,
	};
}
