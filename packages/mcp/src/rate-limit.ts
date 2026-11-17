import { randomUUID } from "node:crypto";
import { CREDENTIAL_AUDIT_RETENTION } from "@hobo/identity";

import type { McpPrincipal } from "./auth.js";

export const MCP_TOOL_CALL_THROTTLED = "mcp.ToolCallThrottled";
export const MCP_RATE_LIMIT_EVENTS_SCHEMA_VERSION = "hobo.mcp-events/v1";
export const MCP_RATE_LIMITED_CODE = "MCP_RATE_LIMITED";

export type RateLimitReason = "ok" | "rate" | "quota";

export interface Quota {
	readonly limit: number;
	readonly windowMs: number;
}

export interface RateLimitPolicy {
	readonly capacity: number;
	readonly refillTokens: number;
	readonly refillIntervalMs: number;
	readonly quota?: Quota;
}

export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly key: string;
	readonly reason: RateLimitReason;
	readonly retryAfterMs: number;
	readonly remainingTokens: number;
	readonly quotaRemaining: number;
}

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

			const elapsed = Math.max(0, now - state.lastRefill);
			const refills = Math.floor(elapsed / policy.refillIntervalMs);
			if (refills > 0) {
				state.tokens = Math.min(
					policy.capacity,
					state.tokens + refills * policy.refillTokens,
				);
				state.lastRefill += refills * policy.refillIntervalMs;
			}

			if (policy.quota && now - state.windowStart >= policy.quota.windowMs) {
				state.windowStart = now;
				state.windowCount = 0;
			}

			const quotaRemaining = policy.quota
				? Math.max(0, policy.quota.limit - state.windowCount)
				: Number.POSITIVE_INFINITY;

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
		id: `evt-mcp-throttled-${randomUUID()}`,
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
