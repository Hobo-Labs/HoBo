/**
 * Compose OpenDelivery gateway weights onto ADR-0035 weighted routing.
 * Pure: maps rollout percent → traffic split; emits domain.RoutingChanged facts.
 */

import { createHash, randomUUID } from "node:crypto";
import type { OpenDeliveryEngine, RolloutState } from "./harness-delivery.js";
import type { JsonObject } from "./json.js";

// public-contract: gateway weight composition schema.
export const GATEWAY_WEIGHT_SCHEMA = "hobo.gateway-weight/v1" as const;

// public-contract: domain routing event types used by weighted canary.
export const DOMAIN_ROUTING_EVENTS = Object.freeze({
	RoutingChanged: "domain.RoutingChanged",
	RolledBack: "domain.RolledBack",
} as const);

export type TrafficWeightSplit = Readonly<{
	schemaVersion: typeof GATEWAY_WEIGHT_SCHEMA;
	/** Stable / baseline weight (0–100). */
	stable: number;
	/** Canary / treatment weight (0–100). */
	canary: number;
	/** Routing mode for gateway/domain. */
	mode: "weighted";
	/** Optional target labels. */
	targets: Readonly<{
		stable: string;
		canary: string;
	}>;
	rolloutId?: string;
	flag?: string;
}>;

export type DomainRoutingEvent = Readonly<{
	id: string;
	type: (typeof DOMAIN_ROUTING_EVENTS)[keyof typeof DOMAIN_ROUTING_EVENTS];
	schemaVersion: typeof GATEWAY_WEIGHT_SCHEMA;
	seq: number;
	time: string;
	data: JsonObject;
}>;

/**
 * Convert a canary percent (0–100) into a weighted traffic split for gateway/domain.
 */
export function trafficWeightSplitFromPercent(
	canaryPercent: number,
	options?: {
		readonly stableTarget?: string;
		readonly canaryTarget?: string;
		readonly rolloutId?: string;
		readonly flag?: string;
	},
): TrafficWeightSplit {
	const canary = clamp(canaryPercent);
	const stable = 100 - canary;
	return Object.freeze({
		schemaVersion: GATEWAY_WEIGHT_SCHEMA,
		stable,
		canary,
		mode: "weighted" as const,
		targets: Object.freeze({
			stable: options?.stableTarget ?? "stable",
			canary: options?.canaryTarget ?? "canary",
		}),
		...(options?.rolloutId !== undefined
			? { rolloutId: options.rolloutId }
			: undefined),
		...(options?.flag !== undefined ? { flag: options.flag } : undefined),
	});
}

/**
 * Apply OpenDelivery gateway weight onto the weighted-routing surface.
 * Returns the split and a domain.RoutingChanged (or RolledBack) fact.
 */
export function composeGatewayWeightFromRollout(
	rollout: Pick<
		RolloutState,
		"id" | "gatewayWeightPercent" | "status" | "policy"
	>,
	options?: {
		readonly now?: () => string;
		readonly seq?: number;
		readonly stableTarget?: string;
		readonly canaryTarget?: string;
	},
): {
	readonly split: TrafficWeightSplit;
	readonly event: DomainRoutingEvent;
} {
	const now = options?.now ?? (() => new Date().toISOString());
	const seq = options?.seq ?? 1;
	const split = trafficWeightSplitFromPercent(rollout.gatewayWeightPercent, {
		stableTarget: options?.stableTarget,
		canaryTarget: options?.canaryTarget,
		rolloutId: rollout.id,
		flag: rollout.policy.flag,
	});
	const rolledBack = rollout.status === "rolled_back";
	const event: DomainRoutingEvent = Object.freeze({
		id: `evt-domain-${seq}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
		type: rolledBack
			? DOMAIN_ROUTING_EVENTS.RolledBack
			: DOMAIN_ROUTING_EVENTS.RoutingChanged,
		schemaVersion: GATEWAY_WEIGHT_SCHEMA,
		seq,
		time: now(),
		data: Object.freeze({
			mode: "weighted",
			stable: split.stable,
			canary: split.canary,
			targets: split.targets,
			rolloutId: rollout.id,
			flag: rollout.policy.flag,
			status: rollout.status,
			contentHash: contentHashSplit(split),
		}),
	});
	return Object.freeze({ split, event });
}

/**
 * Live projection: read current weight from delivery engine and compose routing.
 */
export function applyRolloutToGatewayRouting(
	delivery: OpenDeliveryEngine,
	rolloutId: string,
	options?: {
		readonly now?: () => string;
		readonly stableTarget?: string;
		readonly canaryTarget?: string;
	},
): {
	readonly split: TrafficWeightSplit;
	readonly event: DomainRoutingEvent;
} | null {
	const state = delivery.get(rolloutId);
	if (!state) return null;
	if (state.policy.traffic !== "gateway-weighted") {
		// Flag-only: zero gateway weight, no domain flip.
		const split = trafficWeightSplitFromPercent(0, {
			rolloutId,
			flag: state.policy.flag,
			stableTarget: options?.stableTarget,
			canaryTarget: options?.canaryTarget,
		});
		return Object.freeze({
			split,
			event: Object.freeze({
				id: `evt-domain-flag-only-${rolloutId}`,
				type: DOMAIN_ROUTING_EVENTS.RoutingChanged,
				schemaVersion: GATEWAY_WEIGHT_SCHEMA,
				seq: 0,
				time: (options?.now ?? (() => new Date().toISOString()))(),
				data: Object.freeze({
					mode: "weighted",
					stable: 100,
					canary: 0,
					note: "flag-only traffic; gateway weight not shifted",
					rolloutId,
				}),
			}),
		});
	}
	return composeGatewayWeightFromRollout(state, options);
}

function clamp(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.floor(n)));
}

function contentHashSplit(split: TrafficWeightSplit): `sha256:${string}` {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(split))
		.digest("hex")
		.slice(0, 24)}`;
}
