import { types } from "node:util";

const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;

const isProxy = types.isProxy;
const hasOwnDescriptor = Object.hasOwn;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: this is the bounded structural boundary for untrusted receipt data. */
export function boundedFinancialReceipt(input: unknown): boolean {
	const budget = { nodes: 16_384, text: 0 };
	const ancestors = new Set<object>();
	const visit = (value: unknown, depth: number): boolean => {
		if (--budget.nodes < 0 || depth > 32) return false;
		if (value === undefined || value === null || typeof value === "boolean")
			return true;
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "string") {
			budget.text += value.length;
			return value.length <= 4096 && budget.text <= 1_048_576;
		}
		if (typeof value !== "object" || isProxy(value) || ancestors.has(value))
			return false;
		ancestors.add(value);
		try {
			if (isArray(value)) {
				if (getPrototype(value) !== Array.prototype) return false;
				const length = getOwnDescriptor(value, "length");
				if (
					length === undefined ||
					!hasOwnDescriptor(length, "value") ||
					typeof length.value !== "number" ||
					!Number.isSafeInteger(length.value) ||
					length.value < 0 ||
					length.value > 1024
				)
					return false;
				let count = 0;
				for (const key in value)
					if (!hasOwnDescriptor(value, key) || ++count > length.value)
						return false;
				if (ownKeys(value).length !== length.value + 1) return false;
				for (let index = 0; index < length.value; index++) {
					const item = getOwnDescriptor(value, String(index));
					if (
						item === undefined ||
						!hasOwnDescriptor(item, "value") ||
						!item.enumerable ||
						!visit(item.value, depth + 1)
					)
						return false;
				}
				return true;
			}
			const prototype = getPrototype(value);
			if (prototype !== Object.prototype && prototype !== null) return false;
			let count = 0;
			for (const key in value)
				if (!hasOwnDescriptor(value, key) || ++count > 256) return false;
			const keys = ownKeys(value);
			if (keys.length > 256) return false;
			for (const key of keys) {
				if (typeof key !== "string" || key.length === 0 || key.length > 200)
					return false;
				budget.text += key.length;
				if (budget.text > 1_048_576) return false;
				const property = getOwnDescriptor(value, key);
				if (
					property === undefined ||
					!hasOwnDescriptor(property, "value") ||
					!property.enumerable ||
					(key === "$unknown" && property.value !== undefined) ||
					!visit(property.value, depth + 1)
				)
					return false;
			}
			return true;
		} finally {
			ancestors.delete(value);
		}
	};
	try {
		return visit(input, 0);
	} catch {
		return false;
	}
}

function ownData(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || isProxy(input))
		return undefined;
	const property = getOwnDescriptor(input, key);
	return property !== undefined && hasOwnDescriptor(property, "value")
		? property.value
		: undefined;
}

type Check = (value: unknown) => boolean;
type FinancialFieldChecks = Readonly<Record<string, Check>>;

const text: Check = (value) =>
	typeof value === "string" && value.length <= 4096;
const named: Check = (value) =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 200 &&
	value.trim() === value &&
	!/[\p{Cc}]/u.test(value);
const nonnegative: Check = (value) =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value >= 0 &&
	value <= Number.MAX_SAFE_INTEGER;
const flag: Check = (value) => typeof value === "boolean";

function validFinancialRecord(
	value: unknown,
	typeName: string,
	fields: FinancialFieldChecks,
	required: readonly string[] = [],
): boolean {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value)
	)
		return false;
	for (const key of required) {
		const property = getOwnDescriptor(value, key);
		if (
			property === undefined ||
			!hasOwnDescriptor(property, "value") ||
			property.value === undefined
		)
			return false;
	}
	for (const key of ownKeys(value)) {
		if (typeof key !== "string") return false;
		const property = getOwnDescriptor(value, key);
		if (property === undefined || !hasOwnDescriptor(property, "value"))
			return false;
		if (key === "$typeName") {
			if (property.value !== `hobo.broker.yard.v1.${typeName}`) return false;
		} else if (key === "$unknown") {
			if (property.value !== undefined) return false;
		} else {
			const check = hasOwnDescriptor(fields, key) ? fields[key] : undefined;
			if (check === undefined || !check(property.value)) return false;
		}
	}
	return true;
}

function present(value: unknown, check: Check): boolean {
	return value === undefined || check(value);
}

function list(value: unknown, check: Check): boolean {
	if (isProxy(value) || !isArray(value)) return false;
	const length = ownData(value, "length");
	if (typeof length !== "number" || length > 1024) return false;
	for (let index = 0; index < length; index++) {
		const property = getOwnDescriptor(value, String(index));
		if (
			property === undefined ||
			!hasOwnDescriptor(property, "value") ||
			!check(property.value)
		)
			return false;
	}
	return true;
}

const identity: Check = (value) =>
	validFinancialRecord(
		value,
		"BudgetIdentity",
		{
			tenantId: named,
			budgetId: named,
			periodId: named,
			policyRevision: named,
		},
		["tenantId", "budgetId", "periodId", "policyRevision"],
	);
const account: Check = (value) =>
	validFinancialRecord(
		value,
		"ProviderAccountExposure",
		{
			providerAccountId: named,
			liabilityMicros: nonnegative,
		},
		["providerAccountId", "liabilityMicros"],
	);
const entitlement: Check = (value) =>
	validFinancialRecord(
		value,
		"EntitlementClaim",
		{
			bucketId: named,
			unit: named,
			units: nonnegative,
			kind: (item) =>
				item === "" ||
				item === "allowance" ||
				item === "credit" ||
				item === "commitment",
		},
		["bucketId", "unit", "units"],
	);
const accounts: Check = (value) => list(value, account);
const entitlements: Check = (value) => list(value, entitlement);
const pricingPin: Check = (value) =>
	validFinancialRecord(
		value,
		"IacPricingPin",
		{
			planDigest: named,
			inventoryHash: named,
			modelHash: named,
			quoteHash: named,
			evidenceHash: named,
			validUntil: named,
		},
		[
			"planDigest",
			"inventoryHash",
			"modelHash",
			"quoteHash",
			"evidenceHash",
			"validUntil",
		],
	);
const pricedPolicy: Check = (value) =>
	validFinancialRecord(
		value,
		"HostingPolicyProof",
		{
			requestDigest: named,
			quoteId: named,
			identity,
			policyHash: named,
			effect: (item) => item === "allow" || item === "allow-degraded",
			evidenceRef: named,
			obligationsSatisfied: (item) => item === true,
		},
		[
			"requestDigest",
			"quoteId",
			"identity",
			"policyHash",
			"effect",
			"evidenceRef",
			"obligationsSatisfied",
		],
	);
const component: Check = (value) =>
	validFinancialRecord(
		value,
		"HostingQuoteComponent",
		{ name: named, costMicros: nonnegative },
		["name", "costMicros"],
	);
const quote: Check = (value) =>
	validFinancialRecord(
		value,
		"HostingQuote",
		{
			quoteId: named,
			yardId: named,
			providerId: named,
			ownerTenantId: named,
			currency: named,
			totalMicros: nonnegative,
			observedAt: named,
			validUntil: named,
			components: (item) => list(item, component),
			requestDigest: named,
			liabilityBoundMicros: (item) => present(item, nonnegative),
			providerAccounts: accounts,
			entitlementClaims: entitlements,
			financialPlanHash: named,
		},
		[
			"quoteId",
			"yardId",
			"providerId",
			"ownerTenantId",
			"currency",
			"totalMicros",
			"observedAt",
			"validUntil",
			"components",
			"requestDigest",
			"providerAccounts",
			"entitlementClaims",
			"financialPlanHash",
		],
	);

type FinancialRow = Readonly<Record<string, string | number | undefined>>;

function isFinancialRow(value: unknown): value is FinancialRow {
	return typeof value === "object" && value !== null && !isProxy(value);
}

function scopedIdentity(
	row: FinancialRow,
	identityKey: string | readonly string[],
): string | undefined {
	const keys = typeof identityKey === "string" ? [identityKey] : identityKey;
	const values = keys.map((key) => {
		const value = ownData(row, key);
		return key === "kind" && (value === undefined || value === "")
			? "allowance"
			: value;
	});
	return values.every((value) => typeof value === "string")
		? JSON.stringify(values)
		: undefined;
}

function sumAndUnique(
	value: unknown,
	identityKey: string | readonly string[],
	amountKey: string,
	unique = true,
): number | undefined {
	if (isProxy(value) || !isArray(value)) return undefined;
	const seen = new Set<string>();
	let total = 0;
	for (const item of value) {
		if (!isFinancialRow(item)) return undefined;
		const id = scopedIdentity(item, identityKey);
		const amount = ownData(item, amountKey);
		if (
			id === undefined ||
			(unique && seen.has(id)) ||
			typeof amount !== "number" ||
			!nonnegative(amount)
		)
			return undefined;
		seen.add(id);
		total += amount;
		if (!Number.isSafeInteger(total)) return undefined;
	}
	return total;
}

function sameScopedRows(
	left: unknown,
	right: unknown,
	identityKey: string | readonly string[],
	otherKeys: readonly string[],
): boolean {
	if (
		isProxy(left) ||
		isProxy(right) ||
		!isArray(left) ||
		!isArray(right) ||
		left.length !== right.length
	)
		return false;
	const rows = new Map<string, unknown>();
	for (const row of left) {
		if (!isFinancialRow(row)) return false;
		const id = scopedIdentity(row, identityKey);
		if (id === undefined || rows.has(id)) return false;
		rows.set(id, row);
	}
	for (const row of right) {
		if (!isFinancialRow(row)) return false;
		const id = scopedIdentity(row, identityKey);
		if (id === undefined) return false;
		const match = rows.get(id);
		if (typeof match !== "object" || match === null) return false;
		for (const key of otherKeys)
			if (ownData(match, key) !== ownData(row, key)) return false;
		rows.delete(id);
	}
	return rows.size === 0;
}

export function validFinancialMetadata(
	input: unknown,
	tenantId: string,
): boolean {
	if (!boundedFinancialReceipt(input)) return false;
	const read = (record: unknown, key: string): unknown => {
		if (typeof record !== "object" || record === null || isProxy(record))
			return undefined;
		return ownData(record, key);
	};
	const checkedQuote = read(input, "quote");
	const checkedPolicy = read(input, "policyProof");
	if (!present(checkedQuote, quote) || !present(checkedPolicy, pricedPolicy))
		return false;
	const reservation = read(input, "reservation");
	const status = read(input, "status");
	const disclosure = read(input, "budget");
	const evaluation = read(disclosure, "evaluation");
	if (
		(status === "denied" &&
			(checkedQuote !== undefined ||
				checkedPolicy !== undefined ||
				reservation !== undefined)) ||
		(evaluation === "bypassed" &&
			(checkedQuote !== undefined || checkedPolicy !== undefined)) ||
		(status === "admitted" &&
			evaluation === "allowed" &&
			(checkedQuote === undefined) !== (checkedPolicy === undefined))
	)
		return false;
	const requestDigest = read(input, "requestDigest");
	if (checkedQuote !== undefined) {
		const components = read(checkedQuote, "components");
		const accountRows = read(checkedQuote, "providerAccounts");
		const entitlementRows = read(checkedQuote, "entitlementClaims");
		const total = read(checkedQuote, "totalMicros");
		const bound = read(checkedQuote, "liabilityBoundMicros");
		const observedAt = read(checkedQuote, "observedAt");
		const validUntil = read(checkedQuote, "validUntil");
		if (
			read(checkedQuote, "requestDigest") !== requestDigest ||
			read(checkedQuote, "yardId") !== read(input, "targetId") ||
			read(checkedQuote, "ownerTenantId") !== tenantId ||
			read(checkedQuote, "currency") !== "USD" ||
			typeof total !== "number" ||
			typeof bound !== "number" ||
			bound < total ||
			!isArray(components) ||
			components.length === 0 ||
			sumAndUnique(components, "name", "costMicros", false) !== total ||
			!isArray(accountRows) ||
			(accountRows.length > 0 &&
				sumAndUnique(accountRows, "providerAccountId", "liabilityMicros") !==
					bound) ||
			!isArray(entitlementRows) ||
			sumAndUnique(entitlementRows, ["kind", "bucketId", "unit"], "units") ===
				undefined ||
			typeof observedAt !== "string" ||
			typeof validUntil !== "string" ||
			!Number.isFinite(Date.parse(observedAt)) ||
			!Number.isFinite(Date.parse(validUntil)) ||
			Date.parse(observedAt) >= Date.parse(validUntil)
		)
			return false;
	}
	if (checkedPolicy !== undefined) {
		const policyIdentity = read(checkedPolicy, "identity");
		if (
			read(checkedPolicy, "requestDigest") !== requestDigest ||
			read(policyIdentity, "tenantId") !== tenantId ||
			(checkedQuote !== undefined &&
				read(checkedPolicy, "quoteId") !== read(checkedQuote, "quoteId"))
		)
			return false;
	}
	if (reservation === undefined) return true;
	if (
		!validFinancialRecord(
			reservation,
			"BudgetReservation",
			{
				reservationId: text,
				identity: (item) => present(item, identity),
				requestDigest: text,
				quoteId: text,
				reservedMicros: nonnegative,
				status: text,
				actualMicros: nonnegative,
				ledgerSeq: nonnegative,
				quoteDigest: text,
				usageEvidenceRef: text,
				sourceStoppedEvidenceRef: text,
				providerAccounts: accounts,
				entitlementClaims: entitlements,

				settlementEvidence: (item) => item === undefined,
				executionDigest: (item) =>
					typeof item === "string" &&
					(item === ""
						? status !== "admitted"
						: /^sha256:[a-f0-9]{64}$/u.test(item)),
				financialPlanHash: text,
				fenceSettlementGuard: (item) => item === undefined,
				fenceSettlementPayloadVersion: (item) => item === "" || item === "v2",
				unboundedExposure: flag,

				unpricedPolicyProof: () => true,
				unpricedScopeProof: () => true,
				iacPricingPin: (item) => present(item, pricingPin),
			},
			["reservationId"],
		)
	)
		return false;
	const reservationIdentity = read(reservation, "identity");
	if (
		(reservationIdentity !== undefined &&
			read(reservationIdentity, "tenantId") !== tenantId) ||
		(status === "admitted" &&
			read(reservation, "status") !== undefined &&
			read(reservation, "status") !== "held") ||
		(status === "admitted" &&
			read(reservation, "settlementEvidence") !== undefined) ||
		(status === "admitted" &&
			read(reservation, "actualMicros") !== undefined &&
			read(reservation, "actualMicros") !== 0) ||
		(status === "admitted" &&
			read(reservation, "requestDigest") !== undefined &&
			read(reservation, "requestDigest") !== requestDigest) ||
		(status === "admitted" &&
			checkedQuote !== undefined &&
			read(reservation, "quoteId") !== undefined &&
			read(reservation, "quoteId") !== read(checkedQuote, "quoteId"))
	)
		return false;
	if (checkedPolicy !== undefined && reservationIdentity !== undefined) {
		const policyIdentity = read(checkedPolicy, "identity");
		for (const key of ["tenantId", "budgetId", "periodId", "policyRevision"])
			if (read(policyIdentity, key) !== read(reservationIdentity, key))
				return false;
	}
	const pin = read(reservation, "iacPricingPin");
	if (status === "admitted" && checkedQuote !== undefined) {
		if (
			read(reservation, "reservedMicros") !==
				read(checkedQuote, "liabilityBoundMicros") ||
			read(reservation, "financialPlanHash") !==
				read(checkedQuote, "financialPlanHash") ||
			!sameScopedRows(
				read(reservation, "providerAccounts"),
				read(checkedQuote, "providerAccounts"),
				"providerAccountId",
				["liabilityMicros"],
			) ||
			!sameScopedRows(
				read(reservation, "entitlementClaims"),
				read(checkedQuote, "entitlementClaims"),
				["kind", "bucketId", "unit"],
				["units"],
			) ||
			(pin !== undefined &&
				read(pin, "validUntil") !== read(checkedQuote, "validUntil"))
		)
			return false;
	}
	if (status === "admitted" && pin !== undefined)
		for (const key of ["inventoryHash", "modelHash", "quoteHash"])
			if (read(pin, key) !== read(input, key)) return false;
	if (
		status === "admitted" &&
		evaluation === "bypassed" &&
		((read(reservation, "reservedMicros") !== undefined &&
			read(reservation, "reservedMicros") !== 0) ||
			(read(reservation, "quoteId") !== undefined &&
				read(reservation, "quoteId") !== "") ||
			read(reservation, "iacPricingPin") !== undefined ||
			read(reservation, "fenceSettlementGuard") !== undefined)
	)
		return false;
	return true;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */
