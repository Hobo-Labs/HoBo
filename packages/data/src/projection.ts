import type { EventEnvelope, EventStore } from "@hobo/core";
import { ProjectionWriteError } from "./errors.js";
import {
	createProjectionDeclaredEvent,
	createProjectionLaggedEvent,
	createProjectionSinkReboundEvent,
	type DataFact,
} from "./events.js";
import {
	hasFunctionTag,
	type Inspectable,
	isObjectLike,
	parseOffendingSeq,
} from "./json.js";
import type { UpcasterRegistry } from "./upcaster.js";

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

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
	if (value === undefined || value === null) return value;
	// SAFETY: freeze walks own properties of object-like values; primitives return above.
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

export function defineProjection<Row>(
	definition: ProjectionDefinition<Row>,
): Projection<Row> {
	if (!definition.name) throw new TypeError("projection name is required");
	if (!hasFunctionTag(definition.key)) {
		throw new TypeError("projection key must be a function");
	}
	const handlers = new Map<string, ApplyHandler<Row>>(
		Object.entries(definition.on),
	);
	const readSet = Object.freeze([...handlers.keys()]);
	const reactivityClass = definition.reactivityClass ?? "reactive";

	function fold(events: Iterable<EventEnvelope>): ProjectionSnapshot<Row> {
		const rows: Record<string, Row> = {};
		const quarantinedSeqs = new Set<number>();
		const materialized = [...events];
		for (const event of materialized) {
			if (isQuarantineFact(event)) {
				const offending = parseOffendingSeq(event.data);
				if (offending !== undefined) quarantinedSeqs.add(offending);
			}
		}

		let seq = 0;
		for (const event of materialized) {
			seq = Math.max(seq, event.seq);
			if (isQuarantineFact(event) || quarantinedSeqs.has(event.seq)) continue;
			const handler = handlers.get(event.type);
			if (!handler) continue;
			const upcast = definition.upcasters
				? definition.upcasters.upcast(event)
				: event;
			const key = definition.key(upcast);
			const nextRow = handler(
				rows[key] === undefined ? undefined : deepFreeze(clone(rows[key])),
				deepFreeze(clone(upcast)),
			);
			rows[key] = clone(nextRow);
		}

		return { projection: definition.name, seq, rows };
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
