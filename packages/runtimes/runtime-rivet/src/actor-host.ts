import {
	type ActorHost,
	type ActorLease,
	type ActorStateHandle,
	actorCommandDigest,
	actorCompoundKey,
	type FoldEvent,
	type LogicalActorIdentity,
	parseLogicalActorIdentity,
} from "@hobo/core";
import type { ActorLocalJournal } from "./journal.js";
import { cloneAsJson, type JsonValue, parseJsonValue } from "./json.js";
import { RivetJournalError } from "./types.js";

export interface RivetActorLease extends ActorLease {
	readonly placement: "rivet";
}

export type RivetActorStateHandle<S> = ActorStateHandle<S>;

export interface RivetActorHost extends ActorHost {
	readonly placementMode: "rivet";
	readonly fidelity: "local-sqlite" | "rivetkit";
	acquire(key: string, request: { holderId: string }): RivetActorLease;
	accept(input: {
		identity: JsonValue;
		commandId: string;
		commandType: string;
		payload: JsonValue;
		expectedRevision: number;
	}): { status: string; duplicate: boolean; digest: string };
	processNext(
		identity: JsonValue,
		fold: (state: JsonValue, event: FoldEvent) => JsonValue,
		initialState: JsonValue,
	): { revision: number; commandId: string } | undefined;
}

export class RivetLeaseConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RivetLeaseConflictError";
	}
}

export function createRivetActorHost(options: {
	journal: ActorLocalJournal;
	fidelity?: "local-sqlite" | "rivetkit";
}): RivetActorHost {
	const leases = new Map<string, RivetActorLease>();
	const journal = options.journal;
	let epoch = 0n;

	const streamIdFor = (identity: LogicalActorIdentity): string =>
		actorCompoundKey(identity).join("/");

	return {
		placementMode: "rivet",
		fidelity: options.fidelity ?? "local-sqlite",
		acquire(key, request) {
			const held = leases.get(key);
			if (held && held.holderId !== request.holderId) {
				throw new RivetLeaseConflictError(
					`rivet placement conflict for ${key}`,
				);
			}
			epoch += 1n;
			const lease: RivetActorLease = {
				key,
				holderId: request.holderId,
				fenceToken: epoch,
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
				placement: "rivet",
				release() {
					if (leases.get(key) === lease) leases.delete(key);
				},
			};
			leases.set(key, lease);
			return lease;
		},
		state(key, request) {
			const events: FoldEvent[] = [];
			return {
				append(lease, event) {
					if (leases.get(key) !== lease) {
						throw new RivetLeaseConflictError(`stale rivet lease for ${key}`);
					}
					events.push(event);
					return {
						streamId: key,
						seq: events.length,
						fenceToken: lease.fenceToken,
					};
				},
				read() {
					let state = request.initialState;
					for (const event of events) {
						state = request.fold(state, event);
					}
					return { streamId: key, seq: events.length, state };
				},
			};
		},
		accept(input) {
			const identity = parseLogicalActorIdentity(input.identity);
			const digest = actorCommandDigest({
				identity,
				commandId: input.commandId,
				commandType: input.commandType,
				payload: input.payload,
				expectedRevision: input.expectedRevision,
			});
			const accepted = journal.acceptCommand({
				streamId: streamIdFor(identity),
				commandId: input.commandId,
				digest,
				commandType: input.commandType,
				payloadJson: JSON.stringify(input.payload),
				expectedRevision: input.expectedRevision,
			});
			return { ...accepted, digest };
		},
		processNext(identityInput, fold, initialState) {
			const identity = parseLogicalActorIdentity(identityInput);
			const streamId = streamIdFor(identity);
			const claimed = journal.claimNext(streamId);
			if (!claimed) return undefined;
			const facts = journal.readFacts(streamId);
			let state = initialState;
			for (const fact of facts) {
				state = fold(state, {
					type: fact.type,
					payload: parseJsonValue(new TextDecoder().decode(fact.payload)),
				});
			}
			const decided = fold(state, {
				type: claimed.commandType,
				payload: parseJsonValue(claimed.payloadJson),
			});
			const payload = new TextEncoder().encode(JSON.stringify(decided));
			const committed = journal.commitCommand({
				streamId,
				commandId: claimed.commandId,
				expectedRevision: journal.head(streamId).revision,
				facts: [
					{
						type: claimed.commandType,
						eventId: claimed.commandId,
						payload,
						metadataJson: "{}",
						tenant: identity.tenantId,
						project: identity.projectId,
						...(identity.lane !== undefined
							? { lane: identity.lane }
							: undefined),
					},
				],
			});
			journal.completeCommand(
				streamId,
				claimed.commandId,
				JSON.stringify({ revision: committed.revision }),
			);
			return { revision: committed.revision, commandId: claimed.commandId };
		},
	};
}

export function rivetStreamId<T>(identity: T): string {
	return actorCompoundKey(
		parseLogicalActorIdentity(cloneAsJson(identity)),
	).join("/");
}

export function assertNoWaitTrue(
	options: { wait?: boolean } | undefined,
): void {
	if (options?.wait === true) {
		throw new RivetJournalError(
			"INBOX_CONFLICT",
			"actor-to-actor wait:true is forbidden (self-send deadlock)",
		);
	}
}
