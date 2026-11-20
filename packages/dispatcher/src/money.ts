import {
	addDecimal,
	compareDecimal,
	DECIMAL_ZERO,
	type Decimal,
	formatDecimal,
	maxDecimal,
	multiplyDecimal,
	subtractDecimal,
} from "@hobo/pricing";

function decimalFromNumberString(value: number): Decimal {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError("money input must be a finite non-negative number");
	}
	const [mantissa = "0", exponentText = "0"] = value.toString().split("e");
	const [integer = "0", fraction = ""] = mantissa.split(".");
	const exponent = Number(exponentText);
	const scale = fraction.length - exponent;
	let coefficient = BigInt(integer + fraction);
	if (scale < 0) coefficient *= 10n ** BigInt(-scale);
	return { coefficient, scale: Math.max(scale, 0) };
}

const decimal = decimalFromNumberString;

function adjacentFloat64Bits(value: number, direction: "up" | "down"): number {
	if (value === 0) return direction === "up" ? Number.MIN_VALUE : 0;
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setFloat64(0, value);
	const bits = view.getBigUint64(0);
	view.setBigUint64(0, direction === "up" ? bits + 1n : bits - 1n);
	return view.getFloat64(0);
}

function asNumberConservative(
	value: Decimal,
	direction: "up" | "down",
): number {
	const candidate = Number(formatDecimal(value));
	if (!Number.isFinite(candidate))
		return direction === "down" ? Number.MAX_VALUE : candidate;
	const comparison = compareDecimal(decimal(candidate), value);
	if (direction === "up" && comparison < 0)
		return adjacentFloat64Bits(candidate, "up");
	if (direction === "down" && comparison > 0)
		return adjacentFloat64Bits(candidate, "down");
	return candidate;
}

const asNumber = asNumberConservative;

export function costForUnits(
	units: number,
	freeUnits: number,
	unitCost: number,
	switchingCost: number,
): number {
	const paid = maxDecimal(
		subtractDecimal(decimal(units), decimal(freeUnits)),
		DECIMAL_ZERO,
	);
	return asNumber(
		addDecimal(
			multiplyDecimal(paid, decimal(unitCost)),
			decimal(switchingCost),
		),
		"up",
	);
}

export function addUpper(left: number, right: number): number {
	return asNumber(addDecimal(decimal(left), decimal(right)), "up");
}

export function subtractUpper(left: number, right: number): number {
	return asNumber(
		maxDecimal(subtractDecimal(decimal(left), decimal(right)), DECIMAL_ZERO),
		"up",
	);
}

export function addAvailable(left: number, right: number): number {
	return asNumber(addDecimal(decimal(left), decimal(right)), "down");
}

export function subtractAvailable(left: number, right: number): number {
	return asNumber(
		maxDecimal(subtractDecimal(decimal(left), decimal(right)), DECIMAL_ZERO),
		"down",
	);
}

export function availableCredits(
	aggregate: number | undefined,
	all: readonly number[],
	live: readonly number[],
): number {
	const sum = (values: readonly number[]) =>
		values.reduce(
			(total, value) => addDecimal(total, decimal(value)),
			DECIMAL_ZERO,
		);
	const liveTotal = sum(live);
	if (aggregate === undefined) return asNumber(liveTotal, "down");
	const cap = decimal(aggregate);
	const unallocated = maxDecimal(subtractDecimal(cap, sum(all)), DECIMAL_ZERO);
	const available = addDecimal(liveTotal, unallocated);
	return asNumber(compareDecimal(available, cap) < 0 ? available : cap, "down");
}

export function remainingMoney(
	cap: number,
	spent: number,
	held: number,
): number {
	const remaining = subtractDecimal(
		subtractDecimal(decimal(cap), decimal(spent)),
		decimal(held),
	);
	return asNumber(maxDecimal(remaining, DECIMAL_ZERO), "down");
}

export function moneySumExceeds(
	values: readonly number[],
	limit: number,
): boolean {
	const sum = values.reduce(
		(total, value) => addDecimal(total, decimal(value)),
		DECIMAL_ZERO,
	);
	return compareDecimal(sum, decimal(limit)) > 0;
}

export function chargeWithinBudget(
	units: number,
	freeUnits: number,
	unitCost: number,
	switchingCost: number,
	budgetCap: number,
	spendToDate: number,
	reservedCost: number,
): boolean {
	const paid = maxDecimal(
		subtractDecimal(decimal(units), decimal(freeUnits)),
		DECIMAL_ZERO,
	);
	const charge = addDecimal(
		multiplyDecimal(paid, decimal(unitCost)),
		decimal(switchingCost),
	);
	const remaining = maxDecimal(
		subtractDecimal(
			subtractDecimal(decimal(budgetCap), decimal(spendToDate)),
			decimal(reservedCost),
		),
		DECIMAL_ZERO,
	);
	return compareDecimal(charge, remaining) <= 0;
}

export function exposureWithinBudget(
	units: number,
	freeUnits: number,
	unitCost: number,
	switchingCost: number,
	estimatedCost: number | undefined,
	budgetCap: number,
	spendToDate: number,
	reservedCost: number,
): boolean {
	const paid = maxDecimal(
		subtractDecimal(decimal(units), decimal(freeUnits)),
		DECIMAL_ZERO,
	);
	const fromQuote = addDecimal(
		multiplyDecimal(paid, decimal(unitCost)),
		decimal(switchingCost),
	);
	let exposure = fromQuote;
	if (
		estimatedCost !== undefined &&
		Number.isFinite(estimatedCost) &&
		estimatedCost >= 0
	) {
		exposure = maxDecimal(exposure, decimal(estimatedCost));
	}
	const remaining = maxDecimal(
		subtractDecimal(
			subtractDecimal(decimal(budgetCap), decimal(spendToDate)),
			decimal(reservedCost),
		),
		DECIMAL_ZERO,
	);
	return compareDecimal(exposure, remaining) <= 0;
}
