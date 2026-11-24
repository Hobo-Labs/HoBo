import { create } from "@bufbuild/protobuf";
import {
	ReceiptStatus,
	type ReliabilitySamples,
	ReliabilitySamplesSchema,
	type WorkReceipt,
} from "../_generated/fleet_pb.js";
import { type MemberId, parseMemberId } from "../ids.js";

export type ReliabilityOutcome = "delivered" | "dropped";

export type ReliabilityRecord = Readonly<{
	delivered: number;
	dropped: number;
	atMs: number;
}>;

export type ReliabilityOptions = Readonly<{
	halfLifeMs: number;
	priorWeight: number;
}>;

export const RELIABILITY_DEFAULTS: ReliabilityOptions = Object.freeze({
	halfLifeMs: 30 * 60_000,
	priorWeight: 4,
});

export const MIN_RELIABILITY = 0.05;

export function newReliability(nowMs: number): ReliabilityRecord {
	return { delivered: 0, dropped: 0, atMs: nowMs };
}

export function decayReliability(
	state: ReliabilityRecord,
	nowMs: number,
	options: ReliabilityOptions = RELIABILITY_DEFAULTS,
): ReliabilityRecord {
	const elapsedMs = nowMs - state.atMs;
	if (!(elapsedMs > 0) || !(options.halfLifeMs > 0)) return state;
	const keep = 0.5 ** (elapsedMs / options.halfLifeMs);
	return {
		delivered: state.delivered * keep,
		dropped: state.dropped * keep,
		atMs: nowMs,
	};
}

export function recordOutcome(
	state: ReliabilityRecord,
	outcome: ReliabilityOutcome,
	nowMs: number,
	options: ReliabilityOptions = RELIABILITY_DEFAULTS,
): ReliabilityRecord {
	const current = decayReliability(state, nowMs, options);
	return outcome === "delivered"
		? { ...current, delivered: current.delivered + 1 }
		: { ...current, dropped: current.dropped + 1 };
}

export function retractDelivery(
	state: ReliabilityRecord,
	deliveredAtMs: number,
	nowMs: number,
	options: ReliabilityOptions = RELIABILITY_DEFAULTS,
): ReliabilityRecord {
	const current = decayReliability(state, nowMs, options);
	const elapsedMs = Math.max(0, nowMs - deliveredAtMs);
	const remaining =
		options.halfLifeMs > 0 ? 0.5 ** (elapsedMs / options.halfLifeMs) : 0;
	return {
		...current,
		delivered: Math.max(0, current.delivered - remaining),
		dropped: current.dropped + 1,
	};
}

export function scoreOfSamples(
	samples: Readonly<{ delivered: number; dropped: number }>,
	priorWeight: number = RELIABILITY_DEFAULTS.priorWeight,
): number {
	const prior = Math.max(0, priorWeight);
	const total = samples.delivered + samples.dropped + prior;
	if (!(total > 0)) return 1;
	return (samples.delivered + prior) / total;
}

export function reliabilityScore(
	state: ReliabilityRecord,
	nowMs: number,
	options: ReliabilityOptions = RELIABILITY_DEFAULTS,
): number {
	return scoreOfSamples(
		decayReliability(state, nowMs, options),
		options.priorWeight,
	);
}

export function reliabilityWeight(score: number | undefined): number {
	if (score === undefined || !Number.isFinite(score)) return 1;
	return Math.min(1, Math.max(MIN_RELIABILITY, score));
}

const SETTLED_LIMIT = 65_536;

function memberOf(receipt: WorkReceipt): MemberId | undefined {
	try {
		return parseMemberId(receipt.memberId);
	} catch {
		return undefined;
	}
}

export type ReliabilityLedger = Readonly<{
	record(receipt: WorkReceipt): void;
	samples(): ReadonlyMap<MemberId, ReliabilitySamples>;
}>;

export function reliabilityLedger(
	halfLifeMs: number = RELIABILITY_DEFAULTS.halfLifeMs,
): ReliabilityLedger {
	const options: ReliabilityOptions = {
		halfLifeMs,
		priorWeight: RELIABILITY_DEFAULTS.priorWeight,
	};
	const records = new Map<MemberId, ReliabilityRecord>();
	const started = new Map<
		string,
		Readonly<{ memberId: MemberId; atMs: number }>
	>();
	const settled = new Set<string>();
	let clockMs = Number.NEGATIVE_INFINITY;

	function settle(orderId: string): void {
		started.delete(orderId);
		settled.add(orderId);
		if (settled.size > SETTLED_LIMIT) {
			const oldest = settled.values().next();
			if (oldest.done !== true) settled.delete(oldest.value);
		}
	}

	function update(
		memberId: MemberId,
		atMs: number,
		change: (state: ReliabilityRecord) => ReliabilityRecord,
	): void {
		records.set(
			memberId,
			change(records.get(memberId) ?? newReliability(atMs)),
		);
	}

	return {
		record(receipt) {
			const atMs = Date.parse(receipt.at);
			const memberId = memberOf(receipt);
			if (!Number.isFinite(atMs) || memberId === undefined) return;
			if (settled.has(receipt.orderId)) return;
			clockMs = Math.max(clockMs, atMs);
			const start = started.get(receipt.orderId);
			switch (receipt.status) {
				case ReceiptStatus.STARTED:
					if (start !== undefined) return;
					if (started.size >= SETTLED_LIMIT) {
						const oldest = started.keys().next();
						if (oldest.done !== true) started.delete(oldest.value);
					}
					started.set(receipt.orderId, { memberId, atMs });
					update(memberId, atMs, (state) =>
						recordOutcome(state, "delivered", atMs, options),
					);
					return;
				case ReceiptStatus.SUCCEEDED:
				case ReceiptStatus.FAILED:
					settle(receipt.orderId);
					if (start === undefined)
						update(memberId, atMs, (state) =>
							recordOutcome(state, "delivered", atMs, options),
						);
					return;
				case ReceiptStatus.ABANDONED:
				case ReceiptStatus.REFUSED:
					settle(receipt.orderId);
					if (start === undefined)
						update(memberId, atMs, (state) =>
							recordOutcome(state, "dropped", atMs, options),
						);
					else
						update(start.memberId, atMs, (state) =>
							retractDelivery(state, start.atMs, atMs, options),
						);
					return;
				case ReceiptStatus.CANCELLED:
					settle(receipt.orderId);
					return;
				default:
					return;
			}
		},
		samples() {
			const out = new Map<MemberId, ReliabilitySamples>();
			for (const [memberId, state] of records) {
				const current = decayReliability(state, clockMs, options);
				out.set(
					memberId,
					create(ReliabilitySamplesSchema, {
						delivered: current.delivered,
						dropped: current.dropped,
					}),
				);
			}
			return out;
		},
	};
}
