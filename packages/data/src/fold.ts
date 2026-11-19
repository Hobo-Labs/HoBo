import { fromJsonString } from "@bufbuild/protobuf";
import type { EventEnvelope, QuarantineRecord } from "@hobo/core";

import { AggregateQuarantinedEventDataSchema } from "./_generated/data_pb.js";
import { parseOffendingSeq } from "./json.js";
import { UpcasterChainError, type UpcasterRegistry } from "./upcaster.js";

export type Evolve<S> = (state: S, event: EventEnvelope) => S;
export type FoldFailureClassification = "deterministic" | "transient";
export type FoldFailureClassifier = (
	error: Error,
	event: EventEnvelope,
) => FoldFailureClassification;

export interface FoldSpec<S> {
	name?: string;
	initialState: S;
	evolve: Evolve<S>;
	upcasters?: UpcasterRegistry;
	classifyFailure?: FoldFailureClassifier;
}

export interface FoldOutcome<S> {
	state: S;
	seq: number;
	quarantined: QuarantineRecord[];
}

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return structuredClone(value);
}

export const AGGREGATE_QUARANTINE_EVENT = "aggregate.QuarantineRecorded";

export function shouldQuarantineFailure(
	error: Error,
	event: EventEnvelope,
	classify: FoldFailureClassifier | undefined,
): boolean {
	const result = classify
		? classify(error, Object.freeze(clone(event)))
		: "deterministic";
	if (result !== "deterministic" && result !== "transient") {
		throw new TypeError(
			"fold failure classification must be deterministic or transient",
		);
	}
	return result === "deterministic";
}

function isQuarantineFact(event: EventEnvelope): boolean {
	return (
		event.type.endsWith(".Quarantined") ||
		event.type === AGGREGATE_QUARANTINE_EVENT
	);
}

function quarantineApplies(
	event: EventEnvelope,
	name: string | undefined,
): boolean {
	if (event.type !== AGGREGATE_QUARANTINE_EVENT) return true;
	const data = fromJsonString(
		AggregateQuarantinedEventDataSchema,
		JSON.stringify(event.data),
	);
	return (
		name !== undefined && data.fold === name && data.foldKind === "aggregate"
	);
}

export function foldEvents<S>(
	events: Iterable<EventEnvelope>,
	spec: FoldSpec<S>,
): FoldOutcome<S> {
	const materialized = [...events];

	const quarantinedSeqs = new Set<number>();
	for (const event of materialized) {
		if (isQuarantineFact(event) && quarantineApplies(event, spec.name)) {
			const offending = parseOffendingSeq(event.data);
			if (offending !== undefined) quarantinedSeqs.add(offending);
		}
	}
	for (const event of materialized) {
		if (isQuarantineFact(event) || quarantinedSeqs.has(event.seq)) continue;
		spec.upcasters?.assertCanUpcast?.(event.type, event.v);
	}

	let state = clone(spec.initialState);
	let seq = 0;
	let nextQuarantineSeq = materialized.reduce(
		(head, event) => Math.max(head, event.seq),
		0,
	);
	const quarantined: QuarantineRecord[] = [];

	for (const event of materialized) {
		seq = Math.max(seq, event.seq);
		if (isQuarantineFact(event) || quarantinedSeqs.has(event.seq)) continue;

		try {
			const upcast = spec.upcasters ? spec.upcasters.upcast(event) : event;
			state = clone(spec.evolve(clone(state), Object.freeze(clone(upcast))));
		} catch (cause) {
			if (cause instanceof UpcasterChainError) throw cause;
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (!shouldQuarantineFailure(error, event, spec.classifyFailure))
				throw cause;
			quarantinedSeqs.add(event.seq);
			quarantined.push({
				offendingSeq: event.seq,
				quarantineSeq: ++nextQuarantineSeq,
				type: `${event.type.split(".")[0] ?? "event"}.Quarantined`,
				reason: error.message,
			});
		}
	}

	return { state: clone(state), seq, quarantined };
}
