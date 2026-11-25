// Durable ActorHost backed by @hobo/storage-sqlite actor_leases table.
// In-memory host remains the deterministic default for pure unit tests.

import {
	type ActorHost,
	type AggregateLease,
	LeaseConflictError,
} from "./actor-host.js";
import { isStaleFenceError } from "./errors.js";
import { parseNonEmptyString } from "./json.js";

export interface ActorLeaseGrant {
	key: string;
	holderId: string;
	fenceToken: bigint;
	expiresAt: string;
}

export interface ActorLeaseJournal {
	acquireActorLease(input: {
		key: string;
		holderId: string;
		leaseTtlMs?: number;
	}): ActorLeaseGrant;
	releaseActorLease(key: string, holderId: string, fenceToken: bigint): void;
}

export interface DurableActorHostOptions {
	journal: ActorLeaseJournal;
	leaseTtlMs?: number;
}

export function createDurableActorHost(
	options: DurableActorHostOptions,
): ActorHost {
	const leaseTtlMs = options.leaseTtlMs ?? 30_000;
	const journal = options.journal;

	return Object.freeze({
		acquire(key: string, request: { holderId: string }): AggregateLease {
			parseNonEmptyString(key, "key");
			const holderId = parseNonEmptyString(
				request?.holderId,
				"request.holderId",
			);
			try {
				const lease = journal.acquireActorLease({
					key,
					holderId,
					leaseTtlMs,
				});
				return Object.freeze({
					key: lease.key,
					holderId: lease.holderId,
					fenceToken: lease.fenceToken,
					expiresAt: lease.expiresAt,
					release() {
						journal.releaseActorLease(
							lease.key,
							lease.holderId,
							lease.fenceToken,
						);
					},
				});
			} catch (error) {
				if (error instanceof Error && isStaleFenceError(error)) {
					throw new LeaseConflictError(
						`lease conflict for ${key}: ${error.message}`,
					);
				}
				throw error;
			}
		},
	});
}
