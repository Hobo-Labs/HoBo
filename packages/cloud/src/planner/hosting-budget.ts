import { createHash } from "node:crypto";
import type { ManifestV1 } from "@hobo/bindles";
import { canonicalJson } from "@hobo/contracts";
import {
	type BudgetPolicy,
	canonicalBudgetPolicyJson,
	evaluateBudgetPolicy,
	parseBudgetPolicy,
} from "@hobo/core";
import type {
	HostingResourceCommitment as AllocationWire,
	HostingBudgetSnapshot as BudgetWire,
	HostingPlanCommitment as CommitmentWire,
	HostingChargeComponent as ComponentWire,
	HostingEntitlementClaim as EntitlementClaimWire,
	HostingEntitlement as EntitlementWire,
	HostingPlanningInput as PlanningWire,
	HostingProviderCharge as ProviderChargeWire,
	HostingPriceQuote as QuoteWire,
	HostingUsageBound as UsageWire,
} from "../_generated/hosting_planning_pb.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type { ResourceDefinition } from "../registry/catalog.js";

// Domain views of generated protobuf records. Planning has no external effects.
export type HostingBudgetSnapshot = Readonly<Omit<BudgetWire, "$typeName">>;
export type HostingChargeComponent = Readonly<Omit<ComponentWire, "$typeName">>;
export type HostingProviderCharge = Readonly<
	Omit<ProviderChargeWire, "$typeName">
>;
export type HostingEntitlementClaim = Readonly<
	Omit<EntitlementClaimWire, "$typeName">
>;
export type HostingPriceQuote = Readonly<
	Omit<QuoteWire, "$typeName" | "components"> & {
		components?: readonly HostingChargeComponent[];
	}
>;
export type HostingUsageBound = Readonly<Omit<UsageWire, "$typeName">>;
export type HostingEntitlement = Readonly<
	Omit<EntitlementWire, "$typeName" | "definitionIds" | "costClasses"> & {
		definitionIds: readonly string[];
		costClasses?: readonly string[];
	}
>;
export type HostingResourceCommitment = Readonly<
	Omit<
		AllocationWire,
		"$typeName" | "providerCharges" | "entitlementClaims"
	> & {
		providerCharges: readonly HostingProviderCharge[];
		entitlementClaims: readonly HostingEntitlementClaim[];
	}
>;
export type HostingPlanCommitment = Readonly<
	Omit<CommitmentWire, "$typeName" | "allocations" | "evidence"> & {
		allocations: readonly HostingResourceCommitment[];
		evidence: HostingPlanningInput;
	}
>;
export type HostingPlanningInput = Readonly<
	Omit<
		PlanningWire,
		| "$typeName"
		| "budget"
		| "quotes"
		| "usages"
		| "entitlements"
		| "providerBudgets"
		| "budgetPolicy"
	> & {
		budget: HostingBudgetSnapshot;
		quotes: readonly HostingPriceQuote[];
		usages: readonly HostingUsageBound[];
		entitlements: readonly HostingEntitlement[];
		providerBudgets: readonly HostingBudgetSnapshot[];
		budgetPolicy?: JsonObject;
	}
>;

type Fraction = readonly [bigint, bigint];
const ZERO: Fraction = [0n, 1n];
const PERIOD_MS = new Map([
	["second", 1000],
	["minute", 60_000],
	["hour", 3_600_000],
	["day", 86_400_000],
]);

export class HostingPlanningError extends Error {
	readonly code = "budget.invalid-evidence";
}

interface ManifestHostingPolicy {
	required: boolean;
	hardLimitMicros: number | undefined;
	spendCapMicros: number | undefined;
	period: string | undefined;
	budgetPolicy: BudgetPolicy | undefined;
}

/** Financial declarations must never disappear into the legacy placement lane. */
export function manifestHostingPolicy(manifest: ManifestV1): ManifestHostingPolicy {
	let required = false;
	let hardLimitMicros: number | undefined;
	let spendCapMicros: number | undefined;
	let period: string | undefined;
	let budgetPolicy: BudgetPolicy | undefined;
	function usd(value: JsonValue, name: string): number {
		requireEvidence(
			isJsonNumber(value) && Number.isFinite(value) && value >= 0,
			`${name} must be a nonnegative USD number`,
		);
		const amount = fraction(value),
			micros = amount[0] * 1_000_000n;
		requireEvidence(
			micros % amount[1] === 0n,
			`${name} must use whole USD micro-units`,
		);
		return checkedMicros(micros / amount[1]);
	}
	function inspect(value: JsonValue): void {
		if (!isJsonObject(value)) return;
		const policy = value.policy;
		if (isJsonObject(policy)) {
			if (policy.budgetPolicy !== undefined) {
				required = true;
				const shared = readBudgetPolicy(policy.budgetPolicy);
				requireEvidence(
					budgetPolicy === undefined ||
						canonicalBudgetPolicyJson(shared) ===
							canonicalBudgetPolicyJson(budgetPolicy),
					"conflicting shared budget policy declarations",
				);
				budgetPolicy = shared;
				hardLimitMicros = Math.min(
					hardLimitMicros ?? Infinity,
					shared.limitMicros,
				);
			}
			requireEvidence(
				policy.budget === undefined || isJsonObject(policy.budget),
				"declared financial budget must be an object",
			);
			requireEvidence(
				policy.costAvailabilityProfile === undefined ||
					isJsonObject(policy.costAvailabilityProfile),
				"declared cost/availability profile must be an object",
			);
			if (
				policy.budget !== undefined ||
				policy.costAvailabilityProfile !== undefined ||
				policy.spendCapUsd !== undefined
			)
				required = true;
			const budget = policy.budget;
			if (isJsonObject(budget) && budget.hardLimitUsd !== undefined) {
				const limit = usd(budget.hardLimitUsd, "declared hard budget");
				hardLimitMicros = Math.min(hardLimitMicros ?? Infinity, limit);
			}
			if (isJsonObject(budget) && budget.period !== undefined) {
				requireEvidence(
					isJsonString(budget.period) &&
						(period === undefined || period === budget.period),
					"mixed budget periods need separately funded scope bindings",
				);
				period = budget.period;
			}
			if (policy.spendCapUsd !== undefined)
				spendCapMicros = Math.min(
					spendCapMicros ?? Infinity,
					usd(policy.spendCapUsd, "spendCapUsd"),
				);
			if (
				isJsonObject(policy.costAvailabilityProfile) &&
				policy.costAvailabilityProfile.budgetUsd !== undefined &&
				!(isJsonObject(budget) && budget.hardLimitUsd !== undefined)
			)
				hardLimitMicros = Math.min(
					hardLimitMicros ?? Infinity,
					usd(
						policy.costAvailabilityProfile.budgetUsd,
						"costAvailabilityProfile.budgetUsd",
					),
				);
		}
		for (const [key, child] of Object.entries(value))
			if (key !== "policy") {
				if (Array.isArray(child)) child.forEach(inspect);
				else inspect(child);
			}
	}
	inspect(cloneAsJson(manifest.value));
	return { required, hardLimitMicros, spendCapMicros, period, budgetPolicy };
}

function readBudgetPolicy(value: JsonValue): BudgetPolicy {
	try {
		return parseBudgetPolicy(value);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		throw new HostingPlanningError(
			`invalid shared budget policy: ${error.message}`,
		);
	}
}

function requireEvidence(
	condition: boolean,
	message: string,
): asserts condition {
	if (!condition) throw new HostingPlanningError(message);
}

function money(value: number, field: string): number {
	requireEvidence(
		Number.isSafeInteger(value) && value >= 0,
		`${field} must be a nonnegative safe integer`,
	);
	return value;
}

function quantity(value: number, field: string): number {
	requireEvidence(
		Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER,
		`${field} must be a finite nonnegative quantity`,
	);
	return value;
}

function fraction(value: number): Fraction {
	const [mantissa, exponentText] = String(value).toLowerCase().split("e");
	const [integer, decimals = ""] = mantissa.split(".");
	const exponent = Number(exponentText ?? 0) - decimals.length;
	const numerator = BigInt(integer + decimals);
	return exponent >= 0
		? [numerator * 10n ** BigInt(exponent), 1n]
		: [numerator, 10n ** BigInt(-exponent)];
}
function subtract(left: Fraction, right: Fraction): Fraction {
	return [left[0] * right[1] - right[0] * left[1], left[1] * right[1]];
}
function minimum(left: Fraction, right: Fraction): Fraction {
	return left[0] * right[1] <= right[0] * left[1] ? left : right;
}
function positive(value: Fraction): Fraction {
	return value[0] > 0n ? value : ZERO;
}
function ceil(value: Fraction): bigint {
	return (value[0] + value[1] - 1n) / value[1];
}
function checkedMicros(value: bigint): number {
	requireEvidence(
		value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
		"quoted cost overflows integer micro-units",
	);
	return Number(value);
}
function multiplyRate(units: Fraction, rate: number): number {
	return checkedMicros(ceil([units[0] * BigInt(rate), units[1]]));
}
function sumMoney(...values: number[]): number {
	return checkedMicros(values.reduce((sum, value) => sum + BigInt(value), 0n));
}

function withoutProtobufMetadata(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(withoutProtobufMetadata);
	if (!isJsonObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "$typeName" && key !== "$unknown")
			.map(([key, child]) => [key, withoutProtobufMetadata(child)]),
	);
}

/** Stable through protobuf message materialization and event JSON round trips. */
export function canonicalHostingEvidence<T>(value: T): string {
	return canonicalJson(withoutProtobufMetadata(cloneAsJson(value)));
}

export function hostingBudgetHeadroom(budget: HostingBudgetSnapshot): number {
	const used = sumMoney(
		budget.settledMicros,
		budget.committedMicros,
		budget.unresolvedMicros,
		budget.recoveryReserveMicros,
	);
	return Math.max(0, budget.capMicros - used);
}

function validateBudget(
	budget: HostingBudgetSnapshot,
	input: HostingPlanningInput,
): void {
	for (const name of [
		"budgetId",
		"tenantId",
		"scopeId",
		"periodId",
		"policyRevision",
	])
		requireEvidence(budget[name].length > 0, `budget.${name} is required`);
	for (const name of [
		"ledgerSeq",
		"periodStartMs",
		"periodEndMs",
		"capMicros",
		"settledMicros",
		"committedMicros",
		"unresolvedMicros",
		"recoveryReserveMicros",
		"observedAtMs",
		"validUntilMs",
	])
		money(budget[name], `budget.${name}`);
	requireEvidence(
		/^[A-Z]{3}$/.test(budget.currency),
		"budget currency must be explicit",
	);
	requireEvidence(
		budget.periodStartMs <= input.nowMs &&
			input.nowMs < budget.periodEndMs &&
			input.horizonEndMs <= budget.periodEndMs,
		"planning horizon must stay within the funded budget period",
	);
	requireEvidence(
		budget.observedAtMs <= input.nowMs &&
			input.nowMs - budget.observedAtMs <= input.maxObservationAgeMs &&
			budget.validUntilMs > input.nowMs,
		"budget snapshot is stale or future-dated",
	);
	void hostingBudgetHeadroom(budget);
}

export function createHostingPlanningPass(incoming: HostingPlanningInput) {
	const input: HostingPlanningInput = {
		...structuredClone(incoming),
		quotes: incoming.quotes.map((quote) => ({
			...structuredClone(quote),
			components: (quote.components ?? []).map((component) => ({
				...component,
				entitlementId: component.entitlementId ?? "",
			})),
		})),
		entitlements: incoming.entitlements.map((entitlement) => ({
			...structuredClone(entitlement),
			costClasses: [...(entitlement.costClasses ?? [])],
		})),
	};
	requireEvidence(
		input.budget !== undefined,
		"a pinned budget snapshot is required",
	);
	money(input.nowMs, "nowMs");
	money(input.horizonEndMs, "horizonEndMs");
	money(input.maxObservationAgeMs, "maxObservationAgeMs");
	requireEvidence(
		input.horizonEndMs > input.nowMs,
		"planning horizon must be positive",
	);
	validateBudget(input.budget, input);
	const budgetPolicy =
		input.budgetPolicy === undefined
			? undefined
			: readBudgetPolicy(input.budgetPolicy);
	if (budgetPolicy)
		requireEvidence(
			budgetPolicy.currency === input.budget.currency,
			"shared policy currency differs from the financial authority",
		);
	if (budgetPolicy?.periodKind === "fixed-window")
		requireEvidence(
			input.nowMs >= (budgetPolicy.periodStartsAtMs ?? Infinity) &&
				input.horizonEndMs <= (budgetPolicy.periodEndsAtMs ?? -Infinity),
			"planning horizon must stay within the shared policy's funded window",
		);
	const providerBudgets = new Map<string, HostingBudgetSnapshot>();
	for (const budget of input.providerBudgets) {
		validateBudget(budget, input);
		requireEvidence(
			budget.providerAccountId.length > 0 &&
				!providerBudgets.has(budget.providerAccountId),
			"provider budget accounts must be unique",
		);
		requireEvidence(
			budget.tenantId === input.budget.tenantId &&
				budget.currency === input.budget.currency,
			"provider budget scope or currency differs from parent",
		);
		providerBudgets.set(budget.providerAccountId, budget);
	}
	const usages = new Map<string, HostingUsageBound>();
	for (const usage of input.usages) {
		requireEvidence(
			usage.resourceName.length > 0 &&
				usage.unit.length > 0 &&
				!usages.has(usage.resourceName),
			"resource usage bounds must be unique and named",
		);
		quantity(usage.expectedQuantity, "expectedQuantity");
		quantity(usage.boundedQuantity, "boundedQuantity");
		requireEvidence(
			usage.boundedQuantity >= usage.expectedQuantity,
			"usage bound is lower than expected usage",
		);
		usages.set(usage.resourceName, usage);
	}
	const entitlements = new Map<string, HostingEntitlement>();
	const available = new Map<string, Fraction>();
	for (const entitlement of input.entitlements) {
		requireEvidence(
			entitlement.id.length > 0 &&
				entitlement.providerAccountId.length > 0 &&
				entitlement.unit.length > 0 &&
				!entitlements.has(entitlement.id),
			"entitlement IDs must be unique and account scoped",
		);
		quantity(entitlement.remainingQuantity, "remaining entitlement");
		money(entitlement.validUntilMs, "entitlement expiry");
		requireEvidence(
			entitlement.currency === input.budget.currency,
			"entitlement currency differs from budget",
		);
		requireEvidence(
			entitlement.periodId === input.budget.periodId,
			"entitlement belongs to a different financial period",
		);
		requireEvidence(
			(entitlement.costClasses ?? []).every(
				(costClass) => isJsonString(costClass) && costClass.length > 0,
			),
			"entitlement cost classes must be named",
		);
		if (entitlement.unit === "micros")
			money(entitlement.remainingQuantity, "monetary entitlement");
		entitlements.set(entitlement.id, entitlement);
		available.set(entitlement.id, fraction(entitlement.remainingQuantity));
	}
	const quotes = new Map<string, HostingPriceQuote>();
	const quoteIds = new Set<string>();
	const providerAccounts = new Set(providerBudgets.keys());
	for (const quote of input.quotes) {
		const key = JSON.stringify([quote.resourceName, quote.definitionId]);
		requireEvidence(
			!quotes.has(key) && !quoteIds.has(quote.id),
			"quote identity is duplicated",
		);
		quotes.set(key, quote);
		quoteIds.add(quote.id);
		providerAccounts.add(quote.providerAccountId);
		for (const component of quote.components ?? [])
			providerAccounts.add(component.providerAccountId);
	}
	const allocations: HostingResourceCommitment[] = [];
	const accountReserved = new Map<string, number>();
	let reservedMicros = 0;
	let expectedMicros = 0;
	let validUntilMs = input.budget.validUntilMs;
	let liabilityEndsAtMs = input.horizonEndMs;
	const existingExposure = sumMoney(
		input.budget.settledMicros,
		input.budget.committedMicros,
		input.budget.unresolvedMicros,
		input.budget.recoveryReserveMicros,
	);
	function checkPolicy(
		costBoundMicros: number,
		charges: readonly HostingProviderCharge[],
		candidateEndMs = input.horizonEndMs,
	) {
		if (!budgetPolicy) return;
		const projectedAccounts = new Map(accountReserved);
		for (const account of providerAccounts)
			if (!projectedAccounts.has(account)) projectedAccounts.set(account, 0);
		for (const charge of charges)
			projectedAccounts.set(
				charge.providerAccountId,
				sumMoney(
					projectedAccounts.get(charge.providerAccountId) ?? 0,
					charge.reservedMicros,
				),
			);
		const result = evaluateBudgetPolicy(budgetPolicy, {
			workload: "hosting",
			tenantId: input.budget.tenantId,
			budgetId: input.budget.budgetId,
			periodId: input.budget.periodId,
			policyRevision: input.budget.policyRevision,
			nowMs: input.nowMs,
			costBoundMicros,
			exposureMicros: existingExposure,
			boundKind: "conservative",
			phase: "plan",
			measurements: [
				{ key: "work.cost", unit: "USD.micros", value: costBoundMicros },
				{
					key: "work.duration",
					unit: "ms",
					value: Math.max(liabilityEndsAtMs, candidateEndMs) - input.nowMs,
				},
				...[...projectedAccounts].map(([target, value]) => ({
					key: "provider.cost",
					unit: "USD.micros",
					target,
					value,
				})),
			],
		});
		requireEvidence(result.ok, `${result.code}: ${result.reason}`);
	}
	// Bind identity and unsupported controls before considering any quote.
	checkPolicy(0, []);

	function claimQuantity(value: Fraction): number {
		const result = Number(value[0]) / Number(value[1]);
		requireEvidence(
			Number.isFinite(result) && result >= 0,
			"entitlement claim cannot be represented as a finite quantity",
		);
		const represented = fraction(result);
		requireEvidence(
			represented[0] * value[1] === value[0] * represented[1],
			"entitlement claim cannot be represented exactly; normalize its billing unit first",
		);
		return result;
	}
	function evaluate(resourceName: string, definition: ResourceDefinition) {
		const quote = quotes.get(JSON.stringify([resourceName, definition.id]));
		const usage = usages.get(resourceName);
		try {
			requireEvidence(
				quote !== undefined && usage !== undefined,
				"fresh quote and bounded usage are required for every resource",
			);
			requireEvidence(
				quote.id.length > 0 &&
					quote.providerAccountId.length > 0 &&
					quote.source.length > 0 &&
					quote.providerId === definition.providerId,
				"quote is missing provenance or has a foreign provider",
			);
			requireEvidence(
				quote.currency === input.budget.currency,
				"quote currency differs from budget",
			);
			for (const name of [
				"rateMicros",
				"fixedCostMicros",
				"transitionCostMicros",
				"observedAtMs",
				"validUntilMs",
				"liabilityEndsAtMs",
			])
				money(quote[name], `quote.${name}`);
			quantity(quote.minimumQuantity, "minimum billable quantity");
			requireEvidence(
				quote.observedAtMs <= input.nowMs &&
					input.nowMs - quote.observedAtMs <= input.maxObservationAgeMs &&
					quote.validUntilMs >= input.horizonEndMs,
				"quote does not cover the horizon or is stale",
			);
			requireEvidence(
				quote.liabilityEndsAtMs >= input.horizonEndMs &&
					quote.liabilityEndsAtMs <= input.budget.periodEndMs,
				"liability extends beyond funded period or omits the horizon",
			);
			if (budgetPolicy?.periodKind === "fixed-window")
				requireEvidence(
					quote.liabilityEndsAtMs <= (budgetPolicy.periodEndsAtMs ?? -Infinity),
					"quoted liability extends beyond the shared policy's funded window",
				);
			const components = quote.components ?? [];
			const componentIds = new Set<string>();
			for (const component of components) {
				requireEvidence(
					component.id.length > 0 &&
						component.providerAccountId.length > 0 &&
						component.costClass.length > 0 &&
						!componentIds.has(component.id),
					"charge component needs a unique identity, billing owner and cost class",
				);
				componentIds.add(component.id);
				money(component.expectedMicros, "component expected cost");
				money(component.boundedMicros, "component bounded cost");
				requireEvidence(
					component.expectedMicros <= component.boundedMicros,
					"charge component lacks a conservative bound",
				);
				requireEvidence(
					providerBudgets.has(component.providerAccountId),
					"every additional charge requires its billing account ceiling",
				);
			}
			requireEvidence(
				quote.transitionCostMicros === 0 ||
					(components.length > 0 &&
						sumMoney(
							...components.map((component) => component.expectedMicros),
						) === quote.transitionCostMicros),
				"legacy transition cost requires a complete owned component breakdown",
			);
			requireEvidence(
				quote.fixedCostMicros === 0 ||
					!components.some((component) => component.costClass === "fixed"),
				"fixed charges must be represented once; use an explicit component for creditable fixed charges",
			);
			let expected = fraction(usage.expectedQuantity),
				bounded = fraction(usage.boundedQuantity);
			if (usage.unit === "time-ms") {
				const duration =
					PERIOD_MS.get(quote.billingUnit) ??
					(quote.billingUnit === "month" ? quote.billingPeriodMs : 0);
				requireEvidence(
					Number.isSafeInteger(duration) && duration > 0,
					"time quote needs an exact billing period",
				);
				expected = [expected[0], expected[1] * BigInt(duration)];
				bounded = [bounded[0], bounded[1] * BigInt(duration)];
			} else
				requireEvidence(
					usage.unit === quote.billingUnit,
					"quote and usage units are incomparable",
				);
			const minimumBill = fraction(quote.minimumQuantity);
			if (expected[0] * minimumBill[1] < minimumBill[0] * expected[1])
				expected = minimumBill;
			if (bounded[0] * minimumBill[1] < minimumBill[0] * bounded[1])
				bounded = minimumBill;
			if (quote.roundUpQuantity) {
				expected = [ceil(expected), 1n];
				bounded = [ceil(bounded), 1n];
			}

			// Evaluate alternatives against a private allowance copy. Only commit consumes it.
			const remaining = new Map(available);
			const deductions = new Map<string, Fraction>();
			const entitlementClaims: HostingEntitlementClaim[] = [];
			const charges = new Map<string, HostingProviderCharge>();
			let primaryConsumed: Fraction = ZERO;
			function useEntitlement(
				id: string,
				accountId: string,
				costClass: string,
				desired: Fraction,
				primary: boolean,
			) {
				const entitlement = entitlements.get(id);
				requireEvidence(
					entitlement !== undefined &&
						entitlement.providerAccountId === accountId &&
						entitlement.periodId === input.budget.periodId &&
						entitlement.validUntilMs >= input.horizonEndMs &&
						(entitlement.definitionIds.length === 0 ||
							entitlement.definitionIds.includes(definition.id)),
					"entitlement is expired, foreign, wrong-period or does not cover the offering",
				);
				const classes = entitlement.costClasses ?? [];
				requireEvidence(
					primary
						? classes.length === 0 || classes.includes(costClass)
						: classes.includes(costClass),
					"entitlement does not cover this cost class",
				);
				requireEvidence(
					primary || entitlement.unit === "micros",
					"itemized component credits require monetary entitlement units",
				);
				const consumed = minimum(remaining.get(id) ?? ZERO, desired);
				const quantityValue = claimQuantity(consumed);
				remaining.set(
					id,
					positive(subtract(remaining.get(id) ?? ZERO, consumed)),
				);
				const previous = deductions.get(id) ?? ZERO;
				deductions.set(id, [
					previous[0] * consumed[1] + consumed[0] * previous[1],
					previous[1] * consumed[1],
				]);
				if (quantityValue > 0)
					entitlementClaims.push({
						entitlementId: id,
						unit: entitlement.unit,
						quantity: quantityValue,
						costClass,
					});
				return { entitlement, consumed };
			}
			function charge(
				accountId: string,
				expectedCost: number,
				boundedCost: number,
			): void {
				const previous = charges.get(accountId);
				charges.set(accountId, {
					providerAccountId: accountId,
					expectedMicros: sumMoney(previous?.expectedMicros ?? 0, expectedCost),
					reservedMicros: sumMoney(previous?.reservedMicros ?? 0, boundedCost),
				});
			}
			let usageExpected = multiplyRate(expected, quote.rateMicros),
				usageBounded = multiplyRate(bounded, quote.rateMicros);
			if (quote.entitlementId) {
				const entitlement = entitlements.get(quote.entitlementId);
				requireEvidence(
					entitlement !== undefined,
					"primary entitlement does not exist",
				);
				if (entitlement.unit === "micros") {
					const result = useEntitlement(
						entitlement.id,
						quote.providerAccountId,
						"usage",
						[BigInt(usageBounded), 1n],
						true,
					);
					primaryConsumed = result.consumed;
					const credit = checkedMicros(ceil(primaryConsumed));
					usageExpected = Math.max(0, usageExpected - credit);
					usageBounded -= credit;
				} else {
					requireEvidence(
						entitlement.unit === quote.billingUnit,
						"entitlement and quote units differ",
					);
					const result = useEntitlement(
						entitlement.id,
						quote.providerAccountId,
						"usage",
						bounded,
						true,
					);
					primaryConsumed = result.consumed;
					usageExpected = multiplyRate(
						positive(subtract(expected, primaryConsumed)),
						quote.rateMicros,
					);
					usageBounded = multiplyRate(
						positive(subtract(bounded, primaryConsumed)),
						quote.rateMicros,
					);
				}
			}
			// Legacy fixed charges are never discounted by a usage/promo bucket.
			charge(
				quote.providerAccountId,
				sumMoney(usageExpected, quote.fixedCostMicros),
				sumMoney(usageBounded, quote.fixedCostMicros),
			);
			for (const component of components) {
				let expectedCost = component.expectedMicros,
					boundedCost = component.boundedMicros;
				if (component.entitlementId) {
					const result = useEntitlement(
						component.entitlementId,
						component.providerAccountId,
						component.costClass,
						[BigInt(boundedCost), 1n],
						false,
					);
					const credit = checkedMicros(ceil(result.consumed));
					expectedCost = Math.max(0, expectedCost - credit);
					boundedCost -= credit;
				}
				charge(component.providerAccountId, expectedCost, boundedCost);
			}
			const providerCharges = [...charges.values()].sort((left, right) =>
				left.providerAccountId.localeCompare(right.providerAccountId),
			);
			const expectedCost = sumMoney(
				...providerCharges.map((entry) => entry.expectedMicros),
			);
			const reservedCost = sumMoney(
				...providerCharges.map((entry) => entry.reservedMicros),
			);
			checkPolicy(
				sumMoney(reservedMicros, reservedCost),
				providerCharges,
				quote.liabilityEndsAtMs,
			);
			requireEvidence(
				sumMoney(reservedMicros, reservedCost) <=
					hostingBudgetHeadroom(input.budget),
				"aggregate budget exposure exceeds available allowance",
			);
			for (const entry of providerCharges) {
				const providerBudget = providerBudgets.get(entry.providerAccountId);
				requireEvidence(
					input.providerBudgets.length === 0 || providerBudget !== undefined,
					"charge billing account has no pinned ceiling",
				);
				if (providerBudget)
					requireEvidence(
						sumMoney(
							accountReserved.get(entry.providerAccountId) ?? 0,
							entry.reservedMicros,
						) <= hostingBudgetHeadroom(providerBudget),
						"provider account budget is exhausted",
					);
			}
			const allocation: HostingResourceCommitment = {
				resourceName,
				definitionId: definition.id,
				quoteId: quote.id,
				providerAccountId: quote.providerAccountId,
				entitlementId: quote.entitlementId,
				expectedMicros: expectedCost,
				reservedMicros: reservedCost,
				reservedEntitlementQuantity: claimQuantity(primaryConsumed),
				providerCharges,
				entitlementClaims,
			};
			return { ok: true as const, allocation, quote, deductions };
		} catch (error) {
			if (!(error instanceof HostingPlanningError)) throw error;
			return { ok: false as const, reason: error.message };
		}
	}
	function commit(
		resourceName: string,
		definition: ResourceDefinition,
	): HostingResourceCommitment {
		requireEvidence(
			!allocations.some(
				(allocation) => allocation.resourceName === resourceName,
			),
			"resource cannot consume allowance twice",
		);
		const result = evaluate(resourceName, definition);
		requireEvidence(result.ok, result.ok ? "" : result.reason);
		const { allocation, quote, deductions } = result;
		allocations.push(allocation);
		reservedMicros = sumMoney(reservedMicros, allocation.reservedMicros);
		expectedMicros = sumMoney(expectedMicros, allocation.expectedMicros);
		for (const charge of allocation.providerCharges)
			accountReserved.set(
				charge.providerAccountId,
				sumMoney(
					accountReserved.get(charge.providerAccountId) ?? 0,
					charge.reservedMicros,
				),
			);
		for (const [id, consumed] of deductions)
			available.set(
				id,
				positive(subtract(available.get(id) ?? ZERO, consumed)),
			);
		validUntilMs = Math.min(validUntilMs, quote.validUntilMs);
		liabilityEndsAtMs = Math.max(liabilityEndsAtMs, quote.liabilityEndsAtMs);
		return allocation;
	}
	function commitment(): HostingPlanCommitment {
		const budget = input.budget;
		const body = {
			budgetId: budget.budgetId,
			tenantId: budget.tenantId,
			scopeId: budget.scopeId,
			periodId: budget.periodId,
			policyRevision: budget.policyRevision,
			ledgerSeq: budget.ledgerSeq,
			currency: budget.currency,
			expectedMicros,
			reservedMicros,
			validUntilMs,
			allocations: [...allocations],
		};
		const canonicalInput = {
			...input,
			quotes: [...input.quotes].sort((a, b) => a.id.localeCompare(b.id)),
			usages: [...input.usages].sort((a, b) =>
				a.resourceName.localeCompare(b.resourceName),
			),
			entitlements: [...input.entitlements].sort((a, b) =>
				a.id.localeCompare(b.id),
			),
			providerBudgets: [...input.providerBudgets].sort((a, b) =>
				a.providerAccountId.localeCompare(b.providerAccountId),
			),
		};
		const commitmentHash = `sha256:${createHash("sha256")
			.update(canonicalHostingEvidence({ ...body, evidence: canonicalInput }))
			.digest("hex")}`;
		return { ...body, evidence: canonicalInput, commitmentHash };
	}
	return { evaluate, commit, commitment };
}

export type HostingPlanningPass = ReturnType<typeof createHostingPlanningPass>;
