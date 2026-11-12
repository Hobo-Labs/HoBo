/**
 * Pluggable metering / usage events.
 * Full billing engines plug in as sinks that aggregate these events.
 */

import type { TenantId } from "./tenant.js";

export type UsageEventType =
	| "junction.join"
	| "junction.leave"
	| "tunnel.up"
	| "tunnel.heartbeat"
	| "tunnel.down"
	| "name.resolve"
	| "named_endpoint.register"
	| "named_endpoint.unregister"
	| "dns.record_upsert"
	| "dns.record_delete"
	| "dns.suggest"
	| "dns.dynamic_register"
	| "policy.evaluate"
	| "overlay.join"
	| "overlay.leave"
	| "overlay.magicdns"
	| "overlay.funnel"
	| "routing.plan.apply"
	| "routing.plan.degraded"
	| "routing.plan.deny"
	| "billing.invoice_line"
	| "billing.period_close"
	| "messaging.publish"
	| "messaging.consume"
	| "messaging.actor.activate"
	| "messaging.dapr.sidecar_lifetime"
	// HoBo Fleet (ADR-0182). Emitted only by the authority, so nothing bills
	// itself: member-hours from registry state, sandbox-seconds by tier from
	// receipts, and relayed or direct transport bytes from the acceptor's
	// session-close fact.
	| "fleet.member.active"
	| "fleet.work.sandbox"
	| "fleet.transport.relay"
	| "fleet.transport.direct";

export interface UsageEvent {
	readonly tenantId: TenantId;
	readonly eventType: UsageEventType;
	readonly resource: string;
	readonly quantity: number;
	readonly unit: string;
	readonly timestamp: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MeteringSink {
	readonly sinkId: string;
	emit(event: UsageEvent): Promise<void> | void;
}

export interface MeteringBus {
	readonly emit: (event: UsageEvent) => Promise<void>;
	readonly addSink: (sink: MeteringSink) => void;
	readonly removeSink: (sinkId: string) => void;
	readonly listSinks: () => readonly MeteringSink[];
}

export function createUsageEvent(input: {
	readonly tenantId: TenantId;
	readonly eventType: UsageEventType;
	readonly resource: string;
	readonly quantity?: number;
	readonly unit?: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
	readonly timestamp?: string;
}): UsageEvent {
	return {
		tenantId: input.tenantId,
		eventType: input.eventType,
		resource: input.resource,
		quantity: input.quantity ?? 1,
		unit: input.unit ?? "count",
		timestamp: input.timestamp ?? new Date().toISOString(),
		...(input.metadata !== undefined
			? { metadata: input.metadata }
			: undefined),
	};
}

export function createMeteringBus(
	initial: readonly MeteringSink[] = [],
): MeteringBus {
	const sinks = new Map<string, MeteringSink>();
	for (const sink of initial) sinks.set(sink.sinkId, sink);

	return {
		async emit(event) {
			await Promise.all(
				[...sinks.values()].map(async (sink) => {
					await sink.emit(event);
				}),
			);
		},
		addSink(sink) {
			sinks.set(sink.sinkId, sink);
		},
		removeSink(sinkId) {
			sinks.delete(sinkId);
		},
		listSinks() {
			return [...sinks.values()];
		},
	};
}
