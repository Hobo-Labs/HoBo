// The aggregate's consistency boundary is realized as an actor: a single-writer
// lease with a monotonic fencing token (data-plane.md "Two folds, one log"). The
// port is the canonical `@hobo/core` actor-host port (ADR-0156): `AggregateLease`
// is core's `ActorLease` and this package's `ActorHost` is core's lease-only
// `ActorLeaseHost` narrowing, so the kernel keeps depending inward only; a
// runtime supplies the real, durable implementation and the in-memory host below
// is the deterministic default for tests and `hobo dev`.

import type {
	ActorLeaseHost as ActorHost,
	ActorLease as AggregateLease,
} from "@hobo/core";

import { parseNonEmptyString } from "./json.js";

export type {
	ActorLease as AggregateLease,
	ActorLeaseHost as ActorHost,
} from "@hobo/core";

export class LeaseConflictError extends Error {
	readonly code = "LEASE_CONFLICT" as const;
	constructor(message: string) {
		super(message);
		this.name = "LeaseConflictError";
	}
}

interface ManualClock {
	nowMs(): number;
	now(): string;
}

function systemClock(): ManualClock {
	return {
		nowMs: () => Date.now(),
		now: () => new Date().toISOString(),
	};
}

interface LeaseRecord {
	key: string;
	holderId: string;
	fenceToken: bigint;
	expiresAtMs: number;
	released: boolean;
}

export interface InMemoryActorHostOptions {
	clock?: ManualClock;
	leaseTtlMs?: number;
}

export function createInMemoryActorHost(
	options: InMemoryActorHostOptions = {},
): ActorHost {
	const clock = options.clock ?? systemClock();
	const leaseTtlMs = options.leaseTtlMs ?? 30_000;
	const leases = new Map<string, LeaseRecord>();

	return Object.freeze({
		acquire(key: string, request: { holderId: string }): AggregateLease {
			parseNonEmptyString(key, "key");
			const holderId = parseNonEmptyString(
				request?.holderId,
				"request.holderId",
			);
			const nowMs = clock.nowMs();
			const current = leases.get(key);
			if (current && !current.released && current.expiresAtMs > nowMs) {
				throw new LeaseConflictError(
					`lease conflict for ${key}: held by ${current.holderId} until ${new Date(current.expiresAtMs).toISOString()}`,
				);
			}

			const record: LeaseRecord = {
				key,
				holderId,
				fenceToken: (current?.fenceToken ?? 0n) + 1n,
				expiresAtMs: nowMs + leaseTtlMs,
				released: false,
			};
			leases.set(key, record);

			return Object.freeze({
				key,
				holderId,
				fenceToken: record.fenceToken,
				expiresAt: new Date(record.expiresAtMs).toISOString(),
				release() {
					if (leases.get(key) === record) record.released = true;
				},
			});
		},
	});
}
