import {
	MessagingDeliveryError,
	type MessagingLeaseId,
	type MessagingMessageId,
} from "./messaging.js";

export const MESSAGING_SETTLEMENT_LIMIT = 4096;
export const MESSAGING_SETTLEMENT_ID_LIMIT = 1024;
export const MESSAGING_SETTLEMENT_TIMEOUT_MS = 30_000;

export type MessagingSettlementOperation = "ack" | "nack";

export class MessagingSettlementUnknownError extends Error {
	readonly code = "MESSAGING_SETTLEMENT_UNKNOWN" as const;
	constructor(
		readonly operation: MessagingSettlementOperation,
		readonly messageId: MessagingMessageId,
		readonly leaseId: MessagingLeaseId,
	) {
		super(`outcome of ${operation} for ${messageId} is unknown`);
		this.name = "MessagingSettlementUnknownError";
	}
}

export class MessagingSettlementPendingError extends Error {
	readonly code = "MESSAGING_SETTLEMENT_PENDING" as const;
	constructor(readonly messageId: MessagingMessageId) {
		super(`settlement for ${messageId} is already in progress`);
		this.name = "MessagingSettlementPendingError";
	}
}

export function createMessagingSettlementTracker<Context>(
	timeoutMs = MESSAGING_SETTLEMENT_TIMEOUT_MS,
) {
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > MESSAGING_SETTLEMENT_TIMEOUT_MS
	)
		throw new RangeError("invalid messaging settlement timeout");
	const entries = new Map<
		string,
		{
			messageId: MessagingMessageId;
			leaseId: MessagingLeaseId;
			scope: string;
			context: Context;
			state:
				| { status: "ready" }
				| {
						status: "pending" | "unknown";
						operation: MessagingSettlementOperation;
				  };
		}
	>();
	const scopes = new Map<string, string>();
	const key = (messageId: MessagingMessageId, leaseId: MessagingLeaseId) =>
		JSON.stringify([messageId, leaseId]);
	return Object.freeze({
		capacity: () => MESSAGING_SETTLEMENT_LIMIT - entries.size,
		register(
			claims: readonly {
				messageId: MessagingMessageId;
				leaseId: MessagingLeaseId;
				scope: string;
				context: Context;
			}[],
		) {
			if (claims.length > MESSAGING_SETTLEMENT_LIMIT)
				throw new MessagingDeliveryError(
					"messaging settlement capacity exceeded",
				);
			const additions = new Set<string>();
			const claimedScopes = new Set<string>();
			const replaced = new Set<string>();
			for (const claim of claims) {
				if (
					claim.messageId.length > MESSAGING_SETTLEMENT_ID_LIMIT ||
					claim.leaseId.length > MESSAGING_SETTLEMENT_ID_LIMIT ||
					claim.scope.length === 0 ||
					claim.scope.length > 4096
				)
					throw new MessagingDeliveryError(
						"messaging lease identity is not bounded",
					);
				const identity = key(claim.messageId, claim.leaseId);
				if (
					entries.has(identity) ||
					additions.has(identity) ||
					claimedScopes.has(claim.scope)
				)
					throw new MessagingDeliveryError("duplicate messaging lease");
				if (identity.length > 4096)
					throw new MessagingDeliveryError(
						"messaging lease identity is not bounded",
					);
				additions.add(identity);
				claimedScopes.add(claim.scope);
				const previousId = scopes.get(claim.scope);
				if (previousId !== undefined) {
					const previous = entries.get(previousId);
					if (!previous)
						throw new MessagingDeliveryError(
							"messaging lease state is inconsistent",
						);
					if (previous.state.status === "pending")
						throw new MessagingSettlementPendingError(previous.messageId);
					if (previous.state.status === "unknown")
						throw new MessagingSettlementUnknownError(
							previous.state.operation,
							previous.messageId,
							previous.leaseId,
						);
					replaced.add(previousId);
				}
			}
			if (
				entries.size - replaced.size + claims.length >
				MESSAGING_SETTLEMENT_LIMIT
			)
				throw new MessagingDeliveryError(
					"messaging settlement capacity exceeded",
				);
			for (const identity of replaced) entries.delete(identity);
			for (const claim of claims) {
				const identity = key(claim.messageId, claim.leaseId);
				entries.set(identity, {
					messageId: claim.messageId,
					leaseId: claim.leaseId,
					scope: claim.scope,
					context: claim.context,
					state: { status: "ready" },
				});
				scopes.set(claim.scope, identity);
			}
		},
		async settle(
			messageId: MessagingMessageId,
			leaseId: MessagingLeaseId,
			operation: MessagingSettlementOperation,
			run: (context: Context) => Promise<void>,
		): Promise<Context> {
			const identity = key(messageId, leaseId);
			const entry = entries.get(identity);
			if (!entry)
				throw new MessagingDeliveryError(`no inflight message ${messageId}`);
			if (entry.state.status === "pending")
				throw new MessagingSettlementPendingError(messageId);
			if (entry.state.status === "unknown")
				throw new MessagingSettlementUnknownError(
					entry.state.operation,
					messageId,
					leaseId,
				);
			const deadline = performance.now() + timeoutMs;
			entry.state = { status: "pending", operation };
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					run(entry.context),
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error("settlement timeout")),
							timeoutMs,
						);
					}),
				]);
				if (performance.now() > deadline) throw new Error("settlement timeout");
			} catch {
				entry.state = { status: "unknown", operation };
				throw new MessagingSettlementUnknownError(
					operation,
					messageId,
					leaseId,
				);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			entries.delete(identity);
			scopes.delete(entry.scope);
			return entry.context;
		},
	});
}
