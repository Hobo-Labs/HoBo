export const DECIMAL128_MAX_DIGITS = 34;
export const DECIMAL128_MIN_EXPONENT = -6176;
export const DECIMAL128_MAX_EXPONENT = 6111;

interface DecimalParts {
	readonly negative: boolean;
	readonly digits: string;
	readonly exponent: number;
}

const DECIMAL_TEXT = /^([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u;

function parseDecimalText(text: string): DecimalParts | undefined {
	const match = DECIMAL_TEXT.exec(text);
	if (match === null) return undefined;
	const fraction = match[3] ?? "";
	const digits = `${match[2] ?? ""}${fraction}`.replace(/^0+(?=[0-9])/u, "");
	const exponent = Number(match[4] ?? "0") - fraction.length;
	if (!Number.isSafeInteger(exponent)) return undefined;
	return { negative: match[1] === "-", digits, exponent };
}

function fitDecimal128(parts: DecimalParts): DecimalParts | undefined {
	let { digits, exponent } = parts;
	if (digits === "0") {
		exponent = Math.min(
			Math.max(exponent, DECIMAL128_MIN_EXPONENT),
			DECIMAL128_MAX_EXPONENT,
		);
		return { negative: parts.negative, digits, exponent };
	}
	while (
		(digits.length > DECIMAL128_MAX_DIGITS ||
			exponent < DECIMAL128_MIN_EXPONENT) &&
		digits.endsWith("0")
	) {
		digits = digits.slice(0, -1);
		exponent += 1;
	}
	if (
		digits.length > DECIMAL128_MAX_DIGITS ||
		exponent < DECIMAL128_MIN_EXPONENT
	) {
		return undefined;
	}
	if (exponent > DECIMAL128_MAX_EXPONENT) {
		const padding = exponent - DECIMAL128_MAX_EXPONENT;
		if (digits.length + padding > DECIMAL128_MAX_DIGITS) return undefined;
		digits = `${digits}${"0".repeat(padding)}`;
		exponent = DECIMAL128_MAX_EXPONENT;
	}
	return { negative: parts.negative, digits, exponent };
}

export function toDecimal128Text(canonical: string): string | undefined {
	const parts = parseDecimalText(canonical);
	if (parts === undefined) return undefined;
	const fitted = fitDecimal128(parts);
	if (fitted === undefined) return undefined;
	if (fitted.digits === parts.digits && fitted.exponent === parts.exponent) {
		return canonical;
	}
	const sign = fitted.negative ? "-" : "";
	return `${sign}${fitted.digits}E${fitted.exponent < 0 ? "" : "+"}${fitted.exponent}`;
}

export function formatDecimal128(text: string): string | undefined {
	const parsed = parseDecimalText(text);
	if (parsed === undefined) return undefined;
	const parts = fitDecimal128(parsed);
	if (parts === undefined) return undefined;
	const { digits, exponent } = parts;
	const sign = parts.negative ? "-" : "";
	const adjusted = exponent + digits.length - 1;
	if (exponent <= 0 && adjusted >= -6) {
		if (exponent === 0) return `${sign}${digits}`;
		const split = digits.length + exponent;
		return split > 0
			? `${sign}${digits.slice(0, split)}.${digits.slice(split)}`
			: `${sign}0.${"0".repeat(-split)}${digits}`;
	}
	const mantissa =
		digits.length === 1 ? digits : `${digits.slice(0, 1)}.${digits.slice(1)}`;
	return `${sign}${mantissa}E${adjusted < 0 ? "" : "+"}${adjusted}`;
}

/**
 * The plain decimal a printed Decimal128 denotes, or `undefined` for `NaN`,
 * the infinities, and anything else that is not a finite decimal. The result
 * is plain but not yet normalised; the canonical parser does that.
 */
export function fromDecimal128Text(text: string): string | undefined {
	const parts = parseDecimalText(text);
	if (parts === undefined) return undefined;
	const { digits, exponent } = parts;
	if (
		exponent > DECIMAL128_MAX_EXPONENT + DECIMAL128_MAX_DIGITS ||
		exponent < DECIMAL128_MIN_EXPONENT - DECIMAL128_MAX_DIGITS
	) {
		return undefined;
	}
	const sign = parts.negative ? "-" : "";
	if (exponent >= 0) return `${sign}${digits}${"0".repeat(exponent)}`;
	const split = digits.length + exponent;
	return split > 0
		? `${sign}${digits.slice(0, split)}.${digits.slice(split)}`
		: `${sign}0.${"0".repeat(-split)}${digits}`;
}
