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

import type { ActorHost } from "./actor-host.js";
import {
	AggregateConflictError,
	AggregateInvariantError,
	AggregateStaleFenceError,
	isOptimisticConflict,
	isStaleFenceError,
} from "./errors.js";
import {
	createActorActivatedEvent,
	createActorPassivatedEvent,
	createActorStateAppendedEvent,
	type DataFact,
} from "./events.js";
import { type Evolve, foldEvents } from "./fold.js";
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
		initialState: definition.initialState,
		evolve: definition.evolve,
		upcasters: definition.upcasters,
	};

	async function load(store: EventStore, streamId: string) {
		const events = await readStream(store, streamId);
		const outcome = foldEvents(events, foldSpec);
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
					finalSeq = outcome.seq;
					return {
						streamId,
						seq: outcome.seq,
						state: outcome.state,
						appended: [],
						fenceToken: lease.fenceToken,
						lifecycle,
						quarantined: outcome.quarantined,
					};
				}

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
						throw new AggregateConflictError(streamId, outcome.seq);
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
					lastAppended === undefined ? outcome.seq : lastAppended.seq;

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
					appended,
					fenceToken: lease.fenceToken,
					lifecycle,
					quarantined: outcome.quarantined,
				};
			} finally {
				lease.release();
				lifecycle.push(createActorPassivatedEvent({ streamId, seq: finalSeq }));
			}
		},
	};
}

export { AggregateConflictError, AggregateInvariantError };
