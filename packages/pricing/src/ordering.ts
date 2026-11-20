export type PricingOrder = (left: string, right: string) => number;

export const legacyPricingOrder: PricingOrder = (left, right) =>
	left.localeCompare(right);

export const codeUnitPricingOrder: PricingOrder = (left, right) =>
	left < right ? -1 : left > right ? 1 : 0;
