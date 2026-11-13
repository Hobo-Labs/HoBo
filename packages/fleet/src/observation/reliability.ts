/**
 * How far a device can be trusted with work, from what happened to the work
 * it took (design §6.8 "Reliability is measured, not asserted"). Moved from
 * `packages/ci/src/mesh/reliability.ts`.
 *
 * A device that takes work and loses it (the sandbox never starts, it is
 * killed for memory, the device disappears mid-run, it refuses an order it
 * claimed) has dropped it. A device that gets the work started and keeps it
 * until it ends has delivered it, whatever the work's own result: a failing
 * test is the work's business, not the device's.
 *
 * The score is the share of recent work delivered. "Recent" is an exponential
 * decay: every half-life, what past work counts for is halved, so a score
 * recovers on its own once the drops stop. A device with no history is
 * trusted: the score starts at 1 with a few imaginary deliveries
 * (`priorWeight`) behind it, so one early drop does not halve its share.
 *
 * The authority computes the samples from the signed receipts it records
 * (`createReliabilityLedger`) and publishes them in the fleet view; a device
 * cannot raise its own score.
 */
import { create } from "@bufbuild/protobuf";
import {
	ReceiptStatus,
	type ReliabilitySamples,
	ReliabilitySamplesSchema,
	type WorkReceipt,
} from "../_generated/fleet_pb.js";
import { type MemberId, parseMemberId } from "../ids.js";

export type ReliabilityOutcome = "delivered" | "dropped";

/** Decayed counts of what happened to the work a device took. */
export type ReliabilityRecord = Readonly<{
	delivered: number;
	dropped: number;
	/** When the counts were last brought up to date (epoch ms). */
	atMs: number;
}>;

export type ReliabilityOptions = Readonly<{
	/** How long until past work counts for half as much. */
	halfLifeMs: number;
	/** Imaginary deliveries standing behind a device with no history. */
	priorWeight: number;
}>;

export const RELIABILITY_DEFAULTS: ReliabilityOptions = Object.freeze({
	halfLifeMs: 30 * 60_000,
	priorWeight: 4,
});

/**
 * The smallest share of its capacity a device is ranked with, however poor
 * its record, so real evidence keeps coming in and the score can recover.
 */
export const MIN_RELIABILITY = 0.05;

export function newReliability(nowMs: number): ReliabilityRecord {
	return { delivered: 0, dropped: 0, atMs: nowMs };
}

/** The same record as of `nowMs`: both counts faded by the time that passed. */
export function decayReliability(
	state: ReliabilityRecord,
	nowMs: number,
	options: ReliabilityOptions = RELIABILITY_DEFAULTS,
): ReliabilityRecord {
	const elapsedMs = nowMs - state.atMs;
	// A clock that stepped backwards changes nothing.
	if (!(elapsedMs > 0) || !(options.halfLifeMs > 0)) return state;
	const keep = 0.5 ** (elapsedMs / options.halfLifeMs);
	return {
		delivered: state.delivered * keep,
		dropped: state.dropped * keep,
		atMs: nowMs,
	};
}

/** The record after one more unit of work ended one way or the other. */
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

/**
 * The record after work counted as delivered at `deliveredAtMs` turned out to
 * be dropped: what is left of that delivery is taken back and a drop counted.
 */
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

/** The share of decayed samples delivered, with the prior behind it; in (0, 1]. */
export function scoreOfSamples(
	samples: Readonly<{ delivered: number; dropped: number }>,
	priorWeight: number = RELIABILITY_DEFAULTS.priorWeight,
): number {
	const prior = Math.max(0, priorWeight);
	const total = samples.delivered + samples.dropped + prior;
	// No history and no prior: nothing is known, so nothing is held against it.
	if (!(total > 0)) return 1;
	return (samples.delivered + prior) / total;
}

/** The share of recent work delivered as of `nowMs`, in (0, 1]. */
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

/**
 * The factor a device's copies are multiplied by when it is ranked. An
 * unusable score is full trust, as every device had before scores existed.
 */
export function reliabilityWeight(score: number | undefined): number {
	if (score === undefined || !Number.isFinite(score)) return 1;
	return Math.min(1, Math.max(MIN_RELIABILITY, score));
}

/** How many settled order ids the ledger remembers to count each receipt once. */
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

/**
 * The authority's ledger: each device's decayed delivered and dropped counts
 * from the receipts it records (§6.9). Its clock is the receipts: every
 * member is decayed to the newest receipt recorded, so a record recovers as
 * the fleet keeps working.
 *
 * `STARTED` counts a delivery; `SUCCEEDED` or `FAILED` count one only when
 * no start was recorded; `ABANDONED` or `REFUSED` count a drop, taking back
 * the start's delivery; `CANCELLED` counts nothing. Each order settles once.
 */
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
