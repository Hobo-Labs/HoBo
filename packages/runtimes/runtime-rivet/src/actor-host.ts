import { randomUUID } from "node:crypto";
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
import type { ActorLocalJournal, JournalFactRecord } from "./journal.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
import type { RivetOutboxEffectInput } from "./outbox.js";
import {
	type AcceptCommandResult,
	type InboxCommand,
	RivetJournalError,
} from "./types.js";

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
	}): AcceptCommandResult & { digest: string };
	processNext(
		identity: JsonValue,
		fold: (state: JsonValue, event: FoldEvent) => JsonValue,
		initialState: JsonValue,
		options?: {
			effects?: (
				state: JsonValue,
				event: FoldEvent,
			) => readonly RivetOutboxEffectInput[];
		},
	): { revision: number; commandId: string } | undefined;
}

export class RivetLeaseConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RivetLeaseConflictError";
	}
}

const ACTOR_STATE_METADATA = JSON.stringify({
	format: "hobo.rivet.actor-state/v1",
});

const COMMAND_EVENT_METADATA = JSON.stringify({
	format: "hobo.rivet.command-event/v1",
});

function foldJournalFacts(
	journal: ActorLocalJournal,
	streamId: string,
	facts: readonly JournalFactRecord[],
	initialState: JsonValue,
	fold: (state: JsonValue, event: FoldEvent) => JsonValue,
	legacyEventPayloads: "command" | "event" | undefined,
): JsonValue {
	let state = initialState;
	for (const fact of facts) {
		const payloadText = new TextDecoder().decode(fact.payload);
		const command =
			fact.metadataJson === "{}"
				? journal.loadCommand(streamId, fact.eventId)
				: undefined;
		if (
			legacyEventPayloads !== "event" &&
			command &&
			command.commandType === fact.type &&
			(command.status === "committed" || command.status === "completed")
		) {
			let legacyState: JsonValue | undefined;
			try {
				const candidate = fold(state, {
					type: fact.type,
					payload: parseJsonValue(command.payloadJson),
				});
				if (JSON.stringify(candidate) === payloadText) legacyState = candidate;
			} catch {}
			if (legacyState !== undefined) {
				let eventState: JsonValue | undefined;
				try {
					eventState = fold(state, {
						type: fact.type,
						payload: parseJsonValue(payloadText),
					});
				} catch {}
				if (
					eventState === undefined ||
					JSON.stringify(eventState) === payloadText ||
					legacyEventPayloads === "command"
				) {
					state = legacyState;
					continue;
				}
				throw new RivetJournalError(
					"PARSE",
					`ambiguous legacy event payload at ${streamId}:${fact.seq}; choose legacyEventPayloads`,
				);
			}
		}
		state = fold(state, {
			type: fact.type,
			payload: parseJsonValue(payloadText),
		});
	}
	return state;
}

function completeCommittedCommand(
	journal: ActorLocalJournal,
	streamId: string,
	command: InboxCommand,
) {
	let revision: number;
	if (command.resultJson !== undefined) {
		const receipt = parseJsonValue(command.resultJson);
		if (
			!isJsonObject(receipt) ||
			!isJsonNumber(receipt.revision) ||
			!Number.isSafeInteger(receipt.revision) ||
			receipt.revision < 0
		)
			throw new RivetJournalError(
				"PARSE",
				`invalid committed receipt for command ${command.commandId}`,
			);
		revision = receipt.revision;
	} else {
		const facts = journal
			.readFacts(streamId)
			.filter(
				(fact) =>
					fact.eventId === command.commandId &&
					fact.type === command.commandType,
			);
		const [fact] = facts;
		if (facts.length !== 1 || fact === undefined)
			throw new RivetJournalError(
				"INBOX_CONFLICT",
				`cannot recover committed revision for command ${command.commandId}`,
			);
		revision = fact.seq;
	}
	if (command.status === "committed")
		journal.completeCommand(
			streamId,
			command.commandId,
			JSON.stringify({ revision }),
		);
	return { revision, commandId: command.commandId };
}

function rejectStaleCommand(
	journal: ActorLocalJournal,
	streamId: string,
	command: InboxCommand,
	actualRevision: number,
) {
	const receipt = JSON.stringify({
		code: "STALE_REVISION",
		expectedRevision: command.expectedRevision,
		actualRevision,
	});
	if (!journal.rejectCommand(streamId, command.commandId, receipt)) {
		const current = journal.loadCommand(streamId, command.commandId);
		if (
			current &&
			(current.status === "committed" || current.status === "completed")
		)
			return completeCommittedCommand(journal, streamId, current);
		throw new RivetJournalError(
			"INBOX_CONFLICT",
			`command ${command.commandId} is not pending`,
		);
	}
	throw new RivetJournalError(
		"STALE_REVISION",
		`expected revision ${command.expectedRevision}, found ${actualRevision}`,
	);
}

export function createRivetActorHost(options: {
	journal: ActorLocalJournal;
	fidelity?: "local-sqlite" | "rivetkit";
	legacyEventPayloads?: "command" | "event" | undefined;
	tenantId?: string;
	nowMs?: () => number;
	leaseTtlMs?: number;
}): RivetActorHost {
	const leases = new Map<
		string,
		{ lease: RivetActorLease; holderId: string; fenceToken: bigint }
	>();
	const journal = options.journal;
	const tenantId = options.tenantId ?? "local";
	const leaseTtlMs = options.leaseTtlMs ?? 30_000;
	if (!tenantId.trim() || !Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0)
		throw new RivetJournalError("PARSE", "invalid actor host options");
	const nowMs = options.nowMs ?? Date.now;
	const stateStreamId = (key: string) => {
		if (!key.trim())
			throw new RivetJournalError("PARSE", "actor key is required");
		return `rivet:state:${JSON.stringify([tenantId, key])}`;
	};

	const streamIdFor = (identity: LogicalActorIdentity): string =>
		actorCompoundKey(identity).join("/");

	return {
		placementMode: "rivet",
		fidelity: options.fidelity ?? "local-sqlite",
		acquire(key, request) {
			const streamId = stateStreamId(key);
			const holderId = request.holderId;
			const now = nowMs();
			const expiresAt = new Date(now + leaseTtlMs).toISOString();
			const acquired = journal.acquireLease(
				streamId,
				holderId,
				now,
				leaseTtlMs,
			);
			if (!acquired)
				throw new RivetLeaseConflictError(
					`rivet placement conflict for ${key}`,
				);
			const lease: RivetActorLease = Object.freeze<RivetActorLease>({
				key,
				holderId,
				fenceToken: acquired.fenceToken,
				expiresAt,
				placement: "rivet",
				release() {
					journal.releaseLease(streamId, holderId, acquired.fenceToken);
					if (leases.get(key)?.lease === lease) leases.delete(key);
				},
			});
			leases.set(key, { lease, holderId, fenceToken: acquired.fenceToken });
			return lease;
		},
		state(key, request) {
			const streamId = stateStreamId(key);
			return {
				append(lease, event) {
					const current = leases.get(key);
					if (!current || current.lease !== lease)
						throw new RivetLeaseConflictError(`stale rivet lease for ${key}`);
					const record = cloneAsJson(event);
					if (
						!isJsonObject(record) ||
						!isJsonString(record.type) ||
						!record.type.trim()
					)
						throw new RivetJournalError(
							"PARSE",
							"actor event type is required",
						);
					const appended = journal.appendLeased(
						streamId,
						current.holderId,
						current.fenceToken,
						nowMs(),
						[
							{
								type: record.type,
								eventId: randomUUID(),
								payload: new TextEncoder().encode(JSON.stringify(record)),
								metadataJson: ACTOR_STATE_METADATA,
								tenant: tenantId,
							},
						],
					);
					if (!appended)
						throw new RivetLeaseConflictError(`stale rivet lease for ${key}`);
					return {
						streamId: key,
						seq: appended.revision,
						fenceToken: current.fenceToken,
					};
				},
				read() {
					const facts = journal.readFacts(streamId);
					let state = request.initialState;
					for (const fact of facts) {
						const event = parseJsonValue(
							new TextDecoder().decode(fact.payload),
						);
						if (
							fact.metadataJson !== ACTOR_STATE_METADATA ||
							!isJsonObject(event) ||
							!isJsonString(event.type) ||
							event.type !== fact.type
						)
							throw new RivetJournalError(
								"PARSE",
								`invalid actor state event at ${key}:${fact.seq}`,
							);
						const record: JsonObject = event;
						state = request.fold(state, { ...record, type: fact.type });
					}
					return { streamId: key, seq: facts.at(-1)?.seq ?? 0, state };
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
		processNext(identityInput, fold, initialState, commandOptions) {
			const identity = parseLogicalActorIdentity(identityInput);
			const streamId = streamIdFor(identity);
			const claimed = journal.claimNext(streamId);
			if (!claimed) return undefined;
			if (claimed.status === "committed")
				return completeCommittedCommand(journal, streamId, claimed);
			const facts = journal.readFacts(streamId);
			const replayedRevision = facts.at(-1)?.seq ?? 0;
			if (replayedRevision !== claimed.expectedRevision)
				return rejectStaleCommand(journal, streamId, claimed, replayedRevision);
			const state = foldJournalFacts(
				journal,
				streamId,
				facts,
				initialState,
				fold,
				options.legacyEventPayloads,
			);
			const event: FoldEvent = {
				type: claimed.commandType,
				payload: parseJsonValue(claimed.payloadJson),
			};
			const nextState = fold(state, event);
			const effects = commandOptions?.effects?.(nextState, event) ?? [];
			const payload = new TextEncoder().encode(claimed.payloadJson);
			let committed: { revision: number };
			try {
				committed = journal.commitCommand({
					streamId,
					commandId: claimed.commandId,
					expectedRevision: replayedRevision,
					effects,
					facts: [
						{
							type: claimed.commandType,
							eventId: claimed.commandId,
							payload,
							metadataJson: COMMAND_EVENT_METADATA,
							tenant: identity.tenantId,
							project: identity.projectId,
							...(identity.lane !== undefined
								? { lane: identity.lane }
								: undefined),
						},
					],
				});
			} catch (error) {
				if (
					error instanceof RivetJournalError &&
					error.code === "STALE_REVISION"
				)
					return rejectStaleCommand(
						journal,
						streamId,
						claimed,
						journal.head(streamId).revision,
					);
				if (
					error instanceof RivetJournalError &&
					error.code === "INBOX_CONFLICT"
				) {
					const current = journal.loadCommand(streamId, claimed.commandId);
					if (
						current &&
						(current.status === "committed" || current.status === "completed")
					)
						return completeCommittedCommand(journal, streamId, current);
				}
				throw error;
			}
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
