import type {
	ProviderAgreement,
	QuoteScenario,
} from "./_generated/pricing_pb.js";
import { PricingFault } from "./state.js";
import { utcMillis } from "./time-order.js";

function unsupported(): PricingFault {
	return new PricingFault(
		"PRICING_MODEL_UNSUPPORTED",
		"the quote must fit one unambiguous provider billing period",
	);
}

function periodIndex(
	anchor: number,
	instant: number,
	interval: string,
): number {
	if (instant < anchor) throw unsupported();
	if (interval === "daily" || interval === "weekly") {
		const elapsed = instant - anchor;
		if (!Number.isSafeInteger(elapsed)) throw unsupported();
		return Math.floor(
			elapsed / (interval === "daily" ? 86_400_000 : 604_800_000),
		);
	}
	const origin = new Date(anchor);
	const current = new Date(instant);
	const day = origin.getUTCDate();
	const month = origin.getUTCMonth();
	const year = origin.getUTCFullYear();
	const boundary = new Date(anchor);
	if (interval === "monthly") {
		if (day > 28) throw unsupported();
		let index =
			(current.getUTCFullYear() - year) * 12 + current.getUTCMonth() - month;
		boundary.setUTCFullYear(
			current.getUTCFullYear(),
			current.getUTCMonth(),
			day,
		);
		if (boundary.getTime() > instant) index--;
		return index;
	}
	if (interval === "yearly") {
		if (month === 1 && day === 29) throw unsupported();
		let index = current.getUTCFullYear() - year;
		boundary.setUTCFullYear(current.getUTCFullYear(), month, day);
		if (boundary.getTime() > instant) index--;
		return index;
	}
	throw unsupported();
}

function validatePeriod(
	agreement: ProviderAgreement,
	at: number,
	horizon: number,
): void {
	const period = agreement.billingPeriod;
	if (period === undefined || period.timeZone !== "UTC") throw unsupported();
	const anchor = utcMillis(period.anchor);
	if (
		periodIndex(anchor, at, period.interval) !==
		periodIndex(anchor, horizon, period.interval)
	)
		throw unsupported();
}

export function validateV2BillingPeriods(scenario: QuoteScenario): void {
	const state = scenario.state;
	if (state === undefined) throw unsupported();
	const at = utcMillis(scenario.at);
	const horizon = utcMillis(scenario.horizon);
	const used = new Set([
		...scenario.baseline.map((item) => item.agreementRef),
		...scenario.candidate.map((item) => item.agreementRef),
	]);
	for (const agreement of state.agreements)
		if (agreement.status === "active" || used.has(agreement.id))
			validatePeriod(agreement, at, horizon);
}
