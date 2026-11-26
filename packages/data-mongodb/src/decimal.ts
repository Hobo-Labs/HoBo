/**
 * Decimal128 text, without a BSON library.
 *
 * The canonical `decimal` is an arbitrary-precision plain decimal string.
 * BSON's Decimal128 is a coefficient of at most 34 digits and an exponent in
 * [-6176, 6111], and a server prints it in scientific notation whenever the
 * exponent is positive or the value is very small. Three pure functions cover
 * the trip: can this canonical value be held exactly, what does the server
 * print for it, and what plain decimal does a printed value denote.
 */

export const DECIMAL128_MAX_DIGITS = 34;
export const DECIMAL128_MIN_EXPONENT = -6176;
export const DECIMAL128_MAX_EXPONENT = 6111;

interface DecimalParts {
	readonly negative: boolean;
	/** Coefficient digits, no leading zeros (a zero coefficient is `0`). */
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

/**
 * Fit a coefficient and exponent into Decimal128 without changing the value:
 * trailing zeros may move into the exponent and back, nothing else may move.
 */
function fitDecimal128(parts: DecimalParts): DecimalParts | undefined {
	let { digits, exponent } = parts;
	if (digits === "0") {
		// Zero has every exponent; clamp into range.
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

/**
 * The text to hand a Decimal128 parser for a canonical decimal, or `undefined`
 * when the value cannot be held exactly. The canonical text itself is used
 * whenever it fits, so `1000` is stored as `1000` and not as `1E+3`.
 */
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

/**
 * What a MongoDB server prints for a Decimal128 parsed from `text` — the
 * IEEE 754-2008 scientific string. `undefined` when the text is not a finite
 * decimal or would need inexact rounding, which a driver refuses to send.
 */
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
