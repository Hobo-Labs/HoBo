import { compareDecimal, type Decimal, formatDecimal } from "@hobo/pricing";
import type { BillingPolicy } from "./types.js";

// Number-valued fields use their serialized decimal value as their contract.
export function decimalFromNumber(value: number): Decimal | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	const [mantissa = "0", exponentText = "0"] = value.toString().split("e");
	const [integer = "0", fraction = ""] = mantissa.split(".");
	const scale = fraction.length - Number(exponentText);
	let coefficient = BigInt(integer + fraction);
	if (scale < 0) coefficient *= 10n ** BigInt(-scale);
	return { coefficient, scale: Math.max(scale, 0) };
}

export function upperNumber(value: Decimal): number | undefined {
	const candidate = Number(formatDecimal(value));
	if (!Number.isFinite(candidate)) return undefined;
	const represented = decimalFromNumber(candidate);
	if (represented === undefined) return undefined;
	if (compareDecimal(represented, value) >= 0) return candidate;
	if (candidate === 0) return Number.MIN_VALUE;
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setFloat64(0, candidate);
	view.setBigUint64(0, view.getBigUint64(0) + 1n);
	const upper = view.getFloat64(0);
	return Number.isFinite(upper) ? upper : undefined;
}

export function billingBounds(
	billing: BillingPolicy,
): { cap: Decimal | undefined; budget: Decimal | undefined } | undefined {
	const cap =
		billing.spendCapUnlimited === true
			? undefined
			: decimalFromNumber(billing.spendCapUsd);
	const budget =
		billing.budgetUnlimited === true
			? undefined
			: decimalFromNumber(billing.budgetUsd);
	if (
		(billing.spendCapUnlimited !== true && cap === undefined) ||
		(billing.budgetUnlimited !== true && budget === undefined)
	)
		return undefined;
	return { cap, budget };
}
