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

export function foldMeteredUsage(
	events: Iterable<{ type: string; data?: unknown }>,
): MeteredUsageFold {
	let spentUsd = 0;
	let sampleCount = 0;
	let unknownSampleCount = 0;
	for (const event of events) {
		if (event.type !== METER_USAGE_RECORDED_EVENT) continue;
		const data = cloneAsJson(event.data);
		const cost = isJsonObject(data) ? data.costUsd : undefined;
		if (isJsonNumber(cost) && Number.isFinite(cost) && cost >= 0) {
			spentUsd += cost;
			sampleCount += 1;
		} else unknownSampleCount += 1;
	}
	const usage: MeteredUsageFold = { spentUsd, sampleCount };
	if (unknownSampleCount) usage.unknownSampleCount = unknownSampleCount;
	return usage;
}

export function createMeteredBillingPlane(
	events:
		| Iterable<{ type: string; data?: unknown }>
		| (() => Iterable<{ type: string; data?: unknown }>),
): BillingPlane {
	// One shared single-writer plane owns admission. Cross-process deployments
	// use BudgetAdmissionAuthority backed by transactional storage instead.
	const held = new Map<string, { amount: number; digest: string }>();
	let lastSpentUsd = 0;
	let lastSampleCount = 0;
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
			const rows = [...readEvents()];
			const usage = foldMeteredUsage(rows);
			if (
				usage.unknownSampleCount ||
				usage.spentUsd < lastSpentUsd ||
				usage.sampleCount < lastSampleCount ||
				!Number.isFinite(usage.spentUsd)
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
			lastSpentUsd = usage.spentUsd;
			lastSampleCount = usage.sampleCount;
			for (const event of rows) {
				const data = cloneAsJson(event.data);
				if (!isJsonObject(data)) continue;
				if (
					event.type === METER_USAGE_RECORDED_EVENT &&
					data.finalized === true &&
					isJsonString(data.reservationId) &&
					isJsonNumber(data.costUsd) &&
					data.costUsd >= 0
				)
					held.delete(data.reservationId);
			}
			const digest = requestDigest ?? String(spendEstimateUsd);
			const previous = held.get(requestId);
			if (previous)
				return previous.amount === spendEstimateUsd &&
					previous.digest === digest
					? { ok: true, reasons: [] }
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
			if (
				!billing.spendCapUnlimited &&
				spendEstimateUsd > billing.spendCapUsd
			) {
				reasons.push({
					plane: "billing",
					code: "spend-cap-exceeded",
					message: `estimated spend ${spendEstimateUsd} USD exceeds per-resolution cap ${billing.spendCapUsd} USD`,
				});
			}
			const remaining =
				billing.budgetUsd -
				usage.spentUsd -
				[...held.values()].reduce((sum, entry) => sum + entry.amount, 0);
			if (!billing.budgetUnlimited && spendEstimateUsd > remaining) {
				reasons.push({
					plane: "billing",
					code: "budget-exceeded",
					message: `estimated spend ${spendEstimateUsd} USD exceeds metered remaining budget ${remaining} USD (${usage.spentUsd} USD observed across ${usage.sampleCount} meter.UsageRecorded facts)`,
				});
			}
			if (reasons.length === 0)
				held.set(requestId, { amount: spendEstimateUsd, digest });
			return { ok: reasons.length === 0, reasons };
		},
		release(requestId, confirmedUnused) {
			if (confirmedUnused !== true)
				throw new Error("confirmed unused funds required");
			held.delete(requestId);
		},
	};
}
