import { isAbsolute } from "node:path";
import { AlchemyContext } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import type * as Stack from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import type { ResourceScope, Target } from "./_generated/alchemy_iac_pb.js";
import {
	captureAlchemyOptions,
	captureAlchemyTarget,
	captureAlchemyTargetOption,
} from "./input-boundary.js";
import {
	type AlchemyCompositeGuard,
	AlchemyIacError,
	digestData,
	inspectAlchemyPlan,
	reinspectAlchemyPlan,
	verifyCompositeEnvironment,
} from "./plan.js";
import type {
	FinancialDecision,
	FinancialExpectation,
	FinancialPlan,
	FinancialPort,
	HeldFinancialDecision,
	IacDiff,
	IacDriftReport,
	IacProgram,
	IacProvider,
	IacRouteOperation,
	IacRoutePermit,
	IacRoutePort,
	IacRouteResolution,
	IacRouteResolver,
	UnpricedPolicyProof,
	UnpricedScopeProof,
} from "./port.js";
import {
	type CapturedAlchemyProgram,
	captureAlchemyProgram,
} from "./program-boundary.js";
import { captureAlchemySourceRequirements } from "./source-fence.js";
import {
	alchemyStateScopeKey,
	guardAlchemyStack,
	safeAlchemyFqn,
	safeAlchemyStateSegment,
	uniqueAlchemyFqns,
	verifyAlchemyStateIdentities,
} from "./state-identity.js";

export type { ResourceScope, Target } from "./_generated/alchemy_iac_pb.js";
export {
	ResourceScopeSchema,
	TargetSchema,
} from "./_generated/alchemy_iac_pb.js";
export type {
	AlchemyBindleMapping,
	AlchemyBindleOptions,
	AlchemyMappedPrimitive,
	AlchemyPrimitiveInput,
	AlchemyPrimitiveMapper,
	AlchemyPrimitiveSupport,
	AlchemyRequirementsDecision,
	BindleForAlchemy,
	PrimitiveDeclaration,
} from "./bindle.js";
export {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "./bindle.js";
export { captureAlchemyOptions } from "./input-boundary.js";
export type {
	AlchemyCompositeEffect,
	AlchemyCompositeEnvironment,
	AlchemyCompositeGuard,
	AlchemyCompositeObservation,
	AlchemyHistoricalResource,
	AlchemyHistoricalSource,
} from "./plan.js";
export { AlchemyIacError, hashAlchemyPriorState } from "./plan.js";
export type {
	FinancialDecision,
	FinancialExpectation,
	FinancialPlan,
	FinancialPort,
	HeldFinancialDecision,
	IacDiff,
	IacDirectRouteAttempt,
	IacDirectRouteResult,
	IacDriftReport,
	IacProgram,
	IacProvider,
	IacRouteContext,
	IacRouteOperation,
	IacRouteOutcome,
	IacRoutePermit,
	IacRoutePort,
	IacRouteResolution,
	IacRouteResolver,
	UnpricedPolicyProof,
	UnpricedScopeProof,
	UnverifiedUnpricedPolicyProof,
	UnverifiedUnpricedScopeProof,
} from "./port.js";
export type { CapturedAlchemyProgram } from "./program-boundary.js";
export { captureAlchemyProgram } from "./program-boundary.js";
export type {
	AlchemySourceClaim,
	AlchemySourceFence,
	AlchemySourceRequirement,
	AlchemySourceResource,
} from "./source-fence.js";
export {
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";
export { alchemyStateScopeKey } from "./state-identity.js";

export type AlchemyTargetInput = Omit<Target, "$typeName" | "resources"> & {
	readonly resources: readonly Omit<ResourceScope, "$typeName">[];
};

export function alchemyTarget(input: AlchemyTargetInput): Target {
	return captureAlchemyTarget(input);
}

/** The host must verify exclusive durable ownership of this actual state backend. */
export interface AlchemyStateOwnershipCheck {
	readonly phase: "plan" | "apply" | "complete" | "drift";
	readonly operation: "deploy" | "destroy";
	readonly operationGeneration?: string;
	readonly tenantId: string;
	readonly targetId: string;
	readonly sourceDigest: string;
	readonly inventoryEvidenceRef: string;
	readonly resources: readonly {
		readonly resourceId: string;
		readonly resourceType: string;
		readonly providerId: string;
		readonly providerAccountRef: string;
		readonly productId: string;
	}[];
	readonly program: {
		readonly programId: string;
		readonly deploymentId: string;
		readonly resourceId: string;
		readonly provider: string;
		readonly driver: string;
		readonly logicalStackName: string;
		readonly declarationPresence: "absent" | "present";
		readonly declarationDigest: string;
		readonly resource?: object;
	};
	readonly state: {
		readonly backendRef: string;
		readonly ownershipEpoch: string;
		readonly stackName: string;
		readonly stage: string;
		readonly scopeKey: string;
		readonly runtimeDirectory: string;
	};
}

export interface AlchemyStateOwnership {
	readonly backendRef: string;
	readonly ownershipEpoch: string;
	readonly verify: (
		input: AlchemyStateOwnershipCheck,
	) => boolean | Promise<boolean>;
}

export interface AlchemyIacProviderOptions<
	Output,
	Requirements,
	Assessment extends object,
> {
	readonly stack: [Requirements] extends [never]
		? Stack.ConfiguredStack<Output, never>
		: Requirements extends unknown
			? Stack.ConfiguredStack<Output, Requirements>
			: never;
	readonly target: Target;
	/** A host-supplied runtime layer, including any credentials and execution services. */
	readonly runtimeLayer: Layer.Layer<Alchemist.Services, unknown, never>;
	readonly runtimeDirectory: string;
	/** Independently authenticate and fence logical ownership of physical state. */
	readonly stateOwnership: AlchemyStateOwnership;
	readonly financial: FinancialPort<Assessment>;
	/** The host supplies one durable route authority shared by all candidate targets. */
	readonly route?: IacRoutePort | undefined;
	/** Authenticate the durable operation generation and return its shared route identity. */
	readonly resolveRoute?: IacRouteResolver | undefined;
	/** Host-owned authorization and complete source classification for this target. */
	readonly composite: AlchemyCompositeGuard;
}

export interface AlchemyIacProvider<Assessment extends object>
	extends IacProvider {
	/** A plan-scoped assessment. Ranking this result does not reserve a budget. */
	assessPricing(program: IacProgram): Promise<Assessment & { diff: IacDiff }>;
	/** Includes the admission receipt needed for budget reconciliation. */
	applyWithAdmission(
		program: IacProgram,
		requestId?: string,
		expected?: FinancialExpectation,
		permit?: IacRoutePermit,
	): Promise<{
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	}>;
	destroyWithAdmission(
		program: IacProgram,
		requestId?: string,
		expected?: FinancialExpectation,
		permit?: IacRoutePermit,
	): Promise<{ admission: HeldFinancialDecision }>;
}

interface RouteExecutionState {
	invoked: boolean;
	result?: {
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	};
	error?: AlchemyIacError;
}

interface InspectedFinancialDecision
	extends Omit<FinancialDecision, "reservation" | "unpricedPolicyProof"> {
	reservation?:
		| {
				reservationId: string;
				unboundedExposure?: boolean;
				unpricedScopeProof?: UnpricedScopeProof;
		  }
		| undefined;
	unpricedPolicyProof?: UnpricedPolicyProof | undefined;
}

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function logicalName(value: string, maximum: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maximum &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function reservationName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 204 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: host configuration crosses the adapter boundary and malformed callbacks must fail before any stack code executes. */
function captureStateOwnership(
	input: AlchemyStateOwnership,
): AlchemyStateOwnership {
	try {
		const { backendRef, ownershipEpoch, verify } = input;
		if (
			typeof backendRef !== "string" ||
			!name(backendRef) ||
			typeof ownershipEpoch !== "string" ||
			!name(ownershipEpoch) ||
			typeof verify !== "function"
		)
			throw new Error("invalid state owner");
		return Object.freeze({
			backendRef,
			ownershipEpoch,
			verify: verify.bind(input),
		});
	} catch {
		throw new AlchemyIacError(
			"STATE_SCOPE_UNVERIFIED",
			"host state ownership verification is malformed or unavailable",
		);
	}
}

function captureCompositeGuard(
	input: AlchemyCompositeGuard | undefined,
): AlchemyCompositeGuard {
	try {
		if (input === undefined) throw new Error("missing host guard");
		const {
			proofRef,
			environmentDigest,
			verifyEnvironment,
			verifyPlan,
			sourceRequirements,
		} = input;
		const capturedRequirements =
			captureAlchemySourceRequirements(sourceRequirements);
		if (
			typeof proofRef !== "string" ||
			!name(proofRef) ||
			typeof environmentDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(environmentDigest) ||
			typeof verifyEnvironment !== "function" ||
			typeof verifyPlan !== "function" ||
			capturedRequirements === undefined
		)
			throw new Error("invalid host guard");
		const base = {
			proofRef,
			environmentDigest,
			verifyEnvironment: verifyEnvironment.bind(input),
			verifyPlan: verifyPlan.bind(input),
		};
		return Object.freeze({ ...base, sourceRequirements: capturedRequirements });
	} catch {
		throw new AlchemyIacError(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"host sandbox verification is malformed or unavailable",
		);
	}
}

function captureFinancialPort<Assessment extends object>(
	input: FinancialPort<Assessment>,
): FinancialPort<Assessment> {
	try {
		const { assess, admit, revalidate, uncertain } = input;
		if (
			typeof assess !== "function" ||
			typeof admit !== "function" ||
			typeof revalidate !== "function" ||
			typeof uncertain !== "function"
		)
			throw new Error("invalid financial port");
		return Object.freeze({
			assess: assess.bind(input),
			admit: admit.bind(input),
			revalidate: revalidate.bind(input),
			uncertain: uncertain.bind(input),
		});
	} catch {
		throw new AlchemyIacError(
			"FINANCIAL_AUTHORITY_UNAVAILABLE",
			"the trusted financial port is malformed or unavailable",
		);
	}
}

function captureRoutePort(
	input: IacRoutePort | undefined,
): IacRoutePort | undefined {
	if (input === undefined) return undefined;
	try {
		const { persistence, consumeAttempt, verifyAttempt, runDirect } = input;
		if (
			persistence !== "durable-cas" ||
			typeof consumeAttempt !== "function" ||
			typeof verifyAttempt !== "function" ||
			typeof runDirect !== "function"
		)
			throw new Error("invalid route port");
		return Object.freeze({
			persistence,
			consumeAttempt: consumeAttempt.bind(input),
			verifyAttempt: verifyAttempt.bind(input),
			runDirect: runDirect.bind(input),
		});
	} catch {
		throw new AlchemyIacError(
			"ROUTE_AUTHORITY_UNAVAILABLE",
			"the trusted route port is malformed or unavailable",
		);
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: admission receipts cross a provider boundary; inspect own data properties before returning an independent domain value. */
function readRoutePermit(input: unknown): IacRoutePermit | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const read = (key: string): unknown => {
			const descriptor = properties[key];
			if (descriptor === undefined || !("value" in descriptor))
				return undefined;
			return descriptor.value;
		};
		const tenantId = read("tenantId");
		const requestId = read("requestId");
		const operationId = read("operationId");
		const targetId = read("targetId");
		const inventoryHash = read("inventoryHash");
		const attemptId = read("attemptId");
		if (
			typeof tenantId !== "string" ||
			!name(tenantId) ||
			typeof requestId !== "string" ||
			!name(requestId) ||
			typeof operationId !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(operationId) ||
			typeof targetId !== "string" ||
			!name(targetId) ||
			typeof inventoryHash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(inventoryHash) ||
			typeof attemptId !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/u.test(attemptId)
		)
			return undefined;
		return Object.freeze({
			tenantId,
			requestId,
			operationId,
			targetId,
			inventoryHash,
			attemptId,
		});
	} catch {
		return undefined;
	}
}

function readRouteOperation(input: unknown): IacRouteOperation | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const id = properties.operationId;
		const proof = properties.authorization;
		if (
			id === undefined ||
			!("value" in id) ||
			typeof id.value !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(id.value) ||
			proof === undefined ||
			!("value" in proof) ||
			typeof proof.value !== "string" ||
			proof.value.length === 0 ||
			proof.value.length > 4096 ||
			proof.value.trim() !== proof.value ||
			/[\p{Cc}]/u.test(proof.value)
		)
			return undefined;
		return Object.freeze({ operationId: id.value, authorization: proof.value });
	} catch {
		return undefined;
	}
}

function readRouteResolution(input: unknown): IacRouteResolution | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const requestId = properties.requestId;
		const operation = properties.operation;
		if (
			requestId === undefined ||
			!("value" in requestId) ||
			typeof requestId.value !== "string" ||
			!name(requestId.value) ||
			operation === undefined ||
			!("value" in operation)
		)
			return undefined;
		const checked = readRouteOperation(operation.value);
		return checked === undefined
			? undefined
			: Object.freeze({ requestId: requestId.value, operation: checked });
	} catch {
		return undefined;
	}
}

function readRouteCompletion(
	input: unknown,
): "executed" | "replay" | "uncertain" | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const status = properties.status;
		if (status === undefined || !("value" in status)) return undefined;
		if (status.value === "replay" || status.value === "uncertain")
			return status.value;
		const value = properties.value;
		return status.value === "executed" &&
			value !== undefined &&
			"value" in value &&
			value.value === true
			? "executed"
			: undefined;
	} catch {
		return undefined;
	}
}

function readFinancialExpectation(
	input: unknown,
): FinancialExpectation | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const read = (key: string): unknown => {
			const descriptor = properties[key];
			if (descriptor === undefined) return undefined;
			if (!("value" in descriptor)) throw new Error("expectation accessor");
			return descriptor.value;
		};
		const kind = read("kind");
		const targetId = read("targetId");
		const inventoryHash = read("inventoryHash");
		const modelHash = read("modelHash");
		const quoteHash = read("quoteHash");
		if (
			typeof targetId !== "string" ||
			!name(targetId) ||
			typeof inventoryHash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(inventoryHash)
		)
			return undefined;
		if (kind === "unpriced") {
			if (modelHash !== undefined || quoteHash !== undefined) return undefined;
			return Object.freeze({ kind, targetId, inventoryHash });
		}
		if (
			(kind !== undefined && kind !== "priced") ||
			typeof modelHash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(modelHash) ||
			typeof quoteHash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(quoteHash)
		)
			return undefined;
		return Object.freeze({ targetId, inventoryHash, modelHash, quoteHash });
	} catch {
		return undefined;
	}
}

function readUnpricedScopeProof(
	input: unknown,
): UnpricedScopeProof | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const read = (source: unknown, key: string): unknown => {
			if (
				typeof source !== "object" ||
				source === null ||
				Array.isArray(source)
			)
				return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (descriptor === undefined || !("value" in descriptor))
				return undefined;
			return descriptor.value;
		};
		const identityInput = read(input, "identity");
		if (
			typeof identityInput !== "object" ||
			identityInput === null ||
			Array.isArray(identityInput)
		)
			return undefined;
		const tenantId = read(identityInput, "tenantId");
		const budgetId = read(identityInput, "budgetId");
		const periodId = read(identityInput, "periodId");
		const policyRevision = read(identityInput, "policyRevision");
		const accountInput = read(input, "providerAccountIds");
		const authorityRef = read(input, "authorityRef");
		const evidenceRef = read(input, "evidenceRef");
		const ownershipEpoch = read(input, "ownershipEpoch");
		const observedAt = read(input, "observedAt");
		const exclusiveUntilSettled = read(input, "exclusiveUntilSettled");
		const noSharedEntitlements = read(input, "noSharedEntitlements");
		const signature = read(input, "signature");
		if (
			typeof tenantId !== "string" ||
			!name(tenantId) ||
			typeof budgetId !== "string" ||
			!name(budgetId) ||
			typeof periodId !== "string" ||
			!name(periodId) ||
			typeof policyRevision !== "string" ||
			!name(policyRevision) ||
			!Array.isArray(accountInput) ||
			typeof authorityRef !== "string" ||
			!name(authorityRef) ||
			typeof evidenceRef !== "string" ||
			!name(evidenceRef) ||
			typeof ownershipEpoch !== "string" ||
			!name(ownershipEpoch) ||
			typeof observedAt !== "string" ||
			!name(observedAt) ||
			!Number.isFinite(Date.parse(observedAt)) ||
			exclusiveUntilSettled !== true ||
			noSharedEntitlements !== true ||
			typeof signature !== "string" ||
			signature.length === 0 ||
			signature.length > 4096 ||
			/[\p{Cc}]/u.test(signature)
		)
			return undefined;
		const accountProperties = Object.getOwnPropertyDescriptors(accountInput);
		const length = Object.getOwnPropertyDescriptor(accountInput, "length");
		if (
			length === undefined ||
			!("value" in length) ||
			typeof length.value !== "number" ||
			!Number.isSafeInteger(length.value) ||
			length.value < 1 ||
			length.value > 256
		)
			return undefined;
		const providerAccountIds: string[] = [];
		for (let index = 0; index < length.value; index++) {
			const entry = accountProperties[String(index)];
			if (
				entry === undefined ||
				!("value" in entry) ||
				typeof entry.value !== "string" ||
				!name(entry.value)
			)
				return undefined;
			providerAccountIds.push(entry.value);
		}
		if (new Set(providerAccountIds).size !== providerAccountIds.length)
			return undefined;
		return {
			identity: { tenantId, budgetId, periodId, policyRevision },
			providerAccountIds,
			authorityRef,
			evidenceRef,
			ownershipEpoch,
			observedAt,
			exclusiveUntilSettled,
			noSharedEntitlements,
			signature,
		};
	} catch {
		return undefined;
	}
}

function readUnpricedPolicyProof(
	input: unknown,
): UnpricedPolicyProof | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const read = (key: string): unknown => {
			const descriptor = properties[key];
			if (descriptor === undefined || !("value" in descriptor))
				return undefined;
			return descriptor.value;
		};
		const identityInput = read("identity");
		if (
			typeof identityInput !== "object" ||
			identityInput === null ||
			Array.isArray(identityInput)
		)
			return undefined;
		const identityProperties = Object.getOwnPropertyDescriptors(identityInput);
		const identityRead = (key: string): unknown => {
			const descriptor = identityProperties[key];
			if (descriptor === undefined || !("value" in descriptor))
				return undefined;
			return descriptor.value;
		};
		const tenantId = identityRead("tenantId");
		const budgetId = identityRead("budgetId");
		const periodId = identityRead("periodId");
		const policyRevision = identityRead("policyRevision");
		const requestDigest = read("requestDigest");
		const inventoryHash = read("inventoryHash");
		const policyHash = read("policyHash");
		const effect = read("effect");
		const evidenceRef = read("evidenceRef");
		const obligationsSatisfied = read("obligationsSatisfied");
		const observedAt = read("observedAt");
		const validUntil = read("validUntil");
		if (
			typeof tenantId !== "string" ||
			!name(tenantId) ||
			typeof budgetId !== "string" ||
			!name(budgetId) ||
			typeof periodId !== "string" ||
			!name(periodId) ||
			typeof policyRevision !== "string" ||
			!name(policyRevision) ||
			typeof requestDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(requestDigest) ||
			typeof inventoryHash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(inventoryHash) ||
			typeof policyHash !== "string" ||
			!name(policyHash) ||
			(effect !== "allow" && effect !== "allow-degraded") ||
			typeof evidenceRef !== "string" ||
			!name(evidenceRef) ||
			obligationsSatisfied !== true ||
			typeof observedAt !== "string" ||
			!name(observedAt) ||
			typeof validUntil !== "string" ||
			!name(validUntil) ||
			!Number.isFinite(Date.parse(observedAt)) ||
			!Number.isFinite(Date.parse(validUntil)) ||
			Date.parse(observedAt) >= Date.parse(validUntil)
		)
			return undefined;
		return {
			requestDigest,
			inventoryHash,
			identity: { tenantId, budgetId, periodId, policyRevision },
			policyHash,
			effect,
			evidenceRef,
			obligationsSatisfied,
			observedAt,
			validUntil,
		};
	} catch {
		return undefined;
	}
}

function readFinancialDecision(
	input: unknown,
): InspectedFinancialDecision | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const read = (key: string): unknown => {
			const descriptor = properties[key];
			if (descriptor === undefined) return undefined;
			if (!("value" in descriptor)) throw new Error("receipt accessor");
			return descriptor.value;
		};
		const requestId = read("requestId");
		const targetId = read("targetId");
		const status = read("status");
		const code = read("code");
		const message = read("message");
		const budgetInput = read("budget");
		const reservationInput = read("reservation");
		const requestDigest = read("requestDigest");
		const inventoryHash = read("inventoryHash");
		const modelHash = read("modelHash");
		const quoteHash = read("quoteHash");
		const unpricedPolicyProof = readUnpricedPolicyProof(
			read("unpricedPolicyProof"),
		);
		if (
			typeof requestId !== "string" ||
			!name(requestId) ||
			typeof targetId !== "string" ||
			!name(targetId) ||
			typeof status !== "string" ||
			!["admitted", "denied", "uncertain", "replay"].includes(status) ||
			typeof code !== "string" ||
			(status !== "admitted" && !name(code)) ||
			(code !== "" && !name(code)) ||
			typeof message !== "string" ||
			message.length > 4096 ||
			(requestDigest !== undefined &&
				(typeof requestDigest !== "string" || requestDigest.length > 200)) ||
			typeof budgetInput !== "object" ||
			budgetInput === null ||
			Array.isArray(budgetInput) ||
			(inventoryHash !== undefined &&
				(typeof inventoryHash !== "string" || inventoryHash.length > 200)) ||
			(modelHash !== undefined &&
				(typeof modelHash !== "string" || modelHash.length > 200)) ||
			(quoteHash !== undefined &&
				(typeof quoteHash !== "string" || quoteHash.length > 200))
		)
			return undefined;
		const budgetProperties = Object.getOwnPropertyDescriptors(budgetInput);
		const evaluation = budgetProperties.evaluation;
		const reservation = budgetProperties.reservation;
		if (
			evaluation === undefined ||
			!("value" in evaluation) ||
			typeof evaluation.value !== "string" ||
			!name(evaluation.value) ||
			reservation === undefined ||
			!("value" in reservation) ||
			typeof reservation.value !== "string" ||
			!name(reservation.value)
		)
			return undefined;
		let reservationId: string | undefined;
		let unboundedExposure: boolean | undefined;
		let unpricedScopeProof: UnpricedScopeProof | undefined;
		if (reservationInput !== undefined) {
			if (
				typeof reservationInput !== "object" ||
				reservationInput === null ||
				Array.isArray(reservationInput)
			)
				return undefined;
			const id = Object.getOwnPropertyDescriptor(
				reservationInput,
				"reservationId",
			);
			if (
				id === undefined ||
				!("value" in id) ||
				typeof id.value !== "string" ||
				!reservationName(id.value)
			)
				return undefined;
			reservationId = id.value;
			const unbounded = Object.getOwnPropertyDescriptor(
				reservationInput,
				"unboundedExposure",
			);
			if (unbounded !== undefined) {
				if (!("value" in unbounded) || typeof unbounded.value !== "boolean")
					return undefined;
				unboundedExposure = unbounded.value;
			}
			const scope = Object.getOwnPropertyDescriptor(
				reservationInput,
				"unpricedScopeProof",
			);
			if (scope !== undefined && "value" in scope)
				unpricedScopeProof = readUnpricedScopeProof(scope.value);
		}
		if (
			status === "denied" &&
			(reservationId !== undefined ||
				reservation.value !== "not-created" ||
				!["denied", "unavailable"].includes(evaluation.value))
		)
			return undefined;
		const result: InspectedFinancialDecision = {
			requestId,
			targetId,
			status,
			code,
			message,
			budget: { evaluation: evaluation.value, reservation: reservation.value },
		};
		if (reservationId !== undefined) {
			result.reservation = { reservationId };
			if (unboundedExposure !== undefined)
				result.reservation.unboundedExposure = unboundedExposure;
			if (unpricedScopeProof !== undefined)
				result.reservation.unpricedScopeProof = unpricedScopeProof;
		}
		if (typeof inventoryHash === "string") result.inventoryHash = inventoryHash;
		if (typeof requestDigest === "string") result.requestDigest = requestDigest;
		if (typeof modelHash === "string") result.modelHash = modelHash;
		if (typeof quoteHash === "string") result.quoteHash = quoteHash;
		if (unpricedPolicyProof !== undefined)
			result.unpricedPolicyProof = unpricedPolicyProof;
		return result;
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

function scopeMatches(
	scope: UnpricedScopeProof | undefined,
	policy: UnpricedPolicyProof | undefined,
	target: Target,
): boolean {
	if (scope === undefined || policy === undefined) return false;
	const a = scope.identity;
	const b = policy.identity;
	if (
		a.tenantId !== b.tenantId ||
		a.budgetId !== b.budgetId ||
		a.periodId !== b.periodId ||
		a.policyRevision !== b.policyRevision
	)
		return false;
	const accounts = [
		...new Set(target.resources.map((row) => row.providerAccountRef)),
	].sort();
	const claimed = [...scope.providerAccountIds].sort();
	return (
		accounts.length === claimed.length &&
		accounts.every((account, index) => account === claimed[index])
	);
}

// HoBo's IaC port exposes bounded string-valued outputs. Never silently drop
// outputs after a provider has run: an unrepresentable result needs recovery.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this parser checks the untrusted provider output before returning bounded string-valued data. */
function readOutputs(value: unknown): Record<string, string> | undefined {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
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
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** An external adapter. The host must execute trusted stack code in its sandbox. */
export function createAlchemyIacProvider<
	Output,
	Requirements,
	Assessment extends object,
>(
	inputOptions: AlchemyIacProviderOptions<Output, Requirements, Assessment>,
): AlchemyIacProvider<Assessment> {
	const options = captureAlchemyOptions(inputOptions);
	const target = captureAlchemyTargetOption(options);
	// SAFETY: every distributed branch is already a closed, configured stack; Requirements only describes its internally supplied provider metadata.
	const suppliedStack = options.stack as Stack.ConfiguredStack<
		Output,
		Requirements
	>;
	const composite = captureCompositeGuard(options.composite);
	const route = captureRoutePort(options.route);
	const financial = captureFinancialPort(options.financial);
	const resolveRoute = options.resolveRoute;
	const runtimeLayer = options.runtimeLayer;
	const runtimeDirectory = options.runtimeDirectory;
	if (
		!safeAlchemyStateSegment(target.stackName) ||
		!safeAlchemyStateSegment(target.stage) ||
		target.resources.some((entry) => !safeAlchemyFqn(entry.resourceId)) ||
		!uniqueAlchemyFqns(target.resources.map((entry) => entry.resourceId))
	)
		throw new AlchemyIacError(
			"STATE_IDENTITY_INVALID",
			"stack, stage, and resource identities must be safe and round-trip through Alchemy state storage",
		);
	const stack = guardAlchemyStack(suppliedStack, {
		stack: target.stackName,
		stage: target.stage,
	});
	if (
		!isAbsolute(runtimeDirectory) ||
		stack.stackName !== target.stackName ||
		![
			target.targetId,
			target.tenantId,
			target.stackName,
			target.stage,
			target.programResourceId,
			target.inventoryEvidenceRef,
		].every(name) ||
		!/^sha256:[a-f0-9]{64}$/u.test(target.sourceDigest) ||
		target.resources.length === 0 ||
		target.resources.length > 256 ||
		target.resources.some(
			(entry) =>
				![
					entry.resourceId,
					entry.resourceType,
					entry.providerId,
					entry.providerAccountRef,
					entry.productId,
				].every(name),
		) ||
		new Set(target.resources.map((entry) => entry.resourceId)).size !==
			target.resources.length
	) {
		throw new AlchemyIacError(
			"TARGET_INVALID",
			"a bounded target, complete resource scopes, source digest and absolute runtime directory are required",
		);
	}
	const stateOwnership = captureStateOwnership(options.stateOwnership);
	const stateScopeKey = alchemyStateScopeKey(target.stackName, target.stage);
	const state = Object.freeze({
		backendRef: stateOwnership.backendRef,
		ownershipEpoch: stateOwnership.ownershipEpoch,
		stackName: target.stackName,
		stage: target.stage,
		scopeKey: stateScopeKey,
		runtimeDirectory,
	});
	const ownershipResources = Object.freeze(
		target.resources.map((resource) =>
			Object.freeze({
				resourceId: resource.resourceId,
				resourceType: resource.resourceType,
				providerId: resource.providerId,
				providerAccountRef: resource.providerAccountRef,
				productId: resource.productId,
			}),
		),
	);
	const previews = new Map<string, string>();
	const claimed = new Map<string, string>();
	const running = new Set<string>();
	const unresolved = new Map<string, string | undefined>();
	const programSnapshots = new WeakMap<IacProgram, CapturedAlchemyProgram>();
	const snapshotProgram = (program: IacProgram): IacProgram => {
		const captured = captureAlchemyProgram(program);
		programSnapshots.set(captured.program, captured);
		return captured.program;
	};
	const capturedProgram = (program: IacProgram): CapturedAlchemyProgram => {
		const captured = programSnapshots.get(program);
		if (captured === undefined)
			throw new AlchemyIacError(
				"PROGRAM_INVALID",
				"program snapshot is unavailable",
			);
		return captured;
	};
	const checkProgram = (program: IacProgram): string => {
		if (
			![
				program.deploymentId,
				program.resourceId,
				program.provider,
				program.driver,
			].every(name) ||
			!logicalName(program.programId, 401) ||
			!logicalName(program.stackName, 602) ||
			program.resourceId !== target.programResourceId ||
			(program.operationGeneration !== undefined &&
				!name(program.operationGeneration)) ||
			!["preview", "apply", "destroy"].includes(program.action)
		) {
			throw new AlchemyIacError(
				"PROGRAM_SCOPE_MISMATCH",
				"program does not match the configured target",
			);
		}
		return digestData({
			programId: program.programId,
			deploymentId: program.deploymentId,
			resourceId: program.resourceId,
			provider: program.provider,
			driver: program.driver,
			stackName: program.stackName,
			operation: program.action === "destroy" ? "destroy" : "deploy",
			operationGeneration: program.operationGeneration ?? "",
			declarationDigest: capturedProgram(program).declarationDigest,
			targetId: target.targetId,
			tenantId: target.tenantId,
			stateBackend: state.backendRef,
			stateScope: state.scopeKey,
			ownershipEpoch: state.ownershipEpoch,
		});
	};
	const programIdentity = (program: IacProgram) => {
		const captured = capturedProgram(program);
		return Object.freeze({
			programId: program.programId,
			deploymentId: program.deploymentId,
			resourceId: program.resourceId,
			provider: program.provider,
			driver: program.driver,
			logicalStackName: program.stackName,
			declarationPresence: captured.declarationPresence,
			declarationDigest: captured.declarationDigest,
		});
	};
	const ownershipProgram = (program: IacProgram) =>
		Object.freeze({
			...programIdentity(program),
			...(program.resource === undefined
				? undefined
				: { resource: program.resource }),
		});
	const scopedPlanDigest = (nativeDigest: string, program: IacProgram) =>
		digestData({
			domain: "hobo.alchemy.scoped-plan/v1",
			nativeDigest,
			tenantId: target.tenantId,
			targetId: target.targetId,
			program: programIdentity(program),
			operationGeneration: program.operationGeneration ?? null,
			backendRef: state.backendRef,
			scopeKey: state.scopeKey,
			ownershipEpoch: state.ownershipEpoch,
		});
	const verifyStateOwnership = async (
		program: IacProgram,
		phase: AlchemyStateOwnershipCheck["phase"],
	): Promise<boolean> => {
		try {
			return (
				(await stateOwnership.verify(
					Object.freeze({
						phase,
						operation: program.action === "destroy" ? "destroy" : "deploy",
						...(program.operationGeneration === undefined
							? undefined
							: { operationGeneration: program.operationGeneration }),
						tenantId: target.tenantId,
						targetId: target.targetId,
						sourceDigest: target.sourceDigest,
						inventoryEvidenceRef: target.inventoryEvidenceRef,
						resources: ownershipResources,
						program: ownershipProgram(program),
						state,
					}),
				)) === true
			);
		} catch {
			return false;
		}
	};
	const requireStateOwnership = async (
		program: IacProgram,
		phase: AlchemyStateOwnershipCheck["phase"],
	): Promise<void> => {
		if (!(await verifyStateOwnership(program, phase)))
			throw new AlchemyIacError(
				"STATE_SCOPE_UNVERIFIED",
				"host could not verify ownership of the physical state scope",
			);
	};
	const run = async <A>(
		effect: Effect.Effect<
			A,
			unknown,
			Alchemist.Services | import("effect/Scope").Scope
		>,
	): Promise<A> => {
		const supplied = Effect.scoped(
			Effect.provide(effect, runtimeLayer).pipe(
				Effect.provideService(AlchemyContext, {
					dotAlchemy: runtimeDirectory,
					dev: false,
					adopt: false,
				}),
			),
		);
		// SAFETY: the runtime layer and AlchemyContext supply the declared services, and scoped supplies Scope.
		const complete = supplied as Effect.Effect<A, unknown, never>;
		return Effect.runPromise(complete);
	};
	const planned = (program: IacProgram) =>
		program.action === "destroy"
			? Alchemist.plan({
					stack,
					stage: target.stage,
					operation: "destroy",
				})
			: Alchemist.plan({
					stack,
					stage: target.stage,
					operation: "deploy",
				});
	const financialInputs = (
		digest: string,
		program: IacProgram,
	): FinancialPlan => ({
		targetId: target.targetId,
		tenantId: target.tenantId,
		planDigest: digest,
		operation: program.action === "destroy" ? "destroy" : "deploy",
		evidenceRef: target.inventoryEvidenceRef,
		resources: target.resources.map(
			({ resourceId, providerId, providerAccountRef, productId }) => ({
				resourceId,
				providerId,
				providerAccountRef,
				productId,
			}),
		),
	});
	const resolveAuthorizedOperation = async (
		program: IacProgram,
		requestId: string | undefined,
	): Promise<IacRouteResolution | undefined> => {
		if (resolveRoute === undefined || program.operationGeneration === undefined)
			return undefined;
		try {
			return readRouteResolution(
				await resolveRoute(
					Object.freeze({
						tenantId: target.tenantId,
						deploymentId: program.deploymentId,
						programId: program.programId,
						resourceId: program.resourceId,
						logicalStackName: program.stackName,
						declarationDigest: capturedProgram(program).declarationDigest,
						operation: program.action === "destroy" ? "destroy" : "deploy",
						operationGeneration: program.operationGeneration,
						requestId,
					}),
				),
			);
		} catch {
			return undefined;
		}
	};
	const verifyRoute = async (
		input: IacRoutePermit,
		requestId: string,
		operation: IacRouteOperation,
		expected?: FinancialExpectation,
	): Promise<IacRoutePermit | undefined> => {
		const permit = readRoutePermit(input);
		if (
			route?.persistence !== "durable-cas" ||
			permit === undefined ||
			permit.tenantId !== target.tenantId ||
			permit.requestId !== requestId ||
			permit.operationId !== operation.operationId ||
			permit.targetId !== target.targetId ||
			(expected !== undefined &&
				permit.inventoryHash !== expected.inventoryHash)
		)
			return undefined;
		try {
			return (await route.verifyAttempt(permit)) === true ? permit : undefined;
		} catch {
			return undefined;
		}
	};
	const markUncertain = async (reservationId: string): Promise<void> => {
		try {
			await financial.uncertain(reservationId);
		} catch {
			/* preserve the durable hold */
		}
	};
	const assessPricing: AlchemyIacProvider<Assessment>["assessPricing"] = async (
		program,
	) => {
		const stableProgram = snapshotProgram(program);
		const key = checkProgram(stableProgram);
		if (!previews.has(key) && previews.size >= 128)
			throw new AlchemyIacError(
				"PREVIEW_LIMIT",
				"provider preview capacity reached",
			);
		await requireStateOwnership(stableProgram, "plan");
		verifyCompositeEnvironment(
			composite,
			target,
			"plan",
			stableProgram.action === "destroy" ? "destroy" : "deploy",
		);
		const result = await run(
			Effect.gen(function* () {
				const plan = yield* planned(stableProgram);
				if (!(yield* verifyAlchemyStateIdentities(plan)))
					return {
						ok: false as const,
						error: new AlchemyIacError(
							"STATE_IDENTITY_UNVERIFIED",
							"persisted Alchemy state identities are ambiguous or unavailable",
						),
					};
				try {
					const inspected = inspectAlchemyPlan(plan, target, composite);
					if (
						!(yield* Effect.promise(() =>
							verifyStateOwnership(stableProgram, "plan"),
						))
					)
						return {
							ok: false as const,
							error: new AlchemyIacError(
								"STATE_SCOPE_UNVERIFIED",
								"state ownership changed during planning",
							),
						};
					if (!(yield* verifyAlchemyStateIdentities(plan)))
						return {
							ok: false as const,
							error: new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state changed during planning",
							),
						};
					if (
						reinspectAlchemyPlan(plan, target, composite) !== inspected.digest
					)
						return {
							ok: false as const,
							error: new AlchemyIacError(
								"PLAN_CHANGED",
								"the plan changed during ownership verification",
							),
						};
					return {
						ok: true as const,
						inspected,
					};
				} catch (error) {
					return { ok: false as const, error };
				}
			}),
		);
		if (!result.ok) throw result.error;
		const digest = scopedPlanDigest(result.inspected.digest, stableProgram);
		previews.set(key, digest);
		return {
			...financial.assess(financialInputs(digest, stableProgram)),
			diff: {
				summary: `${result.inspected.changes} planned resource changes`,
				changes: result.inspected.changes,
			},
		};
	};
	const preview = async (program: IacProgram): Promise<IacDiff> =>
		(await assessPricing(program)).diff;
	const executeUnlocked = async (
		program: IacProgram,
		requestId: string,
		operation: IacRouteOperation,
		expected?: FinancialExpectation,
		routePermit?: IacRoutePermit,
	): Promise<{
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	}> => {
		const key = checkProgram(program);
		if (!name(requestId))
			throw new AlchemyIacError(
				"REQUEST_INVALID",
				"a bounded admission request id is required",
			);
		const checkedExpectation =
			expected === undefined ? undefined : readFinancialExpectation(expected);
		if (
			expected !== undefined &&
			(checkedExpectation === undefined ||
				checkedExpectation.targetId !== target.targetId)
		)
			throw new AlchemyIacError(
				"EXPECTATION_INVALID",
				"the routing expectation is malformed or belongs to another target",
			);
		const permit = readRoutePermit(routePermit);
		if (permit === undefined)
			throw new AlchemyIacError(
				"ROUTE_PERMIT_UNVERIFIED",
				"the route attempt permit is missing or malformed",
			);
		if (program.action === "preview")
			throw new AlchemyIacError(
				"PREVIEW_ONLY",
				"preview programs cannot be applied",
			);
		const priorReservation = claimed.get(key);
		if (priorReservation !== undefined)
			throw new AlchemyIacError(
				"EXECUTION_ALREADY_CLAIMED",
				"execution has already been claimed",
				undefined,
				priorReservation,
			);
		const previewDigest = previews.get(key);
		if (previewDigest === undefined)
			throw new AlchemyIacError(
				"PREVIEW_REQUIRED",
				"preview this program before applying it",
			);
		let heldReservation: string | undefined;
		let result:
			| { error: unknown }
			| { outputs: Record<string, string>; admission: HeldFinancialDecision };
		await requireStateOwnership(program, "plan");
		verifyCompositeEnvironment(
			composite,
			target,
			"plan",
			program.action === "destroy" ? "destroy" : "deploy",
		);
		try {
			result = await run(
				Effect.gen(function* () {
					const plan = yield* planned(program);
					if (!(yield* verifyAlchemyStateIdentities(plan)))
						return {
							error: new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state identities are ambiguous or unavailable",
							),
						};
					let inspected: ReturnType<typeof inspectAlchemyPlan>;
					try {
						inspected = inspectAlchemyPlan(plan, target, composite);
					} catch (error) {
						return { error };
					}
					const admittedPlanDigest = scopedPlanDigest(
						inspected.digest,
						program,
					);
					if (admittedPlanDigest !== previewDigest)
						return {
							error: new AlchemyIacError(
								"PLAN_CHANGED",
								"the plan changed after preview",
							),
						};
					if (
						!(yield* Effect.promise(() =>
							verifyStateOwnership(program, "plan"),
						))
					)
						return {
							error: new AlchemyIacError(
								"STATE_SCOPE_UNVERIFIED",
								"state ownership changed before admission",
							),
						};
					const routeBeforeAdmission = yield* Effect.promise(() =>
						verifyRoute(permit, requestId, operation, checkedExpectation),
					);
					if (routeBeforeAdmission === undefined)
						return {
							error: new AlchemyIacError(
								"ROUTE_PERMIT_UNVERIFIED",
								"the shared route authority did not verify this attempt",
							),
						};
					const consumed = yield* Effect.promise(async () => {
						try {
							return (await route?.consumeAttempt(permit)) === true;
						} catch {
							return false;
						}
					});
					if (!consumed)
						return {
							error: new AlchemyIacError(
								"ROUTE_PERMIT_UNVERIFIED",
								"the route attempt could not be consumed exactly once",
							),
						};
					const admitted = yield* Effect.promise(async () => {
						try {
							return {
								decision: await financial.admit(
									requestId,
									financialInputs(admittedPlanDigest, program),
									checkedExpectation,
								),
							};
						} catch {
							return {
								error: new AlchemyIacError(
									"ADMISSION_OUTCOME_UNKNOWN",
									"admission outcome must be reconciled before retry",
								),
							};
						}
					});
					if ("error" in admitted) return { error: admitted.error };
					const decision = readFinancialDecision(admitted.decision);
					if (decision === undefined)
						return {
							error: new AlchemyIacError(
								"ADMISSION_RECEIPT_INVALID",
								"admission receipt could not be safely inspected",
							),
						};
					if (
						decision.requestId !== requestId ||
						decision.targetId !== target.targetId
					)
						return {
							error: new AlchemyIacError(
								"ADMISSION_RECEIPT_INVALID",
								"admission belongs to another request or target",
								decision,
							),
						};
					if (decision.status !== "admitted")
						return {
							error: new AlchemyIacError(
								decision.code || "ADMISSION_FAILED",
								decision.message || "target was not admitted",
								decision,
								decision.reservation !== undefined &&
									reservationName(decision.reservation.reservationId)
									? decision.reservation.reservationId
									: undefined,
							),
						};
					if (
						decision.reservation === undefined ||
						!reservationName(decision.reservation.reservationId) ||
						decision.reservation.reservationId !== `iac:${requestId}` ||
						decision.budget?.reservation !== "held" ||
						!(
							(decision.budget.evaluation === "allowed" &&
								decision.reservation.unboundedExposure !== true &&
								decision.unpricedPolicyProof === undefined &&
								decision.reservation.unpricedScopeProof === undefined &&
								/^sha256:[a-f0-9]{64}$/u.test(decision.requestDigest ?? "") &&
								/^sha256:[a-f0-9]{64}$/u.test(decision.inventoryHash ?? "") &&
								/^sha256:[a-f0-9]{64}$/u.test(decision.modelHash ?? "") &&
								/^sha256:[a-f0-9]{64}$/u.test(decision.quoteHash ?? "")) ||
							(decision.budget.evaluation === "bypassed" &&
								decision.reservation.unboundedExposure === true &&
								/^sha256:[a-f0-9]{64}$/u.test(decision.requestDigest ?? "") &&
								/^sha256:[a-f0-9]{64}$/u.test(decision.inventoryHash ?? "") &&
								(decision.modelHash === undefined ||
									decision.modelHash === "") &&
								(decision.quoteHash === undefined ||
									decision.quoteHash === "") &&
								decision.unpricedPolicyProof !== undefined &&
								decision.unpricedPolicyProof.requestDigest ===
									decision.requestDigest &&
								decision.unpricedPolicyProof.inventoryHash ===
									decision.inventoryHash &&
								decision.unpricedPolicyProof.identity.tenantId ===
									target.tenantId &&
								scopeMatches(
									decision.reservation.unpricedScopeProof,
									decision.unpricedPolicyProof,
									target,
								))
						)
					) {
						const reservationId = decision.reservation?.reservationId;
						if (reservationId !== undefined && reservationName(reservationId)) {
							yield* Effect.promise(() => markUncertain(reservationId));
						}
						return {
							error: new AlchemyIacError(
								"ADMISSION_RECEIPT_INVALID",
								"admission did not establish a held budget",
								decision,
								reservationId,
							),
						};
					}
					const claimedReservationId = decision.reservation.reservationId;
					heldReservation = claimedReservationId;
					claimed.set(key, claimedReservationId);
					if (decision.inventoryHash !== permit.inventoryHash) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"ROUTE_INVENTORY_MISMATCH",
								"admission does not match the shared route inventory",
								decision,
								claimedReservationId,
							),
						};
					}
					if (
						checkedExpectation !== undefined &&
						(checkedExpectation.targetId !== target.targetId ||
							checkedExpectation.inventoryHash !== decision.inventoryHash ||
							(checkedExpectation.kind === "unpriced"
								? decision.budget.evaluation !== "bypassed"
								: decision.budget.evaluation !== "allowed" ||
									checkedExpectation.modelHash !== decision.modelHash ||
									checkedExpectation.quoteHash !== decision.quoteHash))
					) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"ADMISSION_QUOTE_MISMATCH",
								"admission differs from the ranked pricing assessment",
								undefined,
								heldReservation,
							),
						};
					}
					let admission: HeldFinancialDecision;
					if (decision.budget.evaluation === "bypassed") {
						const policy = decision.unpricedPolicyProof;
						const scope = decision.reservation.unpricedScopeProof;
						if (policy === undefined || scope === undefined) {
							yield* Effect.promise(() => markUncertain(claimedReservationId));
							return {
								error: new AlchemyIacError(
									"ADMISSION_RECEIPT_INVALID",
									"unbounded policy or scope proof is missing",
									decision,
									claimedReservationId,
								),
							};
						}
						admission = {
							...decision,
							budget: { evaluation: "bypassed", reservation: "held" },
							reservation: {
								reservationId: claimedReservationId,
								unboundedExposure: true,
								unpricedScopeProof: scope,
							},
							unpricedPolicyProof: policy,
						};
					} else {
						const {
							unpricedPolicyProof: _unpricedPolicyProof,
							...pricedDecision
						} = decision;
						admission = {
							...pricedDecision,
							budget: { evaluation: "allowed", reservation: "held" },
							reservation: {
								reservationId: claimedReservationId,
								unboundedExposure: false,
							},
						};
					}
					const confirmed = yield* Effect.promise(async () => {
						try {
							return (
								(await financial.revalidate(
									structuredClone(admission),
									financialInputs(admittedPlanDigest, program),
								)) === true
							);
						} catch {
							return false;
						}
					});
					if (!confirmed) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"ADMISSION_REVALIDATION_FAILED",
								"the claimed financial authorization could not be revalidated; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					const routeBeforeApply = yield* Effect.promise(() =>
						verifyRoute(permit, requestId, operation, checkedExpectation),
					);
					if (routeBeforeApply === undefined) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"ROUTE_PERMIT_UNVERIFIED",
								"the route attempt is no longer authorized; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					const currentOperation = yield* Effect.promise(() =>
						resolveAuthorizedOperation(program, requestId),
					);
					if (
						currentOperation === undefined ||
						currentOperation.requestId !== requestId ||
						currentOperation.operation.operationId !== operation.operationId
					) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"ROUTE_OPERATION_REVALIDATION_FAILED",
								"the operation is no longer authorized; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					try {
						verifyCompositeEnvironment(
							composite,
							target,
							"apply",
							program.action === "destroy" ? "destroy" : "deploy",
						);
						if (
							inspectAlchemyPlan(plan, target, composite).digest !==
							inspected.digest
						) {
							yield* Effect.promise(() => markUncertain(claimedReservationId));
							return {
								error: new AlchemyIacError(
									"PLAN_CHANGED_AFTER_ADMISSION",
									"plan changed after admission; the reservation is retained",
									undefined,
									heldReservation,
								),
							};
						}
					} catch {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"PLAN_UNINSPECTABLE_AFTER_ADMISSION",
								"plan cannot be checked after admission; the reservation is retained",
								undefined,
								heldReservation,
							),
						};
					}
					if (
						!(yield* Effect.promise(() =>
							verifyStateOwnership(program, "apply"),
						))
					) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"STATE_SCOPE_UNVERIFIED",
								"state ownership changed after admission; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					if (!(yield* verifyAlchemyStateIdentities(plan))) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state identities changed or became unavailable; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					try {
						if (
							reinspectAlchemyPlan(plan, target, composite) !== inspected.digest
						) {
							yield* Effect.promise(() => markUncertain(claimedReservationId));
							return {
								error: new AlchemyIacError(
									"PLAN_CHANGED_AFTER_ADMISSION",
									"the plan changed during the final state scan; the reservation is retained",
									admission,
									claimedReservationId,
								),
							};
						}
					} catch {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"PLAN_UNINSPECTABLE_AFTER_ADMISSION",
								"the plan cannot be checked after the final state scan; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					const outcome = yield* Effect.exit(Alchemist.apply(plan));
					if (Exit.isFailure(outcome)) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"APPLY_OUTCOME_UNKNOWN",
								"provider outcome is unknown; the budget reservation is retained",
								undefined,
								heldReservation,
							),
						};
					}
					if (
						!(yield* Effect.promise(() =>
							verifyStateOwnership(program, "complete"),
						))
					) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"STATE_SCOPE_UNCERTAIN",
								"the provider completed but state ownership could not be reverified; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					let authorizationVerified = false;
					try {
						verifyCompositeEnvironment(
							composite,
							target,
							"apply",
							program.action === "destroy" ? "destroy" : "deploy",
						);
						authorizationVerified = inspected.revalidateSources();
					} catch {
						/* retain the hold if the host authorization has been revoked */
					}
					if (!authorizationVerified) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								inspected.hasSourceClaims
									? "SOURCE_FENCE_UNCERTAIN"
									: "COMPOSITE_AUTHORIZATION_UNCERTAIN",
								"the provider completed but host authorization could not be verified; the reservation is retained",
								admission,
								claimedReservationId,
							),
						};
					}
					const outputs =
						program.action === "destroy" ? {} : readOutputs(outcome.value);
					if (outputs === undefined)
						return {
							error: new AlchemyIacError(
								"APPLY_OUTPUT_UNREPRESENTABLE",
								"the provider completed, but its outputs do not fit HoBo's bounded string output contract; the budget reservation is retained",
								decision,
								heldReservation,
							),
						};
					return { outputs, admission };
				}),
			);
		} catch (error) {
			if (heldReservation !== undefined) {
				await markUncertain(heldReservation);
				throw new AlchemyIacError(
					"APPLY_OUTCOME_UNKNOWN",
					"provider or runtime outcome is unknown; the reservation is retained",
					undefined,
					heldReservation,
				);
			}
			throw error;
		}
		if ("error" in result) throw result.error;
		return result;
	};
	const execute: AlchemyIacProvider<Assessment>["applyWithAdmission"] = async (
		program,
		requestId,
		expected,
		suppliedPermit,
	) => {
		const stableProgram = snapshotProgram(program);
		const key = checkProgram(stableProgram);
		const fenceKey = digestData({
			tenantId: target.tenantId,
			targetId: target.targetId,
			deploymentId: stableProgram.deploymentId,
			resourceId: stableProgram.resourceId,
		});
		if (unresolved.has(fenceKey)) {
			const reservationId = unresolved.get(fenceKey);
			throw new AlchemyIacError(
				reservationId === undefined
					? "EXECUTION_OUTCOME_UNRESOLVED"
					: "EXECUTION_ALREADY_CLAIMED",
				"the previous execution must be reconciled before another attempt",
				undefined,
				reservationId,
			);
		}
		if (running.has(fenceKey))
			throw new AlchemyIacError(
				"EXECUTION_IN_PROGRESS",
				"another execution of this program must finish before retry",
			);
		if (stableProgram.action === "preview")
			throw new AlchemyIacError(
				"PREVIEW_ONLY",
				"preview programs cannot be applied",
			);
		if (stableProgram.operationGeneration === undefined)
			throw new AlchemyIacError(
				"OPERATION_GENERATION_REQUIRED",
				"a durable orchestrator operation generation is required",
			);
		if (requestId !== undefined && !name(requestId))
			throw new AlchemyIacError(
				"REQUEST_INVALID",
				"a bounded admission request id is required",
			);
		const checkedExpectation =
			expected === undefined ? undefined : readFinancialExpectation(expected);
		if (
			expected !== undefined &&
			(checkedExpectation === undefined ||
				checkedExpectation.targetId !== target.targetId)
		)
			throw new AlchemyIacError(
				"EXPECTATION_INVALID",
				"the routing expectation is malformed or belongs to another target",
			);
		const previewDigest = previews.get(key);
		if (previewDigest === undefined)
			throw new AlchemyIacError(
				"PREVIEW_REQUIRED",
				"preview this program before applying it",
			);
		if (route?.persistence !== "durable-cas")
			throw new AlchemyIacError(
				"ROUTE_AUTHORITY_UNAVAILABLE",
				"a shared durable route authority is required",
			);
		if (resolveRoute === undefined)
			throw new AlchemyIacError(
				"ROUTE_OPERATION_REQUIRED",
				"a trusted operation resolver is required",
			);
		if (running.size >= 128)
			throw new AlchemyIacError(
				"EXECUTION_LIMIT",
				"provider execution capacity reached",
			);
		running.add(fenceKey);
		try {
			await requireStateOwnership(stableProgram, "plan");
			const resolution = await resolveAuthorizedOperation(
				stableProgram,
				requestId,
			);
			if (
				resolution === undefined ||
				(requestId !== undefined && resolution.requestId !== requestId)
			)
				throw new AlchemyIacError(
					"ROUTE_OPERATION_UNVERIFIED",
					"the host did not authenticate this operation and request",
				);
			const { requestId: resolvedRequestId, operation: routeOperation } =
				resolution;
			if (suppliedPermit !== undefined) {
				const result = await executeUnlocked(
					stableProgram,
					resolvedRequestId,
					routeOperation,
					checkedExpectation,
					suppliedPermit,
				);
				previews.delete(key);
				claimed.delete(key);
				return result;
			}
			const state: RouteExecutionState = { invoked: false };
			let routeResult: Awaited<ReturnType<IacRoutePort["runDirect"]>>;
			try {
				routeResult = await route.runDirect(
					{
						tenantId: target.tenantId,
						requestId: resolvedRequestId,
						operation: routeOperation,
						targetId: target.targetId,
						plan: financialInputs(previewDigest, stableProgram),
					},
					async (attempt) => {
						if (state.invoked)
							throw new Error("route callback was invoked more than once");
						state.invoked = true;
						try {
							state.result = await executeUnlocked(
								stableProgram,
								resolvedRequestId,
								routeOperation,
								checkedExpectation,
								attempt.permit,
							);
							return {
								value: true,
								outcome: {
									status: "selected" as const,
									targetId: target.targetId,
								},
							};
						} catch (error) {
							const failure =
								error instanceof AlchemyIacError
									? error
									: new AlchemyIacError(
											"ROUTE_OUTCOME_UNKNOWN",
											"the route attempt outcome is unknown",
										);
							if (
								!failure.requiresReconciliation &&
								failure.executionOutcome === "not-started"
							) {
								await attempt.deny();
								state.error = failure;
								return { value: true, outcome: { status: "denied" as const } };
							}
							state.error = failure;
							return {
								value: true,
								outcome: {
									status: "uncertain" as const,
									targetId: target.targetId,
								},
							};
						}
					},
				);
			} catch {
				const reservation =
					state.result?.admission.reservation.reservationId ??
					state.error?.reservationId;
				if (reservation !== undefined) await markUncertain(reservation);
				throw new AlchemyIacError(
					"ROUTE_OUTCOME_UNKNOWN",
					"the durable route completion could not be confirmed",
					undefined,
					reservation,
				);
			}
			const completion = readRouteCompletion(routeResult);
			if (
				completion !== "executed" ||
				!state.invoked ||
				(state.result === undefined && state.error === undefined)
			) {
				const reservation =
					state.result?.admission.reservation.reservationId ??
					state.error?.reservationId;
				if (reservation !== undefined) await markUncertain(reservation);
				throw new AlchemyIacError(
					completion === "replay"
						? "ROUTE_ALREADY_FINISHED"
						: "ROUTE_OUTCOME_UNKNOWN",
					"the durable route did not confirm an execution result",
					undefined,
					reservation,
				);
			}
			if (state.error !== undefined) throw state.error;
			if (state.result === undefined)
				throw new AlchemyIacError(
					"ROUTE_OUTCOME_UNKNOWN",
					"the durable route returned no result",
				);
			previews.delete(key);
			claimed.delete(key);
			return state.result;
		} catch (error) {
			if (error instanceof AlchemyIacError && error.requiresReconciliation)
				unresolved.set(fenceKey, error.reservationId ?? claimed.get(key));
			throw error;
		} finally {
			running.delete(fenceKey);
		}
	};
	const applyWithAdmission: AlchemyIacProvider<Assessment>["applyWithAdmission"] =
		async (program, requestId, expected, permit) => {
			const stableProgram = snapshotProgram(program);
			if (stableProgram.action === "destroy")
				throw new AlchemyIacError(
					"PROGRAM_SCOPE_MISMATCH",
					"apply cannot execute a destroy program",
				);
			return execute(stableProgram, requestId, expected, permit);
		};
	const destroyWithAdmission: AlchemyIacProvider<Assessment>["destroyWithAdmission"] =
		async (program, requestId, expected, permit) => {
			const stableProgram = snapshotProgram(program);
			if (stableProgram.action !== "destroy")
				throw new AlchemyIacError(
					"PROGRAM_SCOPE_MISMATCH",
					"destroy requires a destroy program",
				);
			const { admission } = await execute(
				stableProgram,
				requestId,
				expected,
				permit,
			);
			return { admission };
		};
	return {
		id: "alchemy",
		preview,
		assessPricing,
		apply: async (program) => (await applyWithAdmission(program)).outputs,
		applyWithAdmission,
		destroy: async (program) => {
			await destroyWithAdmission(program);
		},
		destroyWithAdmission,
		refresh: async (program): Promise<IacDriftReport> => {
			const stableProgram = snapshotProgram(program);
			checkProgram(stableProgram);
			const operation =
				stableProgram.action === "destroy" ? "destroy" : "deploy";
			await requireStateOwnership(stableProgram, "plan");
			verifyCompositeEnvironment(composite, target, "plan", operation);
			// Planning and drift each own a scoped state-store lease; close the
			// classification plan before starting the independent read-only scan.
			const inspected = await run(
				Effect.gen(function* () {
					const plan = yield* planned(stableProgram);
					if (!(yield* verifyAlchemyStateIdentities(plan)))
						throw new AlchemyIacError(
							"STATE_IDENTITY_UNVERIFIED",
							"persisted Alchemy state identities are ambiguous or unavailable",
						);
					return inspectAlchemyPlan(plan, target, composite);
				}),
			);
			await requireStateOwnership(stableProgram, "plan");
			verifyCompositeEnvironment(composite, target, "plan", operation);
			if (!inspected.revalidateSources())
				throw new AlchemyIacError(
					"COMPOSITE_PLAN_UNVERIFIED",
					"the source classification is no longer authorized",
				);
			await requireStateOwnership(stableProgram, "drift");
			const scan = await run(
				Alchemist.Drift.scan({ stack, stage: target.stage }),
			);
			await requireStateOwnership(stableProgram, "drift");
			verifyCompositeEnvironment(composite, target, "plan", operation);
			if (!inspected.revalidateSources())
				throw new AlchemyIacError(
					"COMPOSITE_PLAN_UNVERIFIED",
					"the source classification is no longer authorized",
				);
			const resources = new Map(
				scan.resources.map((entry) => [entry.fqn, entry]),
			);
			if (
				resources.size !== target.resources.length ||
				scan.resources.length !== resources.size ||
				target.resources.some(
					(scope) =>
						resources.get(scope.resourceId)?.resourceType !==
						scope.resourceType,
				) ||
				scan.resources.some((entry) => entry.status === "skipped")
			) {
				throw new AlchemyIacError(
					"DRIFT_CHECK_INCOMPLETE",
					"not every target resource could be inspected for drift",
				);
			}
			return {
				drift: Alchemist.Drift.hasDrift(scan),
				observed: Object.fromEntries(
					scan.resources.map((entry) => [entry.fqn, entry.status]),
				),
			};
		},
	};
}
