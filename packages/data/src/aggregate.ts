import { create } from "@bufbuild/protobuf";
import { EVENTSTORE_LIMITS } from "@hobo/core";
import type {
	AppendOptions,
	DurableEffectInput,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	EventStore,
	PrincipalRef,
	QuarantineRecord,
} from "@hobo/core";

import { AggregateQuarantinedEventDataSchema } from "./_generated/data_pb.js";
import type { ActorHost } from "./actor-host.js";
import {
	AggregateConflictError,
	AggregateInvariantError,
	AggregateStaleFenceError,
	isOptimisticConflict,
	isStaleFenceError,
	UnpersistedQuarantineError,
} from "./errors.js";
import {
	createActorActivatedEvent,
	createActorPassivatedEvent,
	createActorStateAppendedEvent,
	type DataFact,
} from "./events.js";
import { AGGREGATE_QUARANTINE_EVENT, type Evolve, foldEvents } from "./fold.js";
import {
	hasFunctionTag,
	type Inspectable,
	isJsonString,
	type JsonObject,
} from "./json.js";
import type { UpcasterRegistry } from "./upcaster.js";

export interface EventEmitOptions {
	v?: number;
}

export interface CommandEmitter {
	emit(type: string, data?: JsonObject, options?: EventEmitOptions): void;
	stageEffect(effect: DurableEffectInput): void;
}

export type Decide<S, C> = (
	state: S,
	command: C,
	emitter: CommandEmitter,
) => void;

export interface AggregateDefinition<S, C> {
	name: string;
	initialState: S;
	evolve: Evolve<S>;
	decide: Decide<S, C>;
	upcasters?: UpcasterRegistry;
}

export interface CommandContext {
	tenant: string;
	actor: PrincipalRef;
	holderId?: string;
	project?: string;
	causationId?: string;
	correlationId?: string;
	lane?: string;
}

export interface CommandResult<S> {
	streamId: string;
	seq: number;
	state: S;
	appended: EventEnvelope[];
	fenceToken: bigint;
	lifecycle: DataFact[];
	quarantined: QuarantineRecord[];
}

export interface AggregateDeps {
	store: EventStore;
	actorHost: ActorHost;
}

export interface Aggregate<S, C> {
	readonly name: string;
	load(store: EventStore, streamId: string): Promise<{ state: S; seq: number }>;
	execute(
		deps: AggregateDeps,
		streamId: string,
		command: C,
		context: CommandContext,
	): Promise<CommandResult<S>>;
}

const EMPTY_EVENT_DATA: JsonObject = {};

async function readStream(
	store: EventStore,
	streamId: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) events.push(event);
	return events;
}

function parseFactType(type: Inspectable): string {
	if (!isJsonString(type) || !type.includes(".")) {
		throw new TypeError(
			`emitted fact type must be "aggregate.PastTenseFact"; got ${String(type)}`,
		);
	}
	return type;
}

function isDurableEventStore(store: EventStore): store is DurableEventStore {
	if (!("commit" in store)) return false;
	const commit = (store as DurableEventStore).commit;
	return hasFunctionTag(commit);
}

export function defineAggregate<S, C>(
	definition: AggregateDefinition<S, C>,
): Aggregate<S, C> {
	if (!definition.name) throw new TypeError("aggregate name is required");

	const foldSpec = {
		name: definition.name,
		initialState: definition.initialState,
		evolve: definition.evolve,
		upcasters: definition.upcasters,
	};

	async function load(store: EventStore, streamId: string) {
		const events = await readStream(store, streamId);
		const outcome = foldEvents(events, foldSpec);
		if (outcome.quarantined.length > 0)
			throw new UnpersistedQuarantineError(streamId, outcome.quarantined);
		return { state: outcome.state, seq: outcome.seq };
	}

	return {
		name: definition.name,

		load,

		async execute(deps, streamId, command, context) {
			const holderId = context.holderId ?? `${definition.name}:${streamId}`;
			const lease = deps.actorHost.acquire(streamId, { holderId });
			const lifecycle: DataFact[] = [
				createActorActivatedEvent({
					streamId,
					holderId,
					fenceToken: lease.fenceToken,
				}),
			];
			let finalSeq = 0;

			try {
				const events = await readStream(deps.store, streamId);
				const outcome = foldEvents(events, foldSpec);
				finalSeq = outcome.seq;
				const appendOptions: AppendOptions = {
					expectedSeq: outcome.seq,
					actor: context.actor,
					tenant: context.tenant,
					fenceToken: lease.fenceToken,
				};
				if (context.project !== undefined)
					appendOptions.project = context.project;
				if (context.causationId !== undefined)
					appendOptions.causationId = context.causationId;
				if (context.correlationId !== undefined)
					appendOptions.correlationId = context.correlationId;
				if (context.lane !== undefined) appendOptions.lane = context.lane;

				const eventsBySeq = new Map(events.map((event) => [event.seq, event]));
				const quarantineInputs: EventInput[] = outcome.quarantined.map(
					(entry) => {
						const offending = eventsBySeq.get(entry.offendingSeq);
						if (!offending)
							throw new Error("quarantine target is missing from the stream");
						const data = create(AggregateQuarantinedEventDataSchema, {
							offendingSeq: BigInt(offending.seq),
							offendingType: offending.type,
							offendingEventId: offending.id,
							fold: definition.name,
							foldKind: "aggregate",
							reason: entry.reason,
						});
						return {
							type: AGGREGATE_QUARANTINE_EVENT,
							data: {
								offendingSeq: Number(data.offendingSeq),
								offendingType: data.offendingType,
								offendingEventId: data.offendingEventId,
								fold: data.fold,
								foldKind: data.foldKind,
								reason: data.reason,
							},
							meta: {
								quarantines: offending.id,
								idempotencyKey: `aggregate-quarantine:${definition.name}:${offending.id}`,
							},
						};
					},
				);
				const quarantineEvents: EventEnvelope[] = [];
				const quarantined = outcome.quarantined.map((entry) => ({
					...entry,
					type: AGGREGATE_QUARANTINE_EVENT,
				}));
				for (
					let offset = 0;
					offset < quarantineInputs.length;
					offset += EVENTSTORE_LIMITS.maxBatchEvents
				) {
					const batch = quarantineInputs.slice(
						offset,
						offset + EVENTSTORE_LIMITS.maxBatchEvents,
					);
					try {
						const result = await deps.store.append(
							streamId,
							batch,
							appendOptions,
						);
						if (result.appended.length !== batch.length)
							throw new AggregateConflictError(
								streamId,
								appendOptions.expectedSeq,
							);
						quarantineEvents.push(...result.appended);
						appendOptions.expectedSeq =
							result.appended.at(-1)?.seq ?? appendOptions.expectedSeq;
						finalSeq = appendOptions.expectedSeq;
					} catch (error) {
						if (error instanceof Error && isOptimisticConflict(error))
							throw new AggregateConflictError(
								streamId,
								appendOptions.expectedSeq,
							);
						if (error instanceof Error && isStaleFenceError(error))
							throw new AggregateStaleFenceError(streamId);
						throw error;
					}
				}

				const staged: EventInput[] = [];
				const stagedEffects: DurableEffectInput[] = [];
				const emitter: CommandEmitter = {
					emit(type, data, options) {
						staged.push({
							type: parseFactType(type),
							v: options?.v ?? 1,
							data: data ?? EMPTY_EVENT_DATA,
						});
					},
					stageEffect(effect) {
						stagedEffects.push(effect);
					},
				};
				definition.decide(outcome.state, command, emitter);
				for (const event of staged) {
					definition.upcasters?.assertCanUpcast?.(event.type, event.v ?? 1);
				}

				if (staged.length === 0 && stagedEffects.length === 0) {
					if (quarantineEvents.length > 0)
						lifecycle.push(
							createActorStateAppendedEvent({
								streamId,
								seq: finalSeq,
								fenceToken: lease.fenceToken,
							}),
						);
					return {
						streamId,
						seq: finalSeq,
						state: outcome.state,
						appended: quarantineEvents,
						fenceToken: lease.fenceToken,
						lifecycle,
						quarantined,
					};
				}

				let appended: EventEnvelope[];
				try {
					if (isDurableEventStore(deps.store)) {
						const result = await deps.store.commit({
							streamId,
							events: staged,
							append: appendOptions,
							effects: stagedEffects,
						});
						appended = result.appended;
					} else if (staged.length === 0) {
						appended = [];
					} else {
						const result = await deps.store.append(
							streamId,
							staged,
							appendOptions,
						);
						appended = result.appended;
					}
				} catch (error) {
					if (error instanceof Error && isOptimisticConflict(error)) {
						throw new AggregateConflictError(
							streamId,
							appendOptions.expectedSeq,
						);
					}
					if (error instanceof Error && isStaleFenceError(error)) {
						throw new AggregateStaleFenceError(streamId);
					}
					throw error;
				}

				let state = outcome.state;
				for (const event of appended) {
					const upcast = definition.upcasters
						? definition.upcasters.upcast(event)
						: event;
					state = definition.evolve(state, upcast);
				}
				const lastAppended = appended.at(-1);
				const newSeq =
					lastAppended === undefined
						? appendOptions.expectedSeq
						: lastAppended.seq;

				finalSeq = newSeq;
				lifecycle.push(
					createActorStateAppendedEvent({
						streamId,
						seq: newSeq,
						fenceToken: lease.fenceToken,
					}),
				);

				return {
					streamId,
					seq: newSeq,
					state,
					appended: [...quarantineEvents, ...appended],
					fenceToken: lease.fenceToken,
					lifecycle,
					quarantined,
				};
			} finally {
				lease.release();
				lifecycle.push(createActorPassivatedEvent({ streamId, seq: finalSeq }));
			}
		},
	};
}

export { AggregateConflictError, AggregateInvariantError };
