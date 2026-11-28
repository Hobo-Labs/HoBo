export type PricingOrder = (left: string, right: string) => number;

export const codeUnitPricingOrder: PricingOrder = (left, right) =>
	left < right ? -1 : left > right ? 1 : 0;
