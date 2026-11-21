import type {
	Commitment,
	CreditGrant,
	EffectiveInterval,
	Evidence,
	QuoteScenario,
} from "./_generated/pricing_pb.js";
import { legacyPricingOrder } from "./ordering.js";

export type PricingTimeOrder = (
	left: string | undefined,
	right: string | undefined,
) => number;

export const legacyPricingTimeOrder: PricingTimeOrder = (left, right) =>
	legacyPricingOrder(left ?? "9999", right ?? "9999");

export function utcMillis(value: string): number {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/u.exec(
		value,
	);
	if (!match)
		throw new TypeError("pricing timestamps require UTC millisecond precision");
	const parsed = Date.parse(value);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString().slice(0, 19) !== match[1]
	)
		throw new TypeError("pricing timestamp is not a valid UTC instant");
	return parsed;
}

export const utcPricingTimeOrder: PricingTimeOrder = (left, right) => {
	if (left === undefined) return right === undefined ? 0 : 1;
	if (right === undefined) return -1;
	const a = utcMillis(left);
	const b = utcMillis(right);
	return a < b ? -1 : a > b ? 1 : 0;
};

export function validateV2ScenarioTimes(scenario: QuoteScenario): void {
	const time = (value: string | undefined) => {
		if (value !== undefined && value !== "") utcMillis(value);
	};
	const interval = (value: EffectiveInterval | undefined) => {
		if (value === undefined) return;
		time(value.start);
		time(value.end);
	};
	const evidence = (value: Evidence | undefined) => {
		if (value === undefined) return;
		time(value.observedAt);
		time(value.validFrom);
		time(value.validUntil);
	};
	const grant = (value: CreditGrant | undefined) => {
		if (value === undefined) return;
		interval(value.effective);
		evidence(value.evidence);
	};
	const commitment = (value: Commitment | undefined) => {
		if (value === undefined) return;
		interval(value.term);
		evidence(value.evidence);
	};
	time(scenario.at);
	time(scenario.horizon);
	for (const card of scenario.catalog?.rateCards ?? [])
		interval(card.effective);
	for (const item of scenario.catalog?.allowances ?? []) {
		interval(item.effective);
		evidence(item.evidence);
	}
	for (const item of scenario.catalog?.credits ?? []) grant(item);
	for (const item of scenario.catalog?.commitments ?? []) commitment(item);
	const state = scenario.state;
	time(state?.asOf);
	for (const agreement of state?.agreements ?? []) {
		interval(agreement.term);
		time(agreement.billingPeriod?.anchor);
		evidence(agreement.evidence);
		for (const entry of agreement.rateSchedule) interval(entry.effective);
	}
	for (const item of state?.allowances ?? []) {
		interval(item.grant?.effective);
		evidence(item.grant?.evidence);
	}
	for (const item of state?.credits ?? []) grant(item.grant);
	for (const item of state?.commitments ?? []) commitment(item.commitment);
	for (const item of state?.periodActuals ?? []) time(item.observedAt);
	for (const item of state?.observations ?? []) {
		time(item.observedAt);
		time(item.validUntil);
	}
	for (const workload of [...scenario.baseline, ...scenario.candidate])
		for (const measurement of workload.usage) utcMillis(measurement.observedAt);
	for (const measurement of scenario.options?.allocationForecast ?? [])
		utcMillis(measurement.observedAt);
}
