/**
 * One-time sensitive action store.
 *
 * A provider claim URL is bearer authority. Anyone holding it can take the
 * infrastructure, so it is stored encrypted, bound to the session that created
 * it, single-use where the provider allows, and never placed in an event, a
 * public read model, a log line, or a trace.
 */
import { timingSafeEqual } from "node:crypto";

import { ClaimError, type Instant } from "./types.js";

export type OneTimeActionRef = {
	readonly id: string;
	readonly audience: string;
	readonly expiresAt: Instant;
};

export type PutOneTimeActionInput = {
	readonly id: string;
	/** The bearer value. Encrypted before it reaches storage. */
	readonly value: string;
	readonly tenantId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly audience: string;
	readonly expiresAt: Instant;
	readonly singleUse: boolean;
};

export type RedeemOneTimeActionInput = {
	readonly id: string;
	readonly tenantId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly audience: string;
	readonly now: Instant;
};

export type RedeemedOneTimeAction = {
	readonly id: string;
	readonly value: string;
};

/** Encryption is delegated so the store never owns key management. */
export type ActionCipher = {
	seal(plaintext: string): string;
	open(sealed: string): string;
};

export type OneTimeActionAudit = {
	readonly id: string;
	readonly outcome:
		| "stored"
		| "redeemed"
		| "replayed"
		| "expired"
		| "revoked"
		| "denied";
	readonly at: Instant;
};

export type OneTimeActionStore = {
	put(input: PutOneTimeActionInput): Promise<OneTimeActionRef>;
	redeem(input: RedeemOneTimeActionInput): Promise<RedeemedOneTimeAction>;
	revoke(id: string): Promise<void>;
	expire(now: Instant): Promise<number>;
	/** Redemptions are audited without ever recording the bearer value. */
	audit(): readonly OneTimeActionAudit[];
};

type StoredAction = {
	readonly sealed: string;
	readonly tenantId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly audience: string;
	readonly expiresAt: Instant;
	readonly singleUse: boolean;
	redeemed: boolean;
};

function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) {
		// Still burn a comparison so length alone is not a fast path.
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

/**
 * In-memory implementation backed by an injected cipher.
 *
 * Durable deployments swap the map for the event-store-backed table; the scope,
 * expiry, replay, and audit rules are identical and are what the tests pin.
 */
export function createOneTimeActionStore(
	cipher: ActionCipher,
): OneTimeActionStore {
	const actions = new Map<string, StoredAction>();
	const auditLog: OneTimeActionAudit[] = [];

	return {
		async put(input) {
			if (input.expiresAt <= 0) {
				throw new ClaimError(
					"ONE_TIME_ACTION_EXPIRED",
					"a one-time action needs a positive expiry",
				);
			}
			actions.set(input.id, {
				sealed: cipher.seal(input.value),
				tenantId: input.tenantId,
				projectId: input.projectId,
				sessionId: input.sessionId,
				audience: input.audience,
				expiresAt: input.expiresAt,
				singleUse: input.singleUse,
				redeemed: false,
			});
			auditLog.push({ id: input.id, outcome: "stored", at: input.expiresAt });
			return {
				id: input.id,
				audience: input.audience,
				expiresAt: input.expiresAt,
			};
		},

		async redeem(input) {
			const stored = actions.get(input.id);
			if (stored === undefined) {
				auditLog.push({ id: input.id, outcome: "denied", at: input.now });
				// Same error whether it never existed or belonged to someone else:
				// existence must not leak across tenants.
				throw new ClaimError(
					"ONE_TIME_ACTION_EXPIRED",
					"one-time action is not available",
				);
			}
			const scopeMatches =
				constantTimeEquals(stored.tenantId, input.tenantId) &&
				constantTimeEquals(stored.projectId, input.projectId) &&
				constantTimeEquals(stored.sessionId, input.sessionId) &&
				constantTimeEquals(stored.audience, input.audience);
			if (!scopeMatches) {
				auditLog.push({ id: input.id, outcome: "denied", at: input.now });
				throw new ClaimError(
					"ONE_TIME_ACTION_EXPIRED",
					"one-time action is not available",
				);
			}
			if (stored.expiresAt <= input.now) {
				actions.delete(input.id);
				auditLog.push({ id: input.id, outcome: "expired", at: input.now });
				throw new ClaimError(
					"ONE_TIME_ACTION_EXPIRED",
					"one-time action has expired",
				);
			}
			if (stored.singleUse && stored.redeemed) {
				auditLog.push({ id: input.id, outcome: "replayed", at: input.now });
				throw new ClaimError(
					"ONE_TIME_ACTION_REPLAYED",
					"one-time action has already been redeemed",
				);
			}
			stored.redeemed = true;
			auditLog.push({ id: input.id, outcome: "redeemed", at: input.now });
			return { id: input.id, value: cipher.open(stored.sealed) };
		},

		async revoke(id) {
			if (actions.delete(id)) {
				auditLog.push({ id, outcome: "revoked", at: 0 });
			}
		},

		async expire(now) {
			let removed = 0;
			for (const [id, stored] of actions) {
				if (stored.expiresAt <= now) {
					actions.delete(id);
					auditLog.push({ id, outcome: "expired", at: now });
					removed += 1;
				}
			}
			return removed;
		},

		audit() {
			return [...auditLog];
		},
	};
}
