import { types as utilTypes } from "node:util";
import {
	areBoundedPricingInputs,
	compareDecimal,
	isBoundedPricingInput,
	type Money,
	parseDecimal,
	quoteTargetPricing,
	type TargetPricingAvailability,
	type TargetPricingInventory,
} from "@hobo/pricing";
import {
	type IacRouteAuthority,
	type IacRouteController,
	type IacRouteOperation,
	type IacRoutePermit,
	runIacRoute,
} from "./iac-route.js";

export interface IacPricingCandidate {
	readonly workloadRef: string;
	readonly inventory: TargetPricingInventory;
	readonly pricing: TargetPricingAvailability;
}

export interface IacPricingRankingRequest {
	readonly tenantId: string;
	/** Host-owned identity for the same workload across candidates. */
	readonly workloadRef: string;
	readonly action: string;
	readonly at: string;
	readonly horizon: string;
	readonly candidates: readonly IacPricingCandidate[];
}

export interface IacPricingRanking {
	readonly targetId: string;
	readonly rank: number;
	readonly incrementalBilled: Money;
	readonly source: "developer-supplied";
	readonly modelId: string;
	readonly revision: string;
	readonly modelHash: string;
	readonly inventoryHash: string;
	readonly quoteHash: string;
}

export interface IacPricingRankingResult {
	readonly tenantId: string;
	readonly coverage: "complete" | "partial";
	readonly budget: {
		readonly evaluation: "not-evaluated";
		readonly reservation: "not-created";
	};
	readonly code?: "ROUTING_INPUT_INVALID";
	readonly ranking: IacPricingRanking[];
	readonly rejected: { targetId: string; code: string; reason: string }[];
}

export interface IacRoutingAdmission {
	readonly requestId: string;
	readonly targetId: string;
	readonly status: string;
	readonly code: string;
	readonly message: string;
	readonly budget?: {
		readonly evaluation: string;
		readonly reservation: string;
	};
	readonly reservation?: { readonly reservationId: string };
	readonly inventoryHash?: string;
	readonly modelHash?: string;
	readonly quoteHash?: string;
}
type MutableIacRoutingAdmission = {
	-readonly [K in keyof IacRoutingAdmission]: IacRoutingAdmission[K];
};

export type IacRoutingExpectation = Pick<
	IacPricingRanking,
	"targetId" | "inventoryHash" | "modelHash" | "quoteHash"
>;

export interface IacRoutingAttempt {
	readonly targetId: string;
	readonly status: string;
	readonly code: string;
	readonly budget: {
		readonly evaluation: string;
		readonly reservation: string;
	};
}

export interface IacTargetExecutionResult {
	readonly status: "selected" | "denied" | "uncertain" | "replay";
	readonly coverage: "complete" | "partial";
	readonly budget: {
		readonly evaluation: string;
		readonly reservation: string;
	};
	readonly attempts: IacRoutingAttempt[];
	readonly code?: string;
	readonly targetId?: string;
	readonly outputs?: Record<string, string>;
	readonly admission?: IacRoutingAdmission;
	readonly reservationId?: string;
	readonly executionOutcome?: "completed" | "unknown";
}

export interface RankedIacExecutionInput {
	readonly authority: IacRouteAuthority;
	readonly tenantId: string;
	readonly requestId: string;
	readonly operation: IacRouteOperation;
	readonly ranking: IacPricingRankingResult;
	readonly candidates: readonly {
		readonly targetId: string;
		readonly run: (
			requestId: string,
			expected: IacRoutingExpectation,
			permit: IacRoutePermit,
		) => Promise<{
			outputs: Record<string, string>;
			admission: IacRoutingAdmission;
		}>;
	}[];
}

/** Claim the route before examining any target, then stop on every unknown outcome. */
export async function executeRankedIacTargets(
	input: RankedIacExecutionInput,
): Promise<IacTargetExecutionResult> {
	const { authority, tenantId, requestId, operation } = input;
	const unavailable = {
		evaluation: "unavailable",
		reservation: "unknown",
	} as const;
	let stable: RankedIacExecutionInput;
	try {
		const ranking = structuredClone(input.ranking);
		const candidates = input.candidates.map(({ targetId, run }) => ({
			targetId,
			run,
		}));
		stable = {
			authority,
			tenantId,
			requestId,
			operation: structuredClone(operation),
			ranking,
			candidates,
		};
	} catch {
		return {
			status: "uncertain",
			code: "ROUTING_INPUT_UNINSPECTABLE",
			coverage: "partial",
			budget: unavailable,
			attempts: [],
		};
	}
	const result = await runIacRoute({
		authority,
		tenantId,
		requestId,
		operation: stable.operation,
		run: async (route) => {
			const value = await executeClaimedIacTargets(stable, route);
			const outcome =
				value.targetId === undefined
					? { status: value.status }
					: { status: value.status, targetId: value.targetId };
			return { value, outcome };
		},
	});
	if (result.status === "executed") return result.value;
	const blocked: IacTargetExecutionResult = {
		status: result.status,
		code: result.code,
		coverage: stable.ranking.coverage,
		budget: unavailable,
		attempts: [],
	};
	return result.targetId === undefined
		? blocked
		: { ...blocked, targetId: result.targetId };
}

async function executeClaimedIacTargets(
	input: RankedIacExecutionInput,
	route: IacRouteController,
): Promise<IacTargetExecutionResult> {
	const attempts: IacRoutingAttempt[] = [];
	const notEvaluated = {
		evaluation: "not-evaluated",
		reservation: "not-created",
	} as const;
	const unknown = {
		evaluation: "unavailable",
		reservation: "unknown",
	} as const;
	const { ranking } = input;
	let coverage = ranking.coverage;
	if (
		!name(input.requestId) ||
		input.tenantId !== ranking.tenantId ||
		input.candidates.length > 256 ||
		ranking.ranking.length > 256
	)
		return {
			status: "denied",
			code: "ROUTING_INPUT_INVALID",
			coverage,
			budget: notEvaluated,
			attempts,
		};
	const targets = new Map(
		input.candidates.map((candidate) => [candidate.targetId, candidate]),
	);
	if (
		targets.size !== input.candidates.length ||
		targets.size !== ranking.ranking.length ||
		new Set(ranking.ranking.map((entry) => entry.targetId)).size !==
			ranking.ranking.length
	)
		return {
			status: "denied",
			code: "ROUTING_INPUT_INVALID",
			coverage,
			budget: notEvaluated,
			attempts,
		};
	let previous: ReturnType<typeof parseDecimal>;
	for (const [index, entry] of ranking.ranking.entries()) {
		const amount =
			entry.incrementalBilled.decimal.length <= 128
				? parseDecimal(entry.incrementalBilled.decimal)
				: undefined;
		if (
			!name(entry.targetId) ||
			![entry.inventoryHash, entry.modelHash, entry.quoteHash].every((digest) =>
				/^sha256:[a-f0-9]{64}$/u.test(digest),
			) ||
			!targets.has(entry.targetId) ||
			entry.rank !== index + 1 ||
			entry.incrementalBilled.currency !== "USD" ||
			amount === undefined ||
			amount.coefficient < 0n ||
			(previous !== undefined && compareDecimal(previous, amount) > 0)
		)
			return {
				status: "denied",
				code: "ROUTING_INPUT_INVALID",
				coverage,
				budget: notEvaluated,
				attempts,
			};
		previous = amount;
	}
	for (const entry of ranking.ranking) {
		const candidate = targets.get(entry.targetId);
		if (candidate === undefined)
			return {
				status: "uncertain",
				code: "ROUTING_INPUT_INVALID",
				coverage,
				budget: unknown,
				attempts,
			};
		const permit = await route.beginAttempt({
			targetId: entry.targetId,
			inventoryHash: entry.inventoryHash,
		});
		if ((await input.authority.verifyAttempt(permit)) !== true)
			throw new Error("route permit not active");
		let outputs: Record<string, string> | undefined;
		let rawAdmission: unknown;
		let reservationId: string | undefined;
		let executionOutcome: "completed" | "unknown" | undefined;
		let failureCode: string | undefined;
		let runReturned = false;
		let requiresReconciliation = false;
		try {
			const result = await candidate.run(
				input.requestId,
				{
					targetId: entry.targetId,
					inventoryHash: entry.inventoryHash,
					modelHash: entry.modelHash,
					quoteHash: entry.quoteHash,
				},
				permit,
			);
			runReturned = true;
			rawAdmission = result.admission;
			outputs = readOutputs(result.outputs);
		} catch (error) {
			/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: thrown provider values are untrusted inputs and must be inspected before use. */
			try {
				if (
					typeof error === "object" &&
					error !== null &&
					"requiresReconciliation" in error &&
					error.requiresReconciliation === true
				) {
					requiresReconciliation = true;
					if (
						"executionOutcome" in error &&
						(error.executionOutcome === "completed" ||
							error.executionOutcome === "unknown")
					)
						executionOutcome = error.executionOutcome;
					if (
						"code" in error &&
						typeof error.code === "string" &&
						name(error.code)
					)
						failureCode = error.code;
				}
				if (typeof error === "object" && error !== null && "admission" in error)
					rawAdmission = error.admission;
				if (
					typeof error === "object" &&
					error !== null &&
					"reservationId" in error &&
					typeof error.reservationId === "string" &&
					error.reservationId.length > 0 &&
					error.reservationId.length <= 204 &&
					error.reservationId.trim() === error.reservationId &&
					!/[\p{Cc}]/u.test(error.reservationId)
				)
					reservationId = error.reservationId;
			} catch {
				// A provider's uninspectable error cannot prove an admission.
				rawAdmission = undefined;
				reservationId = undefined;
				executionOutcome = undefined;
				failureCode = undefined;
				requiresReconciliation = true;
			}
			/* oxlint-enable anti-slop/no-runtime-typeof */
		}
		const admission = readAdmission(rawAdmission);
		/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: validate the parsed provider receipt before making any routing decision. */
		if (
			admission === undefined ||
			admission.requestId !== input.requestId ||
			admission.targetId !== entry.targetId ||
			admission.budget === undefined ||
			admission.budget === null ||
			typeof admission.budget.evaluation !== "string" ||
			!name(admission.budget.evaluation) ||
			typeof admission.budget.reservation !== "string" ||
			!name(admission.budget.reservation) ||
			typeof admission.status !== "string" ||
			!name(admission.status) ||
			typeof admission.code !== "string" ||
			(admission.status !== "admitted" && !name(admission.code))
		) {
			attempts.push({
				targetId: entry.targetId,
				status: "uncertain",
				code: "EXECUTION_OUTCOME_UNKNOWN",
				budget: unknown,
			});
			return withReservation(
				{
					status: "uncertain",
					code: "EXECUTION_OUTCOME_UNKNOWN",
					targetId: entry.targetId,
					coverage,
					budget: unknown,
					attempts,
				},
				reservationId,
			);
		}
		const budget = {
			evaluation: admission.budget.evaluation,
			reservation: admission.budget.reservation,
		};
		if (
			admission.status === "denied" &&
			(runReturned ||
				requiresReconciliation ||
				reservationId !== undefined ||
				admission.reservation !== undefined)
		) {
			attempts.push({
				targetId: entry.targetId,
				status: "uncertain",
				code: "INCONSISTENT_ADMISSION",
				budget: unknown,
			});
			return withReservation(
				{
					status: "uncertain",
					code: "INCONSISTENT_ADMISSION",
					targetId: entry.targetId,
					coverage,
					budget: unknown,
					attempts,
				},
				reservationId,
			);
		}
		attempts.push({
			targetId: entry.targetId,
			status: admission.status,
			code: admission.code,
			budget,
		});
		if (
			admission.status === "denied" &&
			(budget.evaluation === "denied" || budget.evaluation === "unavailable") &&
			budget.reservation === "not-created"
		) {
			await route.denyAttempt(permit);
			if (admission.code === "ROUTING_QUOTE_CHANGED") coverage = "partial";
			continue;
		}
		const heldAdmission =
			admission.status === "admitted" &&
			budget.evaluation === "allowed" &&
			budget.reservation === "held" &&
			typeof admission.reservation?.reservationId === "string" &&
			admission.reservation.reservationId === `iac:${input.requestId}` &&
			admission.inventoryHash === entry.inventoryHash &&
			admission.modelHash === entry.modelHash &&
			admission.quoteHash === entry.quoteHash;
		if (heldAdmission && outputs !== undefined)
			return {
				status: "selected",
				targetId: entry.targetId,
				outputs,
				admission,
				coverage,
				budget,
				attempts,
			};
		if (heldAdmission)
			return withExecutionOutcome(
				{
					status: "uncertain",
					code: failureCode ?? "EXECUTION_OUTCOME_UNKNOWN",
					targetId: entry.targetId,
					admission,
					coverage,
					budget,
					attempts,
					reservationId: admission.reservation?.reservationId,
				},
				executionOutcome,
			);
		if (
			admission.status === "replay" &&
			admission.code === "EXECUTION_ALREADY_CLAIMED" &&
			budget.evaluation === "allowed" &&
			budget.reservation === "held" &&
			admission.reservation?.reservationId === `iac:${input.requestId}`
		)
			return {
				status: "replay",
				code: admission.code,
				targetId: entry.targetId,
				admission,
				coverage,
				budget,
				attempts,
				reservationId: admission.reservation.reservationId,
			};
		return {
			status: "uncertain",
			code: admission.code || "EXECUTION_OUTCOME_UNKNOWN",
			targetId: entry.targetId,
			admission,
			coverage,
			budget:
				admission.status === "uncertain" &&
				(budget.reservation === "held" || budget.reservation === "uncertain")
					? { evaluation: "unavailable", reservation: budget.reservation }
					: unknown,
			attempts,
		};
		/* oxlint-enable anti-slop/no-runtime-typeof */
	}
	return {
		status: "denied",
		code: "NO_ADMISSIBLE_TARGET",
		coverage,
		budget: attempts.at(-1)?.budget ?? notEvaluated,
		attempts,
	};
}

function withReservation(
	result: IacTargetExecutionResult,
	reservationId: string | undefined,
): IacTargetExecutionResult {
	return reservationId === undefined ? result : { ...result, reservationId };
}

function withExecutionOutcome(
	result: IacTargetExecutionResult,
	executionOutcome: "completed" | "unknown" | undefined,
): IacTargetExecutionResult {
	return executionOutcome === undefined
		? result
		: { ...result, executionOutcome };
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- SAFETY: these parsers accept untrusted provider results and check each field before returning a bounded domain value. */
function readAdmission(value: unknown): IacRoutingAdmission | undefined {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return undefined;
		// SAFETY: the preceding checks establish a non-null object; every field is checked below.
		const row = value as Record<string, unknown>;
		const {
			requestId,
			targetId,
			status,
			code,
			message,
			budget,
			reservation,
			inventoryHash,
			modelHash,
			quoteHash,
		} = row;
		if (
			typeof requestId !== "string" ||
			typeof targetId !== "string" ||
			typeof status !== "string" ||
			typeof code !== "string" ||
			typeof message !== "string" ||
			message.length > 4096 ||
			typeof budget !== "object" ||
			budget === null ||
			Array.isArray(budget)
		)
			return undefined;
		// SAFETY: budget was checked as a non-null object; its fields are checked below.
		const amounts = budget as Record<string, unknown>;
		const evaluation = amounts.evaluation;
		const reservationState = amounts.reservation;
		if (typeof evaluation !== "string" || typeof reservationState !== "string")
			return undefined;
		let reserved: { reservationId: string } | undefined;
		if (reservation !== undefined) {
			if (
				typeof reservation !== "object" ||
				reservation === null ||
				Array.isArray(reservation)
			)
				return undefined;
			// SAFETY: reservation was checked as a non-null object; the id is checked below.
			const id = (reservation as Record<string, unknown>).reservationId;
			if (typeof id !== "string") return undefined;
			reserved = { reservationId: id };
		}
		if (
			(inventoryHash !== undefined && typeof inventoryHash !== "string") ||
			(modelHash !== undefined && typeof modelHash !== "string") ||
			(quoteHash !== undefined && typeof quoteHash !== "string")
		)
			return undefined;
		const parsed: MutableIacRoutingAdmission = {
			requestId,
			targetId,
			status,
			code,
			message,
			budget: { evaluation, reservation: reservationState },
		};
		if (reserved !== undefined) parsed.reservation = reserved;
		if (typeof inventoryHash === "string") parsed.inventoryHash = inventoryHash;
		if (typeof modelHash === "string") parsed.modelHash = modelHash;
		if (typeof quoteHash === "string") parsed.quoteHash = quoteHash;
		return parsed;
	} catch {
		return undefined;
	}
}

function readOutputs(value: unknown): Record<string, string> | undefined {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors);
		if (keys.length > 256) return undefined;
		const entries: [string, string][] = [];
		let size = 0;
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (
				!name(key) ||
				descriptor === undefined ||
				!descriptor.enumerable ||
				!("value" in descriptor) ||
				typeof descriptor.value !== "string" ||
				descriptor.value.length > 65_536
			)
				return undefined;
			size += key.length + descriptor.value.length;
			if (size > 1_048_576) return undefined;
			entries.push([key, descriptor.value]);
		}
		return Object.fromEntries(entries);
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/** Detach caller-owned data before reading any ranking fields. */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- SAFETY: this boundary inspects untrusted values without invoking their accessors or proxy traps. */
function rankingFields(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		utilTypes.isProxy(value) ||
		Array.isArray(value)
	)
		return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length) return undefined;
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
		result[key] = descriptor.value;
	}
	return result;
}

function snapshotRankingRequest(
	input: IacPricingRankingRequest,
): IacPricingRankingRequest | undefined {
	try {
		const fields = rankingFields(input, [
			"tenantId",
			"workloadRef",
			"action",
			"at",
			"horizon",
			"candidates",
		]);
		if (
			fields === undefined ||
			typeof fields.tenantId !== "string" ||
			typeof fields.workloadRef !== "string" ||
			typeof fields.action !== "string" ||
			typeof fields.at !== "string" ||
			typeof fields.horizon !== "string" ||
			utilTypes.isProxy(fields.candidates) ||
			!Array.isArray(fields.candidates) ||
			Object.getPrototypeOf(fields.candidates) !== Array.prototype
		)
			return undefined;
		if (
			![fields.tenantId, fields.workloadRef, fields.action].every(name) ||
			fields.at.length > 200 ||
			fields.horizon.length > 200 ||
			!Number.isFinite(Date.parse(fields.at)) ||
			!Number.isFinite(Date.parse(fields.horizon)) ||
			Date.parse(fields.horizon) <= Date.parse(fields.at)
		)
			return undefined;
		const length = Object.getOwnPropertyDescriptor(
			fields.candidates,
			"length",
		)?.value;
		if (
			typeof length !== "number" ||
			length === 0 ||
			length > 256 ||
			Reflect.ownKeys(fields.candidates).length !== length + 1
		)
			return undefined;
		const pending: {
			workloadRef: string;
			inventory: unknown;
			pricing: unknown;
		}[] = [];
		const allInputs: unknown[] = [];
		const targetIds = new Set<string>();
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(
				fields.candidates,
				String(index),
			);
			if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
			const candidate = rankingFields(descriptor.value, [
				"workloadRef",
				"inventory",
				"pricing",
			]);
			if (
				candidate === undefined ||
				typeof candidate.workloadRef !== "string" ||
				candidate.workloadRef.length > 200 ||
				typeof candidate.inventory !== "object" ||
				candidate.inventory === null ||
				utilTypes.isProxy(candidate.inventory) ||
				Array.isArray(candidate.inventory)
			)
				return undefined;
			const target = Object.getOwnPropertyDescriptor(
				candidate.inventory,
				"targetId",
			);
			if (
				!target?.enumerable ||
				!("value" in target) ||
				typeof target.value !== "string" ||
				target.value.length > 200 ||
				targetIds.has(target.value)
			)
				return undefined;
			targetIds.add(target.value);
			pending.push({
				workloadRef: candidate.workloadRef,
				inventory: candidate.inventory,
				pricing: candidate.pricing,
			});
			allInputs.push(candidate.inventory, candidate.pricing);
		}
		// The budget counts repeated aliases too; no tree is cloned until the entire
		// request fits, in addition to each model's existing per-input bounds.
		if (!areBoundedPricingInputs(allInputs)) return undefined;
		for (const candidate of pending) {
			if (
				!isBoundedPricingInput(candidate.inventory) ||
				!isBoundedPricingInput(candidate.pricing)
			)
				return undefined;
		}
		const candidates: IacPricingCandidate[] = [];
		for (const candidate of pending) {
			// SAFETY: Only the checked fields below are read before the full inventory schema is validated by pricing.
			const inventory = structuredClone(
				candidate.inventory,
			) as TargetPricingInventory;
			// SAFETY: The checked discriminant gates access; pricing validates the complete detached model before rating.
			const pricing = structuredClone(
				candidate.pricing,
			) as TargetPricingAvailability;
			if (
				inventory === null ||
				typeof inventory !== "object" ||
				Array.isArray(inventory) ||
				typeof inventory.targetId !== "string" ||
				typeof inventory.tenantId !== "string" ||
				pricing === null ||
				typeof pricing !== "object" ||
				Array.isArray(pricing) ||
				pricing.state === null ||
				typeof pricing.state !== "object" ||
				(pricing.state.case !== "model" &&
					pricing.state.case !== "unavailable") ||
				pricing.state.value === null ||
				typeof pricing.state.value !== "object"
			)
				return undefined;
			candidates.push({
				workloadRef: candidate.workloadRef,
				inventory,
				pricing,
			});
		}
		return {
			tenantId: fields.tenantId,
			workloadRef: fields.workloadRef,
			action: fields.action,
			at: fields.at,
			horizon: fields.horizon,
			candidates,
		};
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function invalidRanking(tenantId: string): IacPricingRankingResult {
	return {
		tenantId,
		coverage: "partial",
		budget: { evaluation: "not-evaluated", reservation: "not-created" },
		code: "ROUTING_INPUT_INVALID",
		ranking: [],
		rejected: [],
	};
}

/** Rank comparable, fully priced whole targets. This stage does not authorize spending. */
export function rankIacTargets(
	input: IacPricingRankingRequest,
): IacPricingRankingResult {
	const request = snapshotRankingRequest(input);
	if (request === undefined) return invalidRanking("");
	try {
		return rankSnapshot(request);
	} catch {
		// Malformed but inert data can still fail a downstream semantic validator.
		return invalidRanking(request.tenantId);
	}
}

function rankSnapshot(
	request: IacPricingRankingRequest,
): IacPricingRankingResult {
	const budget = {
		evaluation: "not-evaluated",
		reservation: "not-created",
	} as const;
	if (
		![request.tenantId, request.workloadRef, request.action].every(name) ||
		request.at.length > 200 ||
		request.horizon.length > 200 ||
		!Number.isFinite(Date.parse(request.at)) ||
		!Number.isFinite(Date.parse(request.horizon)) ||
		Date.parse(request.horizon) <= Date.parse(request.at) ||
		request.candidates.length === 0 ||
		request.candidates.length > 256 ||
		request.candidates.some((entry) => entry.inventory.targetId.length > 200) ||
		new Set(request.candidates.map((entry) => entry.inventory.targetId))
			.size !== request.candidates.length
	)
		return invalidRanking(request.tenantId);
	const ranking: IacPricingRanking[] = [];
	const rejected: IacPricingRankingResult["rejected"] = [];
	for (const candidate of request.candidates) {
		const targetId = candidate.inventory.targetId;
		if (
			candidate.inventory.tenantId !== request.tenantId ||
			candidate.workloadRef !== request.workloadRef
		) {
			rejected.push({
				targetId,
				code: "PRICING_NOT_COMPARABLE",
				reason: "candidate tenant or workload differs",
			});
			continue;
		}
		if (candidate.pricing.state.case === "model") {
			const scenario = candidate.pricing.state.value.scenario;
			if (
				scenario === undefined ||
				scenario === null ||
				scenario.at !== request.at ||
				scenario.horizon !== request.horizon ||
				scenario.action !== request.action
			) {
				rejected.push({
					targetId,
					code: "PRICING_NOT_COMPARABLE",
					reason: "candidate action or quote interval differs",
				});
				continue;
			}
		}
		const result = quoteTargetPricing(candidate.inventory, candidate.pricing);
		if (result.ok === false) {
			rejected.push({ targetId, code: result.code, reason: result.reason });
			continue;
		}
		const amount = result.quote.incremental?.billed;
		const decimal =
			amount === undefined ? undefined : parseDecimal(amount.decimal);
		if (
			amount === undefined ||
			amount.currency !== "USD" ||
			decimal === undefined ||
			decimal.coefficient < 0n
		) {
			rejected.push({
				targetId,
				code: "PRICING_NOT_COMPARABLE",
				reason: "candidate requires a nonnegative USD quote",
			});
			continue;
		}
		ranking.push({
			targetId,
			rank: 0,
			incrementalBilled: amount,
			source: result.source,
			modelId: result.modelId,
			revision: result.revision,
			modelHash: result.modelHash,
			inventoryHash: result.inventoryHash,
			quoteHash: result.quote.quoteHash,
		});
	}
	ranking.sort((left, right) => {
		const a = parseDecimal(left.incrementalBilled.decimal);
		const b = parseDecimal(right.incrementalBilled.decimal);
		if (a === undefined || b === undefined)
			throw new TypeError("invalid priced amount");
		return compareDecimal(a, b) || left.targetId.localeCompare(right.targetId);
	});
	const ranked = ranking.map((entry, index) => ({ ...entry, rank: index + 1 }));
	rejected.sort((left, right) => left.targetId.localeCompare(right.targetId));
	return {
		tenantId: request.tenantId,
		coverage: rejected.length === 0 ? "complete" : "partial",
		budget,
		ranking: ranked,
		rejected,
	};
}
