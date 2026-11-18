import type { JsonValue } from "@hobo/core";
import type { MaterializedFrame } from "./reactor.js";

export type OptimisticSequence = Readonly<Record<string, number>>;

export interface OptimisticPatch<T> {
	readonly commandId: string;
	readonly seqFloor: OptimisticSequence;
	readonly apply: (value: T) => T;
}

export interface OptimisticView<T> extends MaterializedFrame<T> {
	readonly stale: boolean;
	readonly optimistic: boolean;
	readonly pendingCommands: readonly string[];
}

export type OptimisticAudit =
	| {
			readonly type: "optimistic.Applied" | "optimistic.AlreadySatisfied";
			readonly commandId: string;
			readonly seqFloor: OptimisticSequence;
	  }
	| {
			readonly type: "optimistic.Reconciled";
			readonly commandId: string;
			readonly seqFloor: OptimisticSequence;
			readonly authoritativeSeq: OptimisticSequence;
	  }
	| {
			readonly type: "optimistic.Rejected";
			readonly commandId: string;
			readonly reason: string;
	  };

export interface OptimisticSubscription<T> {
	current(): OptimisticView<T>;
	applyOptimisticPatch(patch: OptimisticPatch<T>): OptimisticView<T>;
	receiveAuthoritativePush(frame: MaterializedFrame<T>): OptimisticView<T>;
	rejectCommand(commandId: string, reason?: string): OptimisticView<T>;
	auditLog(): readonly OptimisticAudit[];
}

export class OptimisticSeqRegressionError extends Error {
	constructor(
		readonly subscriptionId: string,
		readonly streamId: string | null,
		readonly previousSeq: number,
		readonly seq: number | undefined,
	) {
		super(
			`optimistic subscription ${subscriptionId} regressed ${streamId ?? "materialization"}: previous=${previousSeq}, next=${seq}`,
		);
		this.name = "OptimisticSeqRegressionError";
	}
}

export function createOptimisticSubscription<T>(options: {
	readonly subscriptionId: string;
	readonly initial: MaterializedFrame<T>;
}): OptimisticSubscription<T> {
	const subscriptionId = nonEmpty(options.subscriptionId, "subscriptionId");
	let authoritative = normalizeFrame(options.initial);
	let pending: OptimisticPatch<T>[] = [];
	const audit: OptimisticAudit[] = [];

	return Object.freeze({
		current: () => project(authoritative, pending),
		applyOptimisticPatch(input: OptimisticPatch<T>): OptimisticView<T> {
			const commandId = nonEmpty(input.commandId, "commandId");
			const seqFloor = parseOptimisticSequence(input.seqFloor);
			if (Object.keys(seqFloor).length === 0)
				throw new TypeError("seqFloor must identify at least one stream");
			if (!(input.apply instanceof Function))
				throw new TypeError("optimistic patch apply must be a function");
			if (pending.some((patch) => patch.commandId === commandId))
				throw new Error(`duplicate optimistic command: ${commandId}`);
			if (isSatisfied(authoritative.streamSeqs, seqFloor)) {
				const view = project(authoritative, pending);
				audit.push({
					type: "optimistic.AlreadySatisfied",
					commandId,
					seqFloor,
				});
				return view;
			}
			const candidate = [
				...pending,
				{ commandId, seqFloor, apply: input.apply },
			];
			const view = project(authoritative, candidate);
			pending = candidate;
			audit.push({ type: "optimistic.Applied", commandId, seqFloor });
			return view;
		},
		receiveAuthoritativePush(frame: MaterializedFrame<T>): OptimisticView<T> {
			const next = normalizeFrame(frame);
			assertProgress(subscriptionId, authoritative, next);
			const reconciled = pending.filter((patch) =>
				isSatisfied(next.streamSeqs, patch.seqFloor),
			);
			const remaining = pending.filter(
				(patch) => !isSatisfied(next.streamSeqs, patch.seqFloor),
			);
			const view = project(next, remaining);
			authoritative = next;
			pending = remaining;
			for (const patch of reconciled)
				audit.push({
					type: "optimistic.Reconciled",
					commandId: patch.commandId,
					seqFloor: patch.seqFloor,
					authoritativeSeq: next.streamSeqs,
				});
			return view;
		},
		rejectCommand(commandId: string, reason = "rejected"): OptimisticView<T> {
			const id = nonEmpty(commandId, "commandId");
			const why = nonEmpty(reason, "reason");
			if (!pending.some((patch) => patch.commandId === id))
				throw new Error(`unknown pending optimistic command: ${id}`);
			const remaining = pending.filter((patch) => patch.commandId !== id);
			const view = project(authoritative, remaining);
			pending = remaining;
			audit.push({ type: "optimistic.Rejected", commandId: id, reason: why });
			return view;
		},
		auditLog: () => structuredClone(audit),
	});
}

function project<T>(
	frame: MaterializedFrame<T>,
	patches: readonly OptimisticPatch<T>[],
): OptimisticView<T> {
	const ordered = orderPatches(patches);
	let value = structuredClone(frame.value);
	for (const patch of ordered) value = structuredClone(patch.apply(value));
	return Object.freeze({
		value,
		seq: frame.seq,
		streamSeqs: frame.streamSeqs,
		stale: ordered.length > 0,
		optimistic: ordered.length > 0,
		pendingCommands: Object.freeze(ordered.map((patch) => patch.commandId)),
	});
}

function orderPatches<T>(
	patches: readonly OptimisticPatch<T>[],
): OptimisticPatch<T>[] {
	const remaining = [...patches];
	const ordered: OptimisticPatch<T>[] = [];
	while (remaining.length > 0) {
		const index = remaining.findIndex(
			(candidate) =>
				!remaining.some(
					(other) =>
						other !== candidate && precedes(other.seqFloor, candidate.seqFloor),
				),
		);
		if (index < 0) throw new Error("optimistic patch order is inconsistent");
		const selected = remaining.splice(index, 1)[0];
		if (!selected) throw new Error("optimistic patch order is inconsistent");
		ordered.push(selected);
	}
	return ordered;
}

function precedes(
	left: OptimisticSequence,
	right: OptimisticSequence,
): boolean {
	let less = false;
	for (const stream of new Set([...Object.keys(left), ...Object.keys(right)])) {
		const before = left[stream] ?? 0;
		const after = right[stream] ?? 0;
		if (before > after) return false;
		if (before < after) less = true;
	}
	return less;
}

function isSatisfied(
	candidate: OptimisticSequence,
	floor: OptimisticSequence,
): boolean {
	return Object.entries(floor).every(([stream, seq]) => {
		const observed = Object.hasOwn(candidate, stream)
			? candidate[stream]
			: undefined;
		return observed !== undefined && observed >= seq;
	});
}

function normalizeFrame<T>(frame: MaterializedFrame<T>): MaterializedFrame<T> {
	if (!Number.isSafeInteger(frame.seq) || frame.seq < 0)
		throw new TypeError("frame.seq must be a non-negative safe integer");
	return Object.freeze({
		value: structuredClone(frame.value),
		seq: frame.seq,
		streamSeqs: parseOptimisticSequence(frame.streamSeqs),
	});
}

export function parseOptimisticSequence(
	sequence: JsonValue,
): OptimisticSequence {
	if (
		!sequence ||
		Object.prototype.toString.call(sequence) !== "[object Object]"
	)
		throw new TypeError("stream sequence must be an object");
	const entries = Object.entries(sequence).map(([stream, seq]) => {
		nonEmpty(stream, "stream id");
		if (!Number.isSafeInteger(seq) || Number(seq) < 0)
			throw new TypeError(
				`sequence for ${stream} must be a non-negative safe integer`,
			);
		return [stream, Number(seq)] as const;
	});
	entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return Object.freeze(Object.fromEntries(entries));
}

function assertProgress<T>(
	id: string,
	previous: MaterializedFrame<T>,
	next: MaterializedFrame<T>,
): void {
	if (next.seq < previous.seq)
		throw new OptimisticSeqRegressionError(id, null, previous.seq, next.seq);
	for (const [stream, seq] of Object.entries(previous.streamSeqs)) {
		const nextSeq = Object.hasOwn(next.streamSeqs, stream)
			? next.streamSeqs[stream]
			: undefined;
		if (nextSeq === undefined || nextSeq < seq)
			throw new OptimisticSeqRegressionError(id, stream, seq, nextSeq);
	}
}

function nonEmpty(value: string, field: string): string {
	if (
		Object.prototype.toString.call(value) !== "[object String]" ||
		!value.trim()
	)
		throw new TypeError(`${field} must be a non-empty string`);
	return value;
}
