import {
	addDecimal,
	compareDecimal,
	DECIMAL_ZERO,
	type Decimal,
	formatDecimal,
	subtractDecimal,
} from "@hobo/pricing";
import {
	billingBounds,
	decimalFromNumber,
	upperNumber,
} from "./billing-decimal.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";
import type { BillingPlane } from "./planes.js";
import type { RejectionReason } from "./types.js";

// Metering-backed billing plane: instead of trusting static policy fields for
// consumption, fold the Yard's `meter.UsageRecorded` facts (usage-metering.md)
// into observed spend, then authorize the estimate against what the budget
// has actually left. The event stream is truth; the fold rebuilds from zero.

// public-contract: the metering fact family the billing plane folds.
export const METER_USAGE_RECORDED_EVENT = "meter.UsageRecorded";

export interface MeteredUsageFold {
	spentUsd: number;
	sampleCount: number;
	unknownSampleCount?: number;
}

interface ExactMeteredUsage {
	spent: Decimal;
	sampleCount: number;
	unknownSampleCount: number;
	evidence: string[];
	finalized: Set<string>;
}

function foldExactMeteredUsage(
	events: Iterable<{ type: string; data?: unknown }>,
): ExactMeteredUsage {
	let spent = DECIMAL_ZERO;
	let sampleCount = 0;
	let unknownSampleCount = 0;
	const evidence: string[] = [];
	const finalized = new Set<string>();
	for (const event of events) {
		if (event.type !== METER_USAGE_RECORDED_EVENT) continue;
		const data = cloneAsJson(event.data);
		const cost = isJsonObject(data) ? data.costUsd : undefined;
		const amount = isJsonNumber(cost) ? decimalFromNumber(cost) : undefined;
		if (amount !== undefined && isJsonObject(data)) {
			spent = addDecimal(spent, amount);
			sampleCount += 1;
			const id =
				data.finalized === true && isJsonString(data.reservationId)
					? data.reservationId
					: null;
			evidence.push(JSON.stringify([cost, id]));
			if (id !== null) finalized.add(id);
		} else unknownSampleCount += 1;
	}
	return { spent, sampleCount, unknownSampleCount, evidence, finalized };
}

export function foldMeteredUsage(
	events: Iterable<{ type: string; data?: unknown }>,
): MeteredUsageFold {
	const usage = foldExactMeteredUsage(events);
	const result: MeteredUsageFold = {
		spentUsd: upperNumber(usage.spent) ?? Number.POSITIVE_INFINITY,
		sampleCount: usage.sampleCount,
	};
	if (usage.unknownSampleCount)
		result.unknownSampleCount = usage.unknownSampleCount;
	return result;
}

export function createMeteredBillingPlane(
	events:
		| Iterable<{ type: string; data?: unknown }>
		| (() => Iterable<{ type: string; data?: unknown }>),
): BillingPlane {
	// One shared single-writer plane owns admission. Cross-process deployments
	// use BudgetAdmissionAuthority backed by transactional storage instead.
	const held = new Map<
		string,
		{ amount: number; exactAmount: Decimal; digest: string }
	>();
	let observedEvidence: string[] = [];
	const readEvents = Array.isArray(events) ? () => events : events;
	if (!(readEvents instanceof Function))
		throw new TypeError(
			"provide a live event reader or array, not a consumable snapshot iterator",
		);
	return {
		authorize({ spendEstimateUsd, billing, requestId, requestDigest }) {
			const reasons: RejectionReason[] = [];
			if (
				!requestId ||
				!Number.isFinite(spendEstimateUsd) ||
				spendEstimateUsd < 0
			)
				return {
					ok: false,
					reasons: [
						{
							plane: "billing",
							code: "invalid-spend-estimate",
							message:
								"idempotent request identity and finite nonnegative estimate required",
						},
					],
				};
			const bounds = billingBounds(billing);
			if (bounds === undefined)
				return {
					ok: false,
					reasons: [
						{
							plane: "billing",
							code: "billing-policy-invalid",
							message:
								"bounded budget and spend cap must be finite and non-negative",
						},
					],
				};
			const rows = [...readEvents()];
			const usage = foldExactMeteredUsage(rows);
			if (
				usage.unknownSampleCount ||
				observedEvidence.some(
					(entry, index) => usage.evidence[index] !== entry,
				) ||
				upperNumber(usage.spent) === undefined
			)
				return {
					ok: false,
					reasons: [
						{
							plane: "billing",
							code: "metering-evidence-incomplete",
							message:
								"metering contains unknown charges or a regressed observation; reconcile before admitting spend",
						},
					],
				};
			observedEvidence = usage.evidence;
			for (const id of usage.finalized) held.delete(id);
			if (usage.finalized.has(requestId))
				return {
					ok: false,
					reasons: [
						{
							plane: "billing",
							code: "reservation-already-finalized",
							message: "request identity has already been finalized",
						},
					],
				};
			const digest = requestDigest ?? String(spendEstimateUsd);
			const previous = held.get(requestId);
			if (previous)
				return previous.amount === spendEstimateUsd &&
					previous.digest === digest
					? { ok: true, reasons: [], reservationCreated: false }
					: {
							ok: false,
							reasons: [
								{
									plane: "billing",
									code: "reservation-replay-mismatch",
									message: "request identity already authorizes different work",
								},
							],
						};
			const estimate = decimalFromNumber(spendEstimateUsd);
			if (estimate === undefined) throw new Error("invalid spend estimate");
			if (
				bounds.cap !== undefined &&
				compareDecimal(estimate, bounds.cap) > 0
			) {
				reasons.push({
					plane: "billing",
					code: "spend-cap-exceeded",
					message: `estimated spend ${spendEstimateUsd} USD exceeds per-resolution cap ${billing.spendCapUsd} USD`,
				});
			}
			const exposure = [...held.values()].reduce(
				(sum, entry) => addDecimal(sum, entry.exactAmount),
				usage.spent,
			);
			if (
				bounds.budget !== undefined &&
				compareDecimal(addDecimal(exposure, estimate), bounds.budget) > 0
			) {
				const remaining = subtractDecimal(bounds.budget, exposure);
				reasons.push({
					plane: "billing",
					code: "budget-exceeded",
					message: `estimated spend ${spendEstimateUsd} USD exceeds metered remaining budget ${formatDecimal(remaining)} USD (${formatDecimal(usage.spent)} USD observed across ${usage.sampleCount} meter.UsageRecorded facts)`,
				});
			}
			if (reasons.length === 0)
				held.set(requestId, {
					amount: spendEstimateUsd,
					exactAmount: estimate,
					digest,
				});
			return reasons.length === 0
				? { ok: true, reasons, reservationCreated: true }
				: { ok: false, reasons, noReservationCreated: true };
		},
		release(requestId, confirmedUnused) {
			if (confirmedUnused !== true)
				throw new Error("confirmed unused funds required");
			held.delete(requestId);
		},
	};
}
