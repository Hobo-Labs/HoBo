// Decimal quantities arrive as protobuf JSON numbers. Retain their decimal
// representation until the final integer-microdollar ceiling is calculated.
function decimalParts(value: number) {
	if (!Number.isFinite(value) || value < 0)
		throw new Error("invalid allocation quantity");
	const [coefficient = "", exponentText = "0"] = value.toString().split("e");
	const [whole = "0", fraction = ""] = coefficient.split(".");
	return {
		digits: BigInt(`${whole}${fraction}`),
		scale: fraction.length - Number(exponentText),
	};
}

// A protobuf double must round-trip through JSON without claiming more free
// allocation than the exact decimal remainder. Descend representable values
// only when the serialized decimal would exceed that remainder.
function decimalAtMost(units: bigint, scale: number): number {
	let value = Number(`${units}e-${scale}`);
	for (;;) {
		const parsed = decimalParts(value);
		const larger =
			parsed.scale <= scale
				? parsed.digits * 10n ** BigInt(scale - parsed.scale) > units
				: parsed.digits > units * 10n ** BigInt(parsed.scale - scale);
		if (!larger) return value;
		const bits = new DataView(new ArrayBuffer(8));
		bits.setFloat64(0, value);
		bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
		value = bits.getFloat64(0);
	}
}

/** Convert base allocation units without rounding a persisted result upward. */
export function divideDecimalAtMost(value: number, divisor: number): number {
	if (
		!Number.isFinite(value) ||
		value < 0 ||
		value > Number.MAX_SAFE_INTEGER ||
		!Number.isSafeInteger(divisor) ||
		divisor < 1
	)
		throw new Error("invalid allocation conversion");
	const source = decimalParts(value);
	let result = value / divisor;
	for (;;) {
		const converted = decimalParts(result);
		const scale = Math.max(source.scale, converted.scale);
		const sourceUnits = source.digits * 10n ** BigInt(scale - source.scale);
		const convertedUnits =
			converted.digits *
			BigInt(divisor) *
			10n ** BigInt(scale - converted.scale);
		if (convertedUnits <= sourceUnits) return result;
		const bits = new DataView(new ArrayBuffer(8));
		bits.setFloat64(0, result);
		bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
		result = bits.getFloat64(0);
	}
}

/** Exact decimal accounting, internal to CI reservation and settlement. */
export function allocationQuote(
	available: number,
	consumed: readonly number[],
	minutes: number,
	price: number,
) {
	if (!Number.isSafeInteger(price) || price < 0)
		throw new Error("invalid allocation price");
	const parts = [available, minutes, ...consumed].map(decimalParts);
	const scale = parts.reduce((max, item) => Math.max(max, item.scale), 0);
	const denominator = 10n ** BigInt(scale);
	const toUnits = (item: { digits: bigint; scale: number }) =>
		item.digits * 10n ** BigInt(scale - item.scale);
	const first = parts[0];
	const duration = parts[1];
	if (!first || !duration) throw new Error("missing allocation quantity");
	const remaining = parts
		.slice(2)
		.reduce((sum, item) => sum - toUnits(item), toUnits(first));
	const freeUnits = remaining > 0n ? remaining : 0n;
	const bound = toUnits(duration);
	const reservedUnits = freeUnits < bound ? freeUnits : bound;
	const free = decimalAtMost(freeUnits, scale);
	const reservedFree = decimalAtMost(reservedUnits, scale);
	// Charge against the value we actually persist, not a more generous
	// unrepresentable fraction that would disappear on serialization.
	const persisted = decimalParts(reservedFree);
	const chargeScale = Math.max(scale, persisted.scale);
	const factor = 10n ** BigInt(chargeScale - scale);
	const chargeDenominator = denominator * factor;
	const persistedUnits =
		persisted.digits * 10n ** BigInt(chargeScale - persisted.scale);
	const paidNumerator = (bound * factor - persistedUnits) * BigInt(price);
	return {
		free,
		reservedFree,
		paid: Number((paidNumerator + chargeDenominator - 1n) / chargeDenominator),
	};
}
