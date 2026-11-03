const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const DIVISION_SCALE = 18;

export type Decimal = Readonly<{
	coefficient: bigint;
	scale: number;
}>;

function powerOfTen(exponent: number): bigint {
	return 10n ** BigInt(exponent);
}

function normalize(coefficient: bigint, scale: number): Decimal {
	if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
	let normalizedCoefficient = coefficient;
	let normalizedScale = scale;
	while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
		normalizedCoefficient /= 10n;
		normalizedScale -= 1;
	}
	return { coefficient: normalizedCoefficient, scale: normalizedScale };
}

export function parseDecimal(value: string): Decimal | undefined {
	if (!DECIMAL_PATTERN.test(value)) return undefined;
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [integer = "", fraction = ""] = unsigned.split(".");
	const coefficient = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
	return normalize(coefficient, fraction.length);
}

export function decimalFromBigInt(value: bigint): Decimal {
	return { coefficient: value, scale: 0 };
}

export function formatDecimal(value: Decimal): string {
	const negative = value.coefficient < 0n;
	const digits = (negative ? -value.coefficient : value.coefficient)
		.toString()
		.padStart(value.scale + 1, "0");
	const integer = value.scale === 0 ? digits : digits.slice(0, -value.scale);
	const fraction = value.scale === 0 ? "" : `.${digits.slice(-value.scale)}`;
	return `${negative ? "-" : ""}${integer}${fraction}`;
}

function align(
	left: Decimal,
	right: Decimal,
): readonly [bigint, bigint, number] {
	const scale = Math.max(left.scale, right.scale);
	return [
		left.coefficient * powerOfTen(scale - left.scale),
		right.coefficient * powerOfTen(scale - right.scale),
		scale,
	];
}

export function compareDecimal(left: Decimal, right: Decimal): number {
	const [leftCoefficient, rightCoefficient] = align(left, right);
	return leftCoefficient < rightCoefficient
		? -1
		: leftCoefficient > rightCoefficient
			? 1
			: 0;
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
	const [leftCoefficient, rightCoefficient, scale] = align(left, right);
	return normalize(leftCoefficient + rightCoefficient, scale);
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
	const [leftCoefficient, rightCoefficient, scale] = align(left, right);
	return normalize(leftCoefficient - rightCoefficient, scale);
}

export function multiplyDecimal(left: Decimal, right: Decimal): Decimal {
	return normalize(
		left.coefficient * right.coefficient,
		left.scale + right.scale,
	);
}

export function negateDecimal(value: Decimal): Decimal {
	return { coefficient: -value.coefficient, scale: value.scale };
}

export function minDecimal(left: Decimal, right: Decimal): Decimal {
	return compareDecimal(left, right) <= 0 ? left : right;
}

export function maxDecimal(left: Decimal, right: Decimal): Decimal {
	return compareDecimal(left, right) >= 0 ? left : right;
}

function roundRatio(
	numerator: bigint,
	denominator: bigint,
	mode: "ceil" | "floor" | "half-up",
): bigint {
	let quotient = numerator / denominator;
	const remainder = numerator % denominator;
	if (remainder === 0n) return quotient;
	if (mode === "ceil" && numerator > 0n) quotient += 1n;
	if (mode === "floor" && numerator < 0n) quotient -= 1n;
	if (
		mode === "half-up" &&
		(remainder < 0n ? -remainder : remainder) * 2n >=
			(denominator < 0n ? -denominator : denominator)
	) {
		quotient += numerator < 0n ? -1n : 1n;
	}
	return quotient;
}

export function divideDecimal(
	left: Decimal,
	right: Decimal,
): Decimal | undefined {
	if (right.coefficient === 0n) return undefined;
	const numerator = left.coefficient * powerOfTen(right.scale + DIVISION_SCALE);
	const denominator = right.coefficient * powerOfTen(left.scale);
	return normalize(
		roundRatio(numerator, denominator, "half-up"),
		DIVISION_SCALE,
	);
}

export function roundDecimalToMultiple(
	value: Decimal,
	multiple: Decimal,
	mode: "ceil" | "floor" | "half-up",
): Decimal | undefined {
	if (multiple.coefficient <= 0n) return undefined;
	const numerator = value.coefficient * powerOfTen(multiple.scale);
	const denominator = multiple.coefficient * powerOfTen(value.scale);
	const multiples = roundRatio(numerator, denominator, mode);
	return normalize(multiples * multiple.coefficient, multiple.scale);
}

export const DECIMAL_ZERO: Decimal = Object.freeze({
	coefficient: 0n,
	scale: 0,
});
