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
import type { RivetOutboxEffectInput } from "./outbox.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
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
