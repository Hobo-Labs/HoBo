import { createHash } from "node:crypto";

export type ExperimentFlagAllocation = Readonly<{
	name: string;
	variants: readonly string[];
	weights: Readonly<Record<string, number>>;
	strategy: "salted" | "fractional";
}>;

export function experimentAllocation(
	name: string,
	variants: readonly string[],
	weights?: Readonly<Record<string, number>>,
	strategy: "salted" | "fractional" = "salted",
): ExperimentFlagAllocation {
	if (strategy !== "salted" && strategy !== "fractional")
		throw new TypeError("experiment allocation strategy is invalid");
	if (
		!name ||
		variants.length === 0 ||
		variants.some((value) => !value) ||
		new Set(variants).size !== variants.length
	)
		throw new TypeError(
			"experiment requires a name and unique, non-empty variants",
		);
	if (
		weights &&
		Object.keys(weights).some((variant) => !variants.includes(variant))
	)
		throw new TypeError("experiment allocation names an unknown variant");
	const entries = variants.map(
		(variant) =>
			[
				variant,
				weights === undefined ? 100 / variants.length : (weights[variant] ?? 0),
			] as const,
	);
	if (
		entries.some(([, weight]) => !Number.isFinite(weight) || weight < 0) ||
		Math.abs(entries.reduce((total, [, weight]) => total + weight, 0) - 100) >
			0.000001
	)
		throw new TypeError(
			"experiment allocation weights must be non-negative and sum to 100",
		);
	return Object.freeze({
		name,
		variants: Object.freeze([...variants]),
		weights: Object.freeze(Object.fromEntries(entries)),
		strategy,
	});
}

export function bucket(targetingKey: string): number {
	let h = 0;
	for (let i = 0; i < targetingKey.length; i++) {
		h = (h * 31 + targetingKey.charCodeAt(i)) >>> 0;
	}
	return h % 100;
}

export function experimentRampBucket(
	allocation: ExperimentFlagAllocation,
	subjectKey: string,
): number {
	return hashBucket(["ramp", allocation.name, subjectKey]);
}

export function sameExperimentAllocation(
	a: ExperimentFlagAllocation,
	b: ExperimentFlagAllocation,
): boolean {
	return (
		a.name === b.name &&
		a.strategy === b.strategy &&
		a.variants.length === b.variants.length &&
		Object.keys(a.weights).length === a.variants.length &&
		Object.keys(b.weights).length === b.variants.length &&
		a.variants.every(
			(variant, index) =>
				b.variants[index] === variant &&
				Object.hasOwn(a.weights, variant) &&
				Object.hasOwn(b.weights, variant) &&
				a.weights[variant] === b.weights[variant],
		)
	);
}

function hashBucket(parts: readonly string[]): number {
	const digest = createHash("sha256").update(JSON.stringify(parts)).digest();
	return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

export function pickExperimentVariant(
	allocation: ExperimentFlagAllocation,
	subjectKey: string,
): string {
	const point =
		allocation.strategy === "fractional"
			? bucket(subjectKey)
			: hashBucket([allocation.name, subjectKey]);
	let cumulative = 0;
	for (const variant of allocation.variants) {
		cumulative += allocation.weights[variant] ?? 0;
		if (point < cumulative) return variant;
	}
	const last = allocation.variants.at(-1);
	if (last === undefined)
		throw new Error("experiment allocation has no variants");
	return last;
}
