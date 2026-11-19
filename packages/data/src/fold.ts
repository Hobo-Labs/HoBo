import type { EventEnvelope, QuarantineRecord } from "@hobo/core";
import type { QuarantineReprocessFinding } from "./_generated/data_pb.js";

import {
	parseAggregateQuarantine,
	parseEventStoreQuarantine,
	quarantineReprocessFinding,
	quarantineSequence,
} from "./quarantine-facts.js";

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
	classifyFailure?: FoldFailureClassifier;
	inspectQuarantines?: boolean;
}

export interface FoldOutcome<S> {
	state: S;
	seq: number;
	quarantined: QuarantineRecord[];
	reprocessCandidates?: QuarantineReprocessFinding[];
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

function quarantineTarget(
	event: EventEnvelope,
	name: string | undefined,
): number | undefined {
	if (event.type !== AGGREGATE_QUARANTINE_EVENT) {
		return quarantineSequence(parseEventStoreQuarantine(event).offendingSeq);
	}
	const data = parseAggregateQuarantine(event);
	return name !== undefined && data.fold === name
		? quarantineSequence(data.offendingSeq)
		: undefined;
}

export function foldEvents<S>(
	events: Iterable<EventEnvelope>,
	spec: FoldSpec<S>,
): FoldOutcome<S> {
	if (spec.inspectQuarantines && !spec.name) {
		throw new TypeError("a fold name is required to inspect quarantines");
	}
	const materialized = [...events];

	const quarantinedSeqs = new Set<number>();
	for (const event of materialized) {
		if (isQuarantineFact(event)) {
			const offending = quarantineTarget(event, spec.name);
			if (offending !== undefined) quarantinedSeqs.add(offending);
		}
	}
	let state = clone(spec.initialState);
	let seq = 0;
	let nextQuarantineSeq = materialized.reduce(
		(head, event) => Math.max(head, event.seq),
		0,
	);
	const quarantined: QuarantineRecord[] = [];
	const reprocessCandidates: QuarantineReprocessFinding[] = [];

	for (const event of materialized) {
		seq = Math.max(seq, event.seq);
		if (isQuarantineFact(event)) continue;
		if (quarantinedSeqs.has(event.seq)) {
			if (spec.inspectQuarantines && spec.name) {
				let processable = false;
				try {
					clone(spec.evolve(clone(state), Object.freeze(clone(event))));
					processable = true;
				} catch {}
				if (processable)
					reprocessCandidates.push(
						quarantineReprocessFinding(event, spec.name, "aggregate"),
					);
			}
			continue;
		}

		try {
			state = clone(spec.evolve(clone(state), Object.freeze(clone(event))));
		} catch (cause) {
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

	return {
		state: clone(state),
		seq,
		quarantined,
		...(spec.inspectQuarantines ? { reprocessCandidates } : undefined),
	};
}
