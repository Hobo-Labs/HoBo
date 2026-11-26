import { CREDENTIAL_AUDIT_RETENTION } from "@hobo/identity";

import type { McpPrincipal } from "./auth.js";

// S3-06 — per-principal / per-tenant backpressure at the tool-call boundary
// (NFR-019). A token bucket (burst capacity + steady refill) plus an optional
// hard call quota over a fixed window, keyed by (tenant, principal). It is
// applied in server.callTool BEFORE dispatch, so a flooding principal is
// throttled with a typed MCP_RATE_LIMITED result + an audited throttle fact,
// while a control principal in the same window is unaffected.
//
// Time is a PARAMETER, never wall-clock: check({ ..., now }) is a pure function
// of the injected clock value, so the limiter is fully deterministic in tests.

export const MCP_TOOL_CALL_THROTTLED = "mcp.ToolCallThrottled";
export const MCP_RATE_LIMIT_EVENTS_SCHEMA_VERSION = "hobo.mcp-events/v1";
export const MCP_RATE_LIMITED_CODE = "MCP_RATE_LIMITED";

export type RateLimitReason = "ok" | "rate" | "quota";

// domain-view: the fixed-window call quota; its wire form is McpQuota in
// data-models/mcp.proto.
export interface Quota {
	readonly limit: number;
	readonly windowMs: number;
}

// domain-view: the token-bucket + quota policy; its wire form is
// McpRateLimitPolicy in data-models/mcp.proto.
export interface RateLimitPolicy {
	readonly capacity: number;
	readonly refillTokens: number;
	readonly refillIntervalMs: number;
	readonly quota?: Quota;
}

// domain-view: the limiter's per-call decision; its wire form is
// McpRateLimitDecision in data-models/mcp.proto. `reason` is the typed
// backpressure signal: "rate" (bucket empty) or "quota" (window cap hit).
export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly key: string;
	readonly reason: RateLimitReason;
	readonly retryAfterMs: number;
	readonly remainingTokens: number;
	readonly quotaRemaining: number;
}

// domain-view: the audited throttle fact; its wire form is
// McpToolCallThrottledEvent in data-models/mcp.proto. A credential-audit sibling
// of AuthDecisionEvent, carrying the never-compact retention.
export interface RateLimitEvent {
	readonly id: string;
	readonly type: typeof MCP_TOOL_CALL_THROTTLED;
	readonly schemaVersion: typeof MCP_RATE_LIMIT_EVENTS_SCHEMA_VERSION;
	readonly tenant: string;
	readonly seq: number;
	readonly time: string;
	readonly actor: McpPrincipal;
	readonly correlationId: string;
	readonly retention: typeof CREDENTIAL_AUDIT_RETENTION;
	readonly data: {
		readonly tool: string;
		readonly subject: string;
		readonly reason: RateLimitReason;
		readonly key: string;
	};
}

export interface RateLimiter {
	readonly check: (input: {
		readonly tenant: string;
		readonly principal: McpPrincipal;
		readonly now: number;
	}) => RateLimitDecision;
}

interface BucketState {
	tokens: number;
	lastRefill: number;
	windowStart: number;
	windowCount: number;
}

export function rateLimitKey(tenant: string, principal: McpPrincipal): string {
	return `${tenant}::${principal.kind}:${principal.id}`;
}

/**
 * A deterministic per-(tenant, principal) token-bucket + quota limiter. Refill
 * is lazy and computed from the elapsed injected time, so no timers are used and
 * two identical call sequences at identical clock values decide identically.
 */
export function createRateLimiter(policy: RateLimitPolicy): RateLimiter {
	const states = new Map<string, BucketState>();

	function stateFor(key: string, now: number): BucketState {
		const existing = states.get(key);
		if (existing) return existing;
		const created: BucketState = {
			tokens: policy.capacity,
			lastRefill: now,
			windowStart: now,
			windowCount: 0,
		};
		states.set(key, created);
		return created;
	}

	return {
		check({ tenant, principal, now }) {
			const key = rateLimitKey(tenant, principal);
			const state = stateFor(key, now);

			// Lazy refill: add whole intervals' worth of tokens since the last refill.
			const elapsed = Math.max(0, now - state.lastRefill);
			const refills = Math.floor(elapsed / policy.refillIntervalMs);
			if (refills > 0) {
				state.tokens = Math.min(
					policy.capacity,
					state.tokens + refills * policy.refillTokens,
				);
				state.lastRefill += refills * policy.refillIntervalMs;
			}

			// Roll the quota window if it has elapsed.
			if (policy.quota && now - state.windowStart >= policy.quota.windowMs) {
				state.windowStart = now;
				state.windowCount = 0;
			}

			const quotaRemaining = policy.quota
				? Math.max(0, policy.quota.limit - state.windowCount)
				: Number.POSITIVE_INFINITY;

			// Quota is the hard ceiling: exhausting it throttles until the window rolls.
			if (policy.quota && state.windowCount >= policy.quota.limit) {
				const retryAfterMs = Math.max(
					0,
					state.windowStart + policy.quota.windowMs - now,
				);
				return {
					allowed: false,
					key,
					reason: "quota",
					retryAfterMs,
					remainingTokens: Math.floor(state.tokens),
					quotaRemaining: 0,
				};
			}

			// Then the burst bucket.
			if (state.tokens < 1) {
				const sinceRefill = Math.max(0, now - state.lastRefill);
				const retryAfterMs = Math.max(0, policy.refillIntervalMs - sinceRefill);
				return {
					allowed: false,
					key,
					reason: "rate",
					retryAfterMs,
					remainingTokens: 0,
					quotaRemaining:
						quotaRemaining === Number.POSITIVE_INFINITY ? -1 : quotaRemaining,
				};
			}

			// Allowed — consume one token and one quota unit.
			state.tokens -= 1;
			state.windowCount += 1;
			return {
				allowed: true,
				key,
				reason: "ok",
				retryAfterMs: 0,
				remainingTokens: Math.floor(state.tokens),
				quotaRemaining:
					quotaRemaining === Number.POSITIVE_INFINITY
						? -1
						: Math.max(0, quotaRemaining - 1),
			};
		},
	};
}

/** Build the audited throttle fact for a refused call. */
export function createThrottleEvent(input: {
	tool: string;
	auth: { subject: string; tenant: string; principal: McpPrincipal };
	decision: RateLimitDecision;
	correlationId: string;
	seq: number;
	now: string;
}): RateLimitEvent {
	const reason: RateLimitReason =
		input.decision.reason === "quota" ? "quota" : "rate";
	return {
		id: `evt-mcp-throttled-${input.tool}-${input.seq}`,
		type: MCP_TOOL_CALL_THROTTLED,
		schemaVersion: MCP_RATE_LIMIT_EVENTS_SCHEMA_VERSION,
		tenant: input.auth.tenant,
		seq: input.seq,
		time: input.now,
		actor: input.auth.principal,
		correlationId: input.correlationId,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: {
			tool: input.tool,
			subject: input.auth.subject,
			reason,
			key: input.decision.key,
		},
	};
}
