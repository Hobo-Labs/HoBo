import { create } from "@bufbuild/protobuf";
import {
	type AppendOptions,
	EVENTSTORE_LIMITS,
	type EventEnvelope,
	type EventInput,
	type EventStore,
	type PrincipalRef,
} from "@hobo/core";
import { ProjectionQuarantinedEventDataSchema } from "./_generated/data_pb.js";
import { isOptimisticConflict, ProjectionWriteError } from "./errors.js";
import {
	createProjectionDeclaredEvent,
	createProjectionLaggedEvent,
	createProjectionSinkReboundEvent,
	type DataFact,
} from "./events.js";
import { type FoldFailureClassifier, shouldQuarantineFailure } from "./fold.js";
import { hasFunctionTag, type Inspectable, isObjectLike } from "./json.js";
import {
	parseEventStoreQuarantine,
	parseProjectionQuarantine,
	quarantineSequence,
} from "./quarantine-facts.js";
import { UpcasterChainError, type UpcasterRegistry } from "./upcaster.js";

export type ApplyHandler<Row> = (
	row: Row | undefined,
	event: EventEnvelope,
) => Row;

export interface ProjectionDefinition<Row> {
	name: string;
	key: (event: EventEnvelope) => string;
	on: Record<string, ApplyHandler<Row>>;
	reactivityClass?: "reactive" | "non-reactive";
	upcasters?: UpcasterRegistry;
	classifyFailure?: FoldFailureClassifier;
}

export interface ProjectionSnapshot<Row> {
	projection: string;
	seq: number;
	rows: Record<string, Row>;
}

export interface Projection<Row> {
	readonly name: string;
	readonly readSet: readonly string[];
	fold(events: Iterable<EventEnvelope>): ProjectionSnapshot<Row>;
	rebuildFromZero(
		store: EventStore,
		streamId: string,
	): Promise<ProjectionSnapshot<Row>>;
	query(snapshot: ProjectionSnapshot<Row>): Row[];
	get(snapshot: ProjectionSnapshot<Row>, key: string): Row | undefined;
	snapshot(state: ProjectionSnapshot<Row>): ProjectionSnapshot<Row>;
	declared(): DataFact;
	lagged(lagSeq: number, bound: number): DataFact;
	rebound(matchDecidedRef: string): DataFact;
}

export interface ProjectionQuarantineOptions {
	quarantineStore: EventStore;
	quarantineStreamId: string;
	tenant: string;
	actor: PrincipalRef;
	fenceToken?: bigint;
}

export interface ProjectionQuarantineRecord {
	sourceStreamId: string;
	offendingSeq: number;
	offendingEventId: string;
	offendingType: string;
	reason: string;
	recordedSeq: number;
}

export interface QuarantinableProjection<Row> extends Projection<Row> {
	rebuildWithQuarantine(
		store: EventStore,
		streamId: string,
		options: ProjectionQuarantineOptions,
	): Promise<{
		snapshot: ProjectionSnapshot<Row>;
		quarantined: ProjectionQuarantineRecord[];
	}>;
}

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
	if (value === undefined || value === null) return value;
	const inspectable = value as Inspectable;
	if (!isObjectLike(inspectable) || Object.isFrozen(inspectable)) return value;
	Object.freeze(inspectable);
	if (Array.isArray(inspectable)) {
		for (const item of inspectable) deepFreeze(item);
		return value;
	}
	for (const key of Object.keys(inspectable)) {
		deepFreeze(inspectable[key]);
	}
	return value;
}

function isQuarantineFact(event: EventEnvelope): boolean {
	return event.type.endsWith(".Quarantined");
}

const PROJECTION_QUARANTINE_EVENT = "projection.QuarantineRecorded";

function eventKey(
	tenant: string,
	streamId: string,
	seq: number,
	eventId?: string,
): string {
	return JSON.stringify([tenant, streamId, seq, eventId ?? null]);
}

export function defineProjection<Row>(
	definition: ProjectionDefinition<Row>,
): QuarantinableProjection<Row> {
	if (!definition.name) throw new TypeError("projection name is required");
	if (!hasFunctionTag(definition.key)) {
		throw new TypeError("projection key must be a function");
	}
	const handlers = new Map<string, ApplyHandler<Row>>(
		Object.entries(definition.on),
	);
	const readSet = Object.freeze([...handlers.keys()]);
	const reactivityClass = definition.reactivityClass ?? "reactive";

	function foldInternal(
		materialized: readonly EventEnvelope[],
		records: readonly EventEnvelope[],
		collectFailures: boolean,
	) {
		const rows: Record<string, Row> = {};
		const quarantinedEvents = new Set<string>();
		for (const event of [...materialized, ...records]) {
			if (isQuarantineFact(event)) {
				const offending = quarantineSequence(
					parseEventStoreQuarantine(event).offendingSeq,
				);
				quarantinedEvents.add(
					eventKey(event.tenant, event.streamId, offending),
				);
			} else if (event.type === PROJECTION_QUARANTINE_EVENT) {
				const data = parseProjectionQuarantine(event);
				const offending = quarantineSequence(data.offendingSeq);
				if (data.projection === definition.name)
					quarantinedEvents.add(
						eventKey(
							event.tenant,
							data.sourceStreamId,
							offending,
							data.offendingEventId,
						),
					);
			}
		}

		let seq = 0;
		const failures: Array<{ event: EventEnvelope; reason: string }> = [];
		for (const event of materialized) {
			seq = Math.max(seq, event.seq);
			if (
				isQuarantineFact(event) ||
				event.type === PROJECTION_QUARANTINE_EVENT ||
				quarantinedEvents.has(
					eventKey(event.tenant, event.streamId, event.seq),
				) ||
				quarantinedEvents.has(
					eventKey(event.tenant, event.streamId, event.seq, event.id),
				)
			)
				continue;
			const handler = handlers.get(event.type);
			if (!handler) continue;
			try {
				const upcast = definition.upcasters
					? definition.upcasters.upcast(event)
					: event;
				const key = definition.key(upcast);
				const nextRow = handler(
					rows[key] === undefined ? undefined : deepFreeze(clone(rows[key])),
					deepFreeze(clone(upcast)),
				);
				rows[key] = clone(nextRow);
			} catch (error) {
				if (!collectFailures || error instanceof UpcasterChainError)
					throw error;
				const failure =
					error instanceof Error ? error : new Error(String(error));
				if (
					!shouldQuarantineFailure(failure, event, definition.classifyFailure)
				)
					throw error;
				failures.push({
					event,
					reason: failure.message,
				});
			}
		}

		return { snapshot: { projection: definition.name, seq, rows }, failures };
	}

	function fold(events: Iterable<EventEnvelope>): ProjectionSnapshot<Row> {
		return foldInternal([...events], [], false).snapshot;
	}

	return {
		name: definition.name,
		readSet,
		fold,

		async rebuildFromZero(store, streamId) {
			const events: EventEnvelope[] = [];
			for await (const event of store.read(streamId)) events.push(event);
			return fold(events);
		},

		async rebuildWithQuarantine(store, streamId, options) {
			if (
				!streamId.trim() ||
				!options.quarantineStreamId.trim() ||
				!options.tenant.trim()
			)
				throw new TypeError(
					"source stream, quarantine stream, and tenant are required",
				);
			if (
				store === options.quarantineStore &&
				streamId === options.quarantineStreamId
			)
				throw new TypeError("quarantine records require a separate stream");
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const events: EventEnvelope[] = [];
				for await (const event of store.read(streamId)) {
					if (
						event.tenant !== options.tenant ||
						event.streamId !== streamId ||
						event.seq !== events.length + 1
					)
						throw new Error(
							"source stream has an unexpected event or sequence",
						);
					events.push(event);
				}
				const bySeq = new Map(events.map((event) => [event.seq, event]));
				const records: EventEnvelope[] = [];
				const quarantined: ProjectionQuarantineRecord[] = [];
				let recordSeq = 0;
				for await (const record of options.quarantineStore.read(
					options.quarantineStreamId,
				)) {
					if (record.seq !== recordSeq + 1)
						throw new Error("quarantine stream has a sequence gap");
					recordSeq = record.seq;
					if (
						record.tenant !== options.tenant ||
						record.type !== PROJECTION_QUARANTINE_EVENT
					)
						throw new Error("quarantine stream contains an unexpected event");
					const data = parseProjectionQuarantine(record);
					if (
						data.projection !== definition.name ||
						data.sourceStreamId !== streamId
					)
						continue;
					const offendingSeq = Number(data.offendingSeq);
					const offending = bySeq.get(offendingSeq);
					if (
						!Number.isSafeInteger(offendingSeq) ||
						offendingSeq < 1 ||
						!offending ||
						offending.id !== data.offendingEventId ||
						offending.type !== data.offendingType
					)
						throw new Error(
							"projection quarantine target does not match the source event",
						);
					records.push(record);
					quarantined.push({
						sourceStreamId: streamId,
						offendingSeq,
						offendingEventId: offending.id,
						offendingType: offending.type,
						reason: data.reason,
						recordedSeq: record.seq,
					});
				}
				const result = foldInternal(events, records, true);
				if (result.failures.length === 0)
					return { snapshot: result.snapshot, quarantined };
				const inputs: EventInput[] = result.failures.map(
					({ event, reason }) => {
						const data = create(ProjectionQuarantinedEventDataSchema, {
							projection: definition.name,
							sourceStreamId: streamId,
							offendingSeq: BigInt(event.seq),
							offendingEventId: event.id,
							offendingType: event.type,
							reason,
						});
						return {
							type: PROJECTION_QUARANTINE_EVENT,
							data: {
								projection: data.projection,
								sourceStreamId: data.sourceStreamId,
								offendingSeq: Number(data.offendingSeq),
								offendingEventId: data.offendingEventId,
								offendingType: data.offendingType,
								reason: data.reason,
							},
							meta: {
								quarantines: event.id,
								idempotencyKey: `projection-quarantine:${definition.name}:${event.id}`,
							},
						};
					},
				);
				const appendOptions: AppendOptions = {
					expectedSeq: recordSeq,
					actor: options.actor,
					tenant: options.tenant,
				};
				if (options.fenceToken !== undefined)
					appendOptions.fenceToken = options.fenceToken;
				let retry = false;
				for (
					let offset = 0;
					offset < inputs.length;
					offset += EVENTSTORE_LIMITS.maxBatchEvents
				) {
					const batch = inputs.slice(
						offset,
						offset + EVENTSTORE_LIMITS.maxBatchEvents,
					);
					try {
						const appended = await options.quarantineStore.append(
							options.quarantineStreamId,
							batch,
							appendOptions,
						);
						if (appended.appended.length !== batch.length) {
							retry = true;
							break;
						}
						for (const record of appended.appended) {
						const data = parseProjectionQuarantine(record);
							quarantined.push({
								sourceStreamId: data.sourceStreamId,
								offendingSeq: Number(data.offendingSeq),
								offendingEventId: data.offendingEventId,
								offendingType: data.offendingType,
								reason: data.reason,
								recordedSeq: record.seq,
							});
						}
						appendOptions.expectedSeq =
							appended.appended.at(-1)?.seq ?? appendOptions.expectedSeq;
					} catch (error) {
						if (error instanceof Error && isOptimisticConflict(error)) {
							retry = true;
							break;
						}
						throw error;
					}
				}
				if (!retry) return { snapshot: result.snapshot, quarantined };
			}
			throw new Error(
				"projection quarantine stream remained busy after retries",
			);
		},

		query(snapshot) {
			return Object.values(snapshot.rows);
		},

		get(snapshot, key) {
			return snapshot.rows[key];
		},

		snapshot(state) {
			return clone(state);
		},

		declared() {
			return createProjectionDeclaredEvent({
				projection: definition.name,
				readSet,
				reactivityClass,
			});
		},

		lagged(lagSeq, bound) {
			return createProjectionLaggedEvent({
				projection: definition.name,
				lagSeq,
				bound,
			});
		},

		rebound(matchDecidedRef) {
			return createProjectionSinkReboundEvent({
				projection: definition.name,
				matchDecidedRef,
			});
		},
	};
}

export { ProjectionWriteError };
