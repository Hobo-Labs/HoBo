/**
 * Dapr-backed ActorHost: maps HoBo single-writer lease + fence onto Dapr
 * virtual-actor single-threaded concurrency + placement.
 *
 * Residual divergence (declared): Dapr reminders/timers are optional; state may
 * fold from HoBo event stream (default) or Dapr state store when configured.
 * Fencing is emulated with monotonic tokens per actor key for parity with
 * native ActorHost conformance assertions.
 */

import {
	type ActorHost,
	type ActorLease,
	type ActorStateHandle,
	createUsageEvent,
	type FoldEvent,
	type MeteringBus,
	type TenantId,
} from "@hobo/core";
import { mustGet } from "@hobo/core/total-access";
import type { DaprSidecarClient } from "./dapr-client.js";
import type { DaprRuntimeConfig } from "./types.js";

/** Core `ActorLease` (ADR-0156) tagged with the Dapr placement. */
export interface DaprActorLease extends ActorLease {
	readonly placement: "dapr";
}

/** The canonical `@hobo/core` state handle (ADR-0156), under its Dapr name. */
export type DaprActorStateHandle<S> = ActorStateHandle<S>;

/** The core ActorHost port (ADR-0156) plus Dapr-specific members. */
export interface DaprActorHost extends ActorHost {
	readonly placementMode: "dapr";
	/** `live` when a daprd client was injected for reminders/invoke. */
	readonly fidelity: "simulated" | "live";
	acquire(key: string, request: { holderId: string }): DaprActorLease;
	/** Reminder registration (maps to Dapr actor reminders). */
	registerReminder(
		key: string,
		name: string,
		dueMs: number,
	): { reminderId: string } | Promise<{ reminderId: string }>;
	events(): readonly DaprActorLifecycleEvent[];
}

export interface DaprActorLifecycleEvent {
	readonly type:
		| "actor.Activated"
		| "actor.StateAppended"
		| "actor.Passivated"
		| "actor.ReminderRegistered";
	readonly key: string;
	readonly holderId?: string;
	readonly fenceToken?: string;
	readonly at: string;
	readonly placement: "dapr";
}

export class DaprLeaseConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaprLeaseConflictError";
	}
}

export class DaprStaleFenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaprStaleFenceError";
	}
}

interface LeaseRec {
	key: string;
	holderId: string;
	fenceToken: bigint;
	expiresAtMs: number;
	released: boolean;
}

interface StreamRec {
	events: FoldEvent[];
}

export interface CreateDaprActorHostOptions {
	readonly config: DaprRuntimeConfig;
	readonly leaseTtlMs?: number;
	readonly nowMs?: () => number;
	readonly metering?: MeteringBus;
	/**
	 * When set, reminders + optional actor invoke ride the daprd client path
	 * (fidelity=`live`). Lease/fence single-writer remains local for parity
	 * with native ActorHost conformance (Dapr concurrency mapped here).
	 */
	readonly client?: DaprSidecarClient;
}

export function createDaprActorHost(
	options: CreateDaprActorHostOptions,
): DaprActorHost {
	const leaseTtlMs = options.leaseTtlMs ?? 30_000;
	const nowMs = options.nowMs ?? (() => Date.now());
	const client = options.client;
	const fidelity: "simulated" | "live" = client ? "live" : "simulated";
	const leases = new Map<string, LeaseRec>();
	const streams = new Map<string, StreamRec>();
	const lifecycle: DaprActorLifecycleEvent[] = [];
	let reminderSeq = 0;

	const emit = (e: Omit<DaprActorLifecycleEvent, "at" | "placement">) => {
		lifecycle.push(
			Object.freeze({
				...e,
				at: new Date(nowMs()).toISOString(),
				placement: "dapr" as const,
			}),
		);
	};

	const host: DaprActorHost = {
		placementMode: "dapr",
		fidelity,

		acquire(key, request) {
			const actorKey = key;
			const holderId = request.holderId;
			const t = nowMs();
			const current = leases.get(actorKey);
			if (current && !current.released && current.expiresAtMs > t) {
				throw new DaprLeaseConflictError(
					`dapr actor placement conflict for ${actorKey}: held by ${current.holderId}`,
				);
			}
			// Live client path: also invoke daprd actor acquire for placement.
			if (client) {
				const [actorType, ...rest] = actorKey.split("/");
				void client.invokeActor({
					actorType: actorType || "Actor",
					actorId: rest.join("/") || actorKey,
					method: "acquire",
					data: { holderId },
				});
			}
			const next: LeaseRec = {
				key: actorKey,
				holderId,
				fenceToken: (current?.fenceToken ?? 0n) + 1n,
				expiresAtMs: t + leaseTtlMs,
				released: false,
			};
			leases.set(actorKey, next);
			emit({
				type: "actor.Activated",
				key: actorKey,
				holderId,
				fenceToken: next.fenceToken.toString(),
			});
			if (options.metering) {
				void options.metering.emit(
					createUsageEvent({
						// SAFETY: assertion required at this I/O or test boundary.
						tenantId: options.config.tenantId as TenantId,
						eventType: "messaging.actor.activate",
						resource: actorKey,
						metadata: {
							placement: "dapr",
							appId: options.config.appId,
							fidelity,
						},
					}),
				);
			}
			const lease: DaprActorLease = {
				key: actorKey,
				holderId,
				fenceToken: next.fenceToken,
				expiresAt: new Date(next.expiresAtMs).toISOString(),
				placement: "dapr",
				release() {
					const rec = leases.get(actorKey);
					if (rec && rec.fenceToken === next.fenceToken) {
						rec.released = true;
						if (client) {
							const [actorType, ...rest] = actorKey.split("/");
							void client.invokeActor({
								actorType: actorType || "Actor",
								actorId: rest.join("/") || actorKey,
								method: "release",
							});
						}
						emit({
							type: "actor.Passivated",
							key: actorKey,
							holderId,
							fenceToken: next.fenceToken.toString(),
						});
					}
				},
			};
			return Object.freeze(lease);
		},

		state(key, request) {
			if (!streams.has(key)) streams.set(key, { events: [] });
			const streamId = `dapr-actor://${options.config.appId}/${key}`;

			return {
				append(lease, event) {
					const rec = leases.get(key);
					if (
						!rec ||
						rec.released ||
						rec.fenceToken !== lease.fenceToken ||
						rec.holderId !== lease.holderId
					) {
						throw new DaprStaleFenceError(
							`stale fence for ${key}: token ${lease.fenceToken}`,
						);
					}
					if (rec.expiresAtMs <= nowMs()) {
						throw new DaprStaleFenceError(`lease expired for ${key}`);
					}
					const stream = mustGet(streams, key);
					stream.events.push(event);
					emit({
						type: "actor.StateAppended",
						key,
						holderId: lease.holderId,
						fenceToken: lease.fenceToken.toString(),
					});
					return {
						streamId,
						seq: stream.events.length,
						fenceToken: lease.fenceToken,
					};
				},
				read() {
					const stream = streams.get(key) ?? { events: [] };
					let state = request.initialState;
					for (const event of stream.events) {
						state = request.fold(state, event);
					}
					return {
						streamId,
						seq: stream.events.length,
						state,
					};
				},
			};
		},

		registerReminder(key, name, dueMs) {
			if (client) {
				const [actorType, ...rest] = key.split("/");
				return client
					.registerReminder({
						actorType: actorType || "Actor",
						actorId: rest.join("/") || key,
						name,
						dueTimeMs: dueMs,
					})
					.then((r) => {
						emit({
							type: "actor.ReminderRegistered",
							key,
							holderId: name,
							fenceToken: String(dueMs),
						});
						return r;
					});
			}
			const reminderId = `reminder-${++reminderSeq}`;
			emit({
				type: "actor.ReminderRegistered",
				key,
				holderId: name,
				fenceToken: String(dueMs),
			});
			return { reminderId };
		},

		events() {
			return lifecycle.slice();
		},
	};

	return Object.freeze(host);
}
