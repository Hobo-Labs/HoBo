import { isAbsolute } from "node:path";
import { hrtime } from "node:process";
import { types } from "node:util";
import { AlchemyContext } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import type * as Stack from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import type { ResourceScope, Target } from "./_generated/alchemy_iac_pb.js";
import {
	type BoundedValue,
	boundedOperation as runBoundedOperation,
} from "./bounded-operation.js";
import {
	boundedFinancialReceipt,
	validFinancialMetadata,
} from "./financial-boundary.js";
import {
	captureAlchemyOptions,
	captureAlchemyTarget,
	captureAlchemyTargetOption,
} from "./input-boundary.js";
import {
	type AlchemyCompositeEnvironment,
	type AlchemyCompositeGuard,
	type AlchemyCompositeObservation,
	AlchemyIacError,
	captureAlchemyInspection,
	captureAlchemyReinspection,
	digestData,
	type inspectAlchemyPlan,
	type reinspectAlchemyPlan,
	verifyCompositeEnvironment,
} from "./plan.js";
import type {
	FinancialDecision,
	FinancialExpectation,
	FinancialPlan,
	FinancialPort,
	HeldFinancialDecision,
	IacDiff,
	IacDirectRouteAttempt,
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
import { captureAlchemySecretFingerprint } from "./secret-fingerprint.js";
import { captureAlchemySourceRequirements } from "./source-fence.js";
import {
	alchemyStateScopeKey,
	guardAlchemyStack,
	safeAlchemyFqn,
	safeAlchemyStateSegment,
	uniqueAlchemyFqns,
	verifyAlchemyStateIdentities,
} from "./state-identity.js";

const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getOwnDescriptors = Object.getOwnPropertyDescriptors;
const getOwnSymbols = Object.getOwnPropertySymbols;
const getPrototype = Object.getPrototypeOf;
const objectKeys = Object.keys;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;

const applyHostCallback = Reflect.apply;
const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;
const NativeWeakMap = WeakMap;
const weakMapGet = NativeWeakMap.prototype.get;
const weakMapSet = NativeWeakMap.prototype.set;
const NativeMap = Map;
const NativeSet = Set;
const mapGet = NativeMap.prototype.get;
const mapHas = NativeMap.prototype.has;
const mapSet = NativeMap.prototype.set;
const mapDelete = NativeMap.prototype.delete;
const mapSize = requiredSizeGetter(NativeMap.prototype);
const setHas = NativeSet.prototype.has;
const setAdd = NativeSet.prototype.add;
const setDelete = NativeSet.prototype.delete;
const setSize = requiredSizeGetter(NativeSet.prototype);

function requiredSizeGetter(
	prototype: typeof NativeMap.prototype | typeof NativeSet.prototype,
): () => number {
	const getter = getOwnDescriptor(prototype, "size")?.get;
	if (getter === undefined)
		throw new Error("native collection size accessor is unavailable");
	return getter;
}

function fenceMapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
	return applyHostCallback(mapGet, map, [key]);
}
function fenceMapHas<K, V>(map: Map<K, V>, key: K): boolean {
	return applyHostCallback(mapHas, map, [key]);
}
function fenceMapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
	applyHostCallback(mapSet, map, [key, value]);
}
function fenceMapDelete<K, V>(map: Map<K, V>, key: K): void {
	applyHostCallback(mapDelete, map, [key]);
}
function fenceMapSize<K, V>(map: Map<K, V>): number {
	return applyHostCallback(mapSize, map, []);
}
function fenceSetHas<T>(set: Set<T>, value: T): boolean {
	return applyHostCallback(setHas, set, [value]);
}
function fenceSetAdd<T>(set: Set<T>, value: T): void {
	applyHostCallback(setAdd, set, [value]);
}
function fenceSetDelete<T>(set: Set<T>, value: T): void {
	applyHostCallback(setDelete, set, [value]);
}
function fenceSetSize<T>(set: Set<T>): number {
	return applyHostCallback(setSize, set, []);
}

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
	AlchemyPriorStateSecrets,
	AlchemySecretFingerprint,
	AlchemySecretFingerprintClaim,
	AlchemySecretScope,
} from "./secret-fingerprint.js";
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

	readonly runtimeLayer: Layer.Layer<Alchemist.Services, unknown, never>;
	readonly runtimeDirectory: string;

	readonly stateOwnership: AlchemyStateOwnership;

	readonly operationTimeoutMs?: number;
	readonly financial: FinancialPort<Assessment>;

	readonly route?: IacRoutePort | undefined;

	readonly resolveRoute?: IacRouteResolver | undefined;

	readonly composite: AlchemyCompositeGuard;
}

export interface AlchemyIacProvider<Assessment extends object>
	extends IacProvider {
	assessPricing(program: IacProgram): Promise<Assessment & { diff: IacDiff }>;

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

type DeadlinePhase =
	| "preview"
	| "refresh"
	| "before-route"
	| "route"
	| "admission"
	| "held"
	| "provider"
	| "completed";
interface OperationDeadline {
	expired: boolean;
	phase: DeadlinePhase;
	readonly expiresAt: bigint;
	lastObserved: bigint;
	signalTimeout: (() => void) | undefined;
	reservationId: string | undefined;
}

const monotonicNow = hrtime.bigint;
const toBigInt = BigInt;

function startDeadline(
	phase: DeadlinePhase,
	timeoutMs: number,
): OperationDeadline {
	const now = monotonicNow();
	return {
		expired: false,
		phase,
		expiresAt: now + toBigInt(timeoutMs) * 1_000_000n,
		lastObserved: now,
		signalTimeout: undefined,
		reservationId: undefined,
	};
}

function deadlineExpired(deadline: OperationDeadline): boolean {
	if (!deadline.expired) {
		const now = monotonicNow();
		if (now < deadline.lastObserved || now >= deadline.expiresAt)
			deadline.signalTimeout?.();
		else deadline.lastObserved = now;
	}
	return deadline.expired;
}

function deadlineError(deadline: OperationDeadline): AlchemyIacError {
	const scenarios = {
		preview: {
			code: "PREVIEW_DEADLINE_EXCEEDED",
			message: "preview timed out before provider execution",
		},
		refresh: {
			code: "REFRESH_DEADLINE_EXCEEDED",
			message: "refresh timed out before provider mutation",
		},
		"before-route": {
			code: "EXECUTION_DEADLINE_BEFORE_ROUTE",
			message:
				"execution timed out before a route claim; the local continuation is latched, and the host must verify its durable logical-operation fence",
		},
		route: {
			code: "ROUTE_DEADLINE_UNKNOWN",
			message:
				"the route claim or permit consumption may have committed; fence the executor and reconcile",
		},
		admission: {
			code: "ADMISSION_DEADLINE_UNKNOWN",
			message:
				"admission may have established a hold; fence the executor and reconcile",
		},
		held: {
			code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
			message:
				"the hold is retained; fence the executor and reconcile before retry",
		},
		provider: {
			code: "PROVIDER_DEADLINE_UNKNOWN",
			message:
				"the provider may still complete; fence the executor and reconcile its effect and hold",
		},
		completed: {
			code: "ROUTE_COMPLETION_DEADLINE_UNKNOWN",
			message:
				"the provider completed but route completion is uncertain; reconcile the route and hold",
		},
	} satisfies Record<
		DeadlinePhase,
		{ readonly code: string; readonly message: string }
	>;
	const result = scenarios[deadline.phase];
	return new AlchemyIacError(
		result.code,
		result.message,
		undefined,
		deadline.reservationId,
	);
}

function boundedOperation<T>(
	deadline: OperationDeadline,
	start: () => Promise<T>,
	onTimeout: () => void,
): Promise<BoundedValue<T>> {
	return runBoundedOperation(
		deadline,
		start,
		onTimeout,
		() => deadlineExpired(deadline),
		() => deadlineError(deadline),
	);
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
				executionDigest?: string;
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

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-object-parameters, anti-slop/no-reflect-apply -- SAFETY: host configuration crosses a JavaScript boundary; data descriptors and non-proxy functions are captured before invoking the trusted host authority. */
function hostAuthority(input: unknown): input is object {
	return (
		typeof input === "object" &&
		input !== null &&
		!isProxy(input) &&
		!isArray(input)
	);
}

function hostField(input: object, key: string): unknown {
	const property = getOwnDescriptor(input, key);
	if (
		property === undefined ||
		!hasOwnDescriptor(property, "value") ||
		!property.enumerable
	)
		throw new Error("invalid host authority field");
	return property.value;
}

function captureStateOwnership(
	input: AlchemyStateOwnership,
): AlchemyStateOwnership {
	try {
		if (!hostAuthority(input)) throw new Error("invalid state owner");
		const backendRef = hostField(input, "backendRef");
		const ownershipEpoch = hostField(input, "ownershipEpoch");
		const verify = hostField(input, "verify");
		if (
			typeof backendRef !== "string" ||
			!name(backendRef) ||
			typeof ownershipEpoch !== "string" ||
			!name(ownershipEpoch) ||
			typeof verify !== "function" ||
			isProxy(verify)
		)
			throw new Error("invalid state owner");
		const captured: AlchemyStateOwnership = {
			backendRef,
			ownershipEpoch,
			verify: (claim) => applyHostCallback(verify, input, [claim]),
		};
		return Object.freeze(captured);
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
		if (!hostAuthority(input)) throw new Error("invalid host guard");
		const secretField = getOwnDescriptor(input, "secretFingerprint");
		if (
			secretField !== undefined &&
			(!hasOwnDescriptor(secretField, "value") || !secretField.enumerable)
		)
			throw new Error("invalid secret authority");
		const secretFingerprint = secretField?.value;
		const proofRef = hostField(input, "proofRef");
		const environmentDigest = hostField(input, "environmentDigest");
		const verifyEnvironment = hostField(input, "verifyEnvironment");
		const verifyPlan = hostField(input, "verifyPlan");
		const sourceRequirements = hostField(input, "sourceRequirements");
		const capturedRequirements =
			!isProxy(sourceRequirements) && isArray(sourceRequirements)
				? captureAlchemySourceRequirements(sourceRequirements)
				: undefined;
		if (
			typeof proofRef !== "string" ||
			!name(proofRef) ||
			typeof environmentDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(environmentDigest) ||
			typeof verifyEnvironment !== "function" ||
			isProxy(verifyEnvironment) ||
			typeof verifyPlan !== "function" ||
			isProxy(verifyPlan) ||
			capturedRequirements === undefined
		)
			throw new Error("invalid host guard");
		const base = {
			proofRef,
			environmentDigest,
			verifyEnvironment: (claim: AlchemyCompositeEnvironment) =>
				applyHostCallback(verifyEnvironment, input, [claim]),
			verifyPlan: (claim: AlchemyCompositeObservation) =>
				applyHostCallback(verifyPlan, input, [claim]),
		};
		return Object.freeze({
			...base,
			sourceRequirements: capturedRequirements,
			...(secretFingerprint === undefined
				? undefined
				: {
						secretFingerprint:
							captureAlchemySecretFingerprint(secretFingerprint),
					}),
		});
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
		if (!hostAuthority(input)) throw new Error("invalid financial port");
		const assess = hostField(input, "assess");
		const admit = hostField(input, "admit");
		const revalidate = hostField(input, "revalidate");
		const uncertain = hostField(input, "uncertain");
		if (
			typeof assess !== "function" ||
			isProxy(assess) ||
			typeof admit !== "function" ||
			isProxy(admit) ||
			typeof revalidate !== "function" ||
			isProxy(revalidate) ||
			typeof uncertain !== "function" ||
			isProxy(uncertain)
		)
			throw new Error("invalid financial port");
		const captured: FinancialPort<Assessment> = {
			assess: (plan) => applyHostCallback(assess, input, [plan]),
			admit: (requestId, plan, expected) =>
				applyHostCallback(admit, input, [requestId, plan, expected]),
			revalidate: (admission, plan) =>
				applyHostCallback(revalidate, input, [admission, plan]),
			uncertain: (reservationId) =>
				applyHostCallback(uncertain, input, [reservationId]),
		};
		return Object.freeze(captured);
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
		if (!hostAuthority(input)) throw new Error("invalid route port");
		const persistence = hostField(input, "persistence");
		const consumeAttempt = hostField(input, "consumeAttempt");
		const verifyAttempt = hostField(input, "verifyAttempt");
		const runDirect = hostField(input, "runDirect");
		if (
			persistence !== "durable-cas" ||
			typeof consumeAttempt !== "function" ||
			isProxy(consumeAttempt) ||
			typeof verifyAttempt !== "function" ||
			isProxy(verifyAttempt) ||
			typeof runDirect !== "function" ||
			isProxy(runDirect)
		)
			throw new Error("invalid route port");
		const captured: IacRoutePort = {
			persistence,
			consumeAttempt: (permit) =>
				applyHostCallback(consumeAttempt, input, [permit]),
			verifyAttempt: (permit) =>
				applyHostCallback(verifyAttempt, input, [permit]),
			runDirect: (context, run) =>
				applyHostCallback(runDirect, input, [context, run]),
		};
		return Object.freeze(captured);
	} catch {
		throw new AlchemyIacError(
			"ROUTE_AUTHORITY_UNAVAILABLE",
			"the trusted route port is malformed or unavailable",
		);
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-object-parameters, anti-slop/no-reflect-apply */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: admission receipts cross a provider boundary; inspect own data properties before returning an independent domain value. */
function readRoutePermit(input: unknown): IacRoutePermit | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const read = (key: string): unknown => {
			const descriptor = getOwnDescriptor(input, key);
			if (descriptor === undefined || !hasOwnDescriptor(descriptor, "value"))
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

function readRouteAttempt(input: unknown): IacDirectRouteAttempt | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const permit = getOwnDescriptor(input, "permit");
		const deny = getOwnDescriptor(input, "deny");
		if (
			permit === undefined ||
			!hasOwnDescriptor(permit, "value") ||
			deny === undefined ||
			!hasOwnDescriptor(deny, "value") ||
			typeof deny.value !== "function" ||
			isProxy(deny.value)
		)
			return undefined;
		const checkedPermit = readRoutePermit(permit.value);
		if (checkedPermit === undefined) return undefined;
		return Object.freeze({
			permit: checkedPermit,
			deny: async () => {
				await applyHostCallback(deny.value, input, []);
			},
		});
	} catch {
		return undefined;
	}
}

function readRouteOperation(input: unknown): IacRouteOperation | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const id = getOwnDescriptor(input, "operationId");
		const proof = getOwnDescriptor(input, "authorization");
		if (
			id === undefined ||
			!hasOwnDescriptor(id, "value") ||
			typeof id.value !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(id.value) ||
			proof === undefined ||
			!hasOwnDescriptor(proof, "value") ||
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
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const requestId = getOwnDescriptor(input, "requestId");
		const operation = getOwnDescriptor(input, "operation");
		if (
			requestId === undefined ||
			!hasOwnDescriptor(requestId, "value") ||
			typeof requestId.value !== "string" ||
			!name(requestId.value) ||
			operation === undefined ||
			!hasOwnDescriptor(operation, "value")
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
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const status = getOwnDescriptor(input, "status");
		if (status === undefined || !hasOwnDescriptor(status, "value"))
			return undefined;
		if (status.value === "replay" || status.value === "uncertain")
			return status.value;
		const value = getOwnDescriptor(input, "value");
		return status.value === "executed" &&
			value !== undefined &&
			hasOwnDescriptor(value, "value") &&
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
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const read = (key: string): unknown => {
			const descriptor = getOwnDescriptor(input, key);
			if (descriptor === undefined) return undefined;
			if (!hasOwnDescriptor(descriptor, "value"))
				throw new Error("expectation accessor");
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

const identityFields = new Set([
	"tenantId",
	"budgetId",
	"periodId",
	"policyRevision",
]);
const unpricedPolicyFields = new Set([
	"requestDigest",
	"inventoryHash",
	"identity",
	"policyHash",
	"effect",
	"evidenceRef",
	"obligationsSatisfied",
	"observedAt",
	"validUntil",
]);
const unpricedScopeFields = new Set([
	"identity",
	"providerAccountIds",
	"authorityRef",
	"evidenceRef",
	"ownershipEpoch",
	"observedAt",
	"exclusiveUntilSettled",
	"noSharedEntitlements",
	"signature",
]);
const financialDecisionFields = new Set([
	"requestId",
	"targetId",
	"status",
	"code",
	"message",
	"budget",
	"requestDigest",
	"inventoryHash",
	"modelHash",
	"quoteHash",
	"quote",
	"reservation",
	"policyProof",
	"unpricedPolicyProof",
]);
const budgetDisclosureFields = new Set(["evaluation", "reservation"]);
const reservationFields = new Set([
	"reservationId",
	"identity",
	"requestDigest",
	"quoteId",
	"reservedMicros",
	"status",
	"actualMicros",
	"ledgerSeq",
	"quoteDigest",
	"usageEvidenceRef",
	"sourceStoppedEvidenceRef",
	"providerAccounts",
	"entitlementClaims",
	"settlementEvidence",
	"executionDigest",
	"financialPlanHash",
	"fenceSettlementGuard",
	"fenceSettlementPayloadVersion",
	"unboundedExposure",
	"unpricedPolicyProof",
	"unpricedScopeProof",
	"iacPricingPin",
]);

function hasKnownFields(
	input: unknown,
	allowed: ReadonlySet<string>,
	typeName: string,
): boolean {
	if (typeof input !== "object" || input === null || isProxy(input))
		return false;
	for (const key of ownKeys(input)) {
		if (typeof key !== "string") return false;
		if (key === "$typeName" || key === "$unknown") {
			const property = getOwnDescriptor(input, key);
			if (
				property === undefined ||
				!hasOwnDescriptor(property, "value") ||
				(key === "$typeName" && property.value !== typeName) ||
				(key === "$unknown" && property.value !== undefined)
			)
				return false;
		} else if (!allowed.has(key)) return false;
	}
	return true;
}

function readUnpricedScopeProof(
	input: unknown,
): UnpricedScopeProof | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input) ||
			!hasKnownFields(
				input,
				unpricedScopeFields,
				"hobo.broker.yard.v1.IacUnpricedScopeProof",
			)
		)
			return undefined;
		const read = (source: unknown, key: string): unknown => {
			if (
				typeof source !== "object" ||
				source === null ||
				isProxy(source) ||
				isArray(source)
			)
				return undefined;
			const descriptor = getOwnDescriptor(source, key);
			if (descriptor === undefined || !hasOwnDescriptor(descriptor, "value"))
				return undefined;
			return descriptor.value;
		};
		const identityInput = read(input, "identity");
		if (
			typeof identityInput !== "object" ||
			identityInput === null ||
			isProxy(identityInput) ||
			isArray(identityInput) ||
			!hasKnownFields(
				identityInput,
				identityFields,
				"hobo.broker.yard.v1.BudgetIdentity",
			)
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
			isProxy(accountInput) ||
			!isArray(accountInput) ||
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
		const length = getOwnDescriptor(accountInput, "length");
		if (
			length === undefined ||
			!hasOwnDescriptor(length, "value") ||
			typeof length.value !== "number" ||
			!Number.isSafeInteger(length.value) ||
			length.value < 1 ||
			length.value > 256
		)
			return undefined;
		const providerAccountIds: string[] = [];
		for (let index = 0; index < length.value; index++) {
			const entry = getOwnDescriptor(accountInput, String(index));
			if (
				entry === undefined ||
				!hasOwnDescriptor(entry, "value") ||
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
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input) ||
			!hasKnownFields(
				input,
				unpricedPolicyFields,
				"hobo.broker.yard.v1.IacUnpricedPolicyProof",
			)
		)
			return undefined;
		const properties = getOwnDescriptors(input);
		const read = (key: string): unknown => {
			const descriptor = hasOwnDescriptor(properties, key)
				? properties[key]
				: undefined;
			if (descriptor === undefined || !hasOwnDescriptor(descriptor, "value"))
				return undefined;
			return descriptor.value;
		};
		const identityInput = read("identity");
		if (
			typeof identityInput !== "object" ||
			identityInput === null ||
			isProxy(identityInput) ||
			isArray(identityInput) ||
			!hasKnownFields(
				identityInput,
				identityFields,
				"hobo.broker.yard.v1.BudgetIdentity",
			)
		)
			return undefined;
		const identityProperties = getOwnDescriptors(identityInput);
		const identityRead = (key: string): unknown => {
			const descriptor = hasOwnDescriptor(identityProperties, key)
				? identityProperties[key]
				: undefined;
			if (descriptor === undefined || !hasOwnDescriptor(descriptor, "value"))
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

function sameUnpricedPolicyProof(
	left: UnpricedPolicyProof,
	right: UnpricedPolicyProof,
): boolean {
	return (
		left.requestDigest === right.requestDigest &&
		left.inventoryHash === right.inventoryHash &&
		left.identity.tenantId === right.identity.tenantId &&
		left.identity.budgetId === right.identity.budgetId &&
		left.identity.periodId === right.identity.periodId &&
		left.identity.policyRevision === right.identity.policyRevision &&
		left.policyHash === right.policyHash &&
		left.effect === right.effect &&
		left.evidenceRef === right.evidenceRef &&
		left.obligationsSatisfied === right.obligationsSatisfied &&
		left.observedAt === right.observedAt &&
		left.validUntil === right.validUntil
	);
}

function readKnownReservation(
	input: unknown,
	requestId: string,
	targetId: string,
	tenantId: string,
): string | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return undefined;
		const request = getOwnDescriptor(input, "requestId");
		const target = getOwnDescriptor(input, "targetId");
		const reservation = getOwnDescriptor(input, "reservation");
		if (
			request === undefined ||
			!hasOwnDescriptor(request, "value") ||
			request.value !== requestId ||
			target === undefined ||
			!hasOwnDescriptor(target, "value") ||
			target.value !== targetId ||
			reservation === undefined ||
			!hasOwnDescriptor(reservation, "value") ||
			typeof reservation.value !== "object" ||
			reservation.value === null ||
			isProxy(reservation.value) ||
			isArray(reservation.value)
		)
			return undefined;
		const identity = getOwnDescriptor(reservation.value, "identity");
		if (identity !== undefined) {
			if (!hasOwnDescriptor(identity, "value")) return undefined;
			if (identity.value !== undefined) {
				if (
					typeof identity.value !== "object" ||
					identity.value === null ||
					isProxy(identity.value) ||
					isArray(identity.value)
				)
					return undefined;
				const tenant = getOwnDescriptor(identity.value, "tenantId");
				if (
					tenant === undefined ||
					!hasOwnDescriptor(tenant, "value") ||
					tenant.value !== tenantId
				)
					return undefined;
			}
		}
		const nestedDigest = getOwnDescriptor(reservation.value, "requestDigest");
		if (nestedDigest !== undefined) {
			if (!hasOwnDescriptor(nestedDigest, "value")) return undefined;

			if (nestedDigest.value !== undefined && nestedDigest.value !== "") {
				const digest = getOwnDescriptor(input, "requestDigest");
				if (
					typeof nestedDigest.value !== "string" ||
					digest === undefined ||
					!hasOwnDescriptor(digest, "value") ||
					digest.value !== nestedDigest.value
				)
					return undefined;
			}
		}
		const id = getOwnDescriptor(reservation.value, "reservationId");
		return id !== undefined &&
			hasOwnDescriptor(id, "value") &&
			typeof id.value === "string" &&
			id.value === `iac:${requestId}` &&
			reservationName(id.value)
			? id.value
			: undefined;
	} catch {
		return undefined;
	}
}

function hasUnsupportedSettlementEvidence(
	input: unknown,
	requestId: string,
	targetId: string,
): boolean {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input)
		)
			return false;
		const request = getOwnDescriptor(input, "requestId");
		const target = getOwnDescriptor(input, "targetId");
		const reservation = getOwnDescriptor(input, "reservation");
		if (
			request === undefined ||
			!hasOwnDescriptor(request, "value") ||
			request.value !== requestId ||
			target === undefined ||
			!hasOwnDescriptor(target, "value") ||
			target.value !== targetId ||
			reservation === undefined ||
			!hasOwnDescriptor(reservation, "value") ||
			typeof reservation.value !== "object" ||
			reservation.value === null ||
			isProxy(reservation.value) ||
			isArray(reservation.value)
		)
			return false;
		for (const key of ["fenceSettlementGuard", "settlementEvidence"]) {
			const property = getOwnDescriptor(reservation.value, key);
			if (
				property !== undefined &&
				hasOwnDescriptor(property, "value") &&
				property.value !== undefined
			)
				return true;
		}
		return false;
	} catch {
		return false;
	}
}

function readFinancialDecision(
	input: unknown,
	tenantId: string,
): InspectedFinancialDecision | undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			isArray(input) ||
			!boundedFinancialReceipt(input) ||
			!validFinancialMetadata(input, tenantId) ||
			!hasKnownFields(
				input,
				financialDecisionFields,
				"hobo.broker.yard.v1.IacTargetAdmissionDecision",
			)
		)
			return undefined;
		const properties = getOwnDescriptors(input);
		const read = (key: string): unknown => {
			const descriptor = hasOwnDescriptor(properties, key)
				? properties[key]
				: undefined;
			if (descriptor === undefined) return undefined;
			if (!hasOwnDescriptor(descriptor, "value"))
				throw new Error("receipt accessor");
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
		const policyInput = read("unpricedPolicyProof");
		const unpricedPolicyProof = readUnpricedPolicyProof(policyInput);
		if (policyInput !== undefined && unpricedPolicyProof === undefined)
			return undefined;
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
			isProxy(budgetInput) ||
			isArray(budgetInput) ||
			!hasKnownFields(
				budgetInput,
				budgetDisclosureFields,
				"hobo.broker.yard.v1.IacBudgetDisclosure",
			) ||
			(inventoryHash !== undefined &&
				(typeof inventoryHash !== "string" || inventoryHash.length > 200)) ||
			(modelHash !== undefined &&
				(typeof modelHash !== "string" || modelHash.length > 200)) ||
			(quoteHash !== undefined &&
				(typeof quoteHash !== "string" || quoteHash.length > 200))
		)
			return undefined;
		const budgetProperties = getOwnDescriptors(budgetInput);
		const evaluation = hasOwnDescriptor(budgetProperties, "evaluation")
			? budgetProperties.evaluation
			: undefined;
		const reservation = hasOwnDescriptor(budgetProperties, "reservation")
			? budgetProperties.reservation
			: undefined;
		if (
			evaluation === undefined ||
			!hasOwnDescriptor(evaluation, "value") ||
			typeof evaluation.value !== "string" ||
			!name(evaluation.value) ||
			reservation === undefined ||
			!hasOwnDescriptor(reservation, "value") ||
			typeof reservation.value !== "string" ||
			!name(reservation.value)
		)
			return undefined;
		let reservationId: string | undefined;
		let executionDigest: string | undefined;
		let unboundedExposure: boolean | undefined;
		let unpricedScopeProof: UnpricedScopeProof | undefined;
		if (reservationInput !== undefined) {
			if (
				typeof reservationInput !== "object" ||
				reservationInput === null ||
				isProxy(reservationInput) ||
				isArray(reservationInput) ||
				!hasKnownFields(
					reservationInput,
					reservationFields,
					"hobo.broker.yard.v1.BudgetReservation",
				)
			)
				return undefined;
			const id = getOwnDescriptor(reservationInput, "reservationId");
			if (
				id === undefined ||
				!hasOwnDescriptor(id, "value") ||
				typeof id.value !== "string" ||
				!reservationName(id.value)
			)
				return undefined;
			reservationId = id.value;
			const execution = getOwnDescriptor(reservationInput, "executionDigest");
			if (execution !== undefined) {
				if (
					!hasOwnDescriptor(execution, "value") ||
					typeof execution.value !== "string" ||
					execution.value.length > 200
				)
					return undefined;
				executionDigest = execution.value;
			}
			const unbounded = getOwnDescriptor(reservationInput, "unboundedExposure");
			if (unbounded !== undefined) {
				if (
					!hasOwnDescriptor(unbounded, "value") ||
					typeof unbounded.value !== "boolean"
				)
					return undefined;
				unboundedExposure = unbounded.value;
			}
			const scope = getOwnDescriptor(reservationInput, "unpricedScopeProof");
			if (scope !== undefined) {
				if (!hasOwnDescriptor(scope, "value")) return undefined;
				if (scope.value !== undefined) {
					unpricedScopeProof = readUnpricedScopeProof(scope.value);
					if (unpricedScopeProof === undefined) return undefined;
				}
			}
			const nestedPolicy = getOwnDescriptor(
				reservationInput,
				"unpricedPolicyProof",
			);
			if (nestedPolicy !== undefined) {
				if (!hasOwnDescriptor(nestedPolicy, "value")) return undefined;
				if (nestedPolicy.value !== undefined) {
					const checkedPolicy = readUnpricedPolicyProof(nestedPolicy.value);
					if (
						checkedPolicy === undefined ||
						unpricedPolicyProof === undefined ||
						!sameUnpricedPolicyProof(checkedPolicy, unpricedPolicyProof)
					)
						return undefined;
				}
			}
		}
		if (
			status === "denied" &&
			(reservationId !== undefined ||
				unpricedPolicyProof !== undefined ||
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
			if (executionDigest !== undefined)
				result.reservation.executionDigest = executionDigest;
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

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this parser checks the untrusted provider output before returning bounded string-valued data. */
function readOutputs(value: unknown): Record<string, string> | undefined {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			isProxy(value) ||
			isArray(value)
		)
			return undefined;
		const prototype = getPrototype(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (getOwnSymbols(value).length !== 0) return undefined;
		const descriptors = getOwnDescriptors(value);
		const keys = objectKeys(descriptors);
		if (keys.length > 256) return undefined;
		const entries: [string, string][] = [];
		let size = 0;
		for (const key of keys) {
			const descriptor = hasOwnDescriptor(descriptors, key)
				? descriptors[key]
				: undefined;
			if (
				!name(key) ||
				descriptor === undefined ||
				!descriptor.enumerable ||
				!hasOwnDescriptor(descriptor, "value") ||
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

function readDrift(value: unknown, target: Target): IacDriftReport | undefined {
	try {
		if (typeof value !== "object" || value === null || isProxy(value))
			return undefined;
		const field = getOwnDescriptor(value, "resources");
		if (
			field === undefined ||
			!hasOwnDescriptor(field, "value") ||
			isProxy(field.value) ||
			!isArray(field.value) ||
			field.value.length !== target.resources.length ||
			field.value.length > 256
		)
			return undefined;
		const expected = new Map(
			target.resources.map((entry) => [entry.resourceId, entry.resourceType]),
		);
		const observed: Record<string, string> = Object.create(null);
		let drift = false;
		for (let index = 0; index < field.value.length; index++) {
			const item = getOwnDescriptor(field.value, String(index));
			if (
				item === undefined ||
				!hasOwnDescriptor(item, "value") ||
				!item.enumerable ||
				typeof item.value !== "object" ||
				item.value === null ||
				isProxy(item.value)
			)
				return undefined;
			const fqn = getOwnDescriptor(item.value, "fqn");
			const resourceType = getOwnDescriptor(item.value, "resourceType");
			const status = getOwnDescriptor(item.value, "status");
			if (
				fqn === undefined ||
				!hasOwnDescriptor(fqn, "value") ||
				typeof fqn.value !== "string" ||
				resourceType === undefined ||
				!hasOwnDescriptor(resourceType, "value") ||
				typeof resourceType.value !== "string" ||
				status === undefined ||
				!hasOwnDescriptor(status, "value") ||
				(status.value !== "in-sync" &&
					status.value !== "drifted" &&
					status.value !== "missing") ||
				expected.get(fqn.value) !== resourceType.value ||
				hasOwnDescriptor(observed, fqn.value)
			)
				return undefined;
			observed[fqn.value] = status.value;
			drift ||= status.value === "drifted" || status.value === "missing";
		}
		return { drift, observed: { ...observed } };
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

export function createAlchemyIacProvider<
	Output,
	Requirements,
	Assessment extends object,
>(
	inputOptions: AlchemyIacProviderOptions<Output, Requirements, Assessment>,
): AlchemyIacProvider<Assessment> {
	const options = captureAlchemyOptions(inputOptions);
	const target = captureAlchemyTargetOption(options);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: every distributed branch is already a closed, configured stack; Requirements only describes its internally supplied provider metadata.
	const suppliedStack = options.stack as Stack.ConfiguredStack<
		Output,
		Requirements
	>;
	const composite = captureCompositeGuard(options.composite);
	const safeFailure = (
		fallback:
			| "PLAN_UNINSPECTABLE"
			| "PLAN_UNAVAILABLE"
			| "DRIFT_CHECK_UNAVAILABLE",
	): AlchemyIacError => {
		return new AlchemyIacError(
			fallback,
			"the Alchemy operation could not be safely completed",
		);
	};
	const inspectSafely = (plan: Parameters<typeof inspectAlchemyPlan>[0]) => {
		const result = captureAlchemyInspection(plan, target, composite);
		if (result.ok) return result.value;
		throw new AlchemyIacError(
			result.code,
			"the Alchemy plan could not be safely inspected",
		);
	};
	const reinspectSafely = (
		plan: Parameters<typeof reinspectAlchemyPlan>[0],
	) => {
		const result = captureAlchemyReinspection(plan, target, composite);
		if (result.ok) return result.value;
		throw new AlchemyIacError(
			result.code,
			"the Alchemy plan could not be safely inspected",
		);
	};
	const route = captureRoutePort(options.route);
	const financial = captureFinancialPort(options.financial);
	const resolveRoute = options.resolveRoute;
	/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the host resolver is checked before use. */
	if (
		resolveRoute !== undefined &&
		(typeof resolveRoute !== "function" || isProxy(resolveRoute))
	)
		throw new AlchemyIacError(
			"ROUTE_OPERATION_UNVERIFIED",
			"the trusted operation resolver is malformed or unavailable",
		);
	/* oxlint-enable anti-slop/no-runtime-typeof */
	const runtimeLayer = options.runtimeLayer;
	const runtimeDirectory = options.runtimeDirectory;
	const operationTimeoutMs =
		options.operationTimeoutMs === undefined
			? 300_000
			: options.operationTimeoutMs;
	if (
		!Number.isSafeInteger(operationTimeoutMs) ||
		operationTimeoutMs < 1 ||
		operationTimeoutMs > 3_600_000
	)
		throw new AlchemyIacError(
			"DEADLINE_INVALID",
			"operation deadline must be 1 to 3,600,000 milliseconds",
		);
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
	const previews = new NativeMap<string, string>();
	const claimed = new NativeMap<string, string>();
	const running = new NativeSet<string>();
	const unresolved = new NativeMap<string, string | undefined>();
	const pending = new NativeMap<string, symbol>();
	const programSnapshots = new NativeWeakMap<
		IacProgram,
		CapturedAlchemyProgram
	>();
	const reading = new NativeSet<symbol>();
	const snapshotProgram = (program: IacProgram): IacProgram => {
		const captured = captureAlchemyProgram(program);
		applyHostCallback(weakMapSet, programSnapshots, [
			captured.program,
			captured,
		]);
		return captured.program;
	};
	const capturedProgram = (program: IacProgram): CapturedAlchemyProgram => {
		const captured: CapturedAlchemyProgram | undefined = applyHostCallback(
			weakMapGet,
			programSnapshots,
			[program],
		);
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
		deadline: OperationDeadline,
	): Promise<boolean> => {
		if (deadlineExpired(deadline)) return false;
		try {
			const input = Object.freeze({
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
			});
			if (deadlineExpired(deadline)) return false;
			return (await stateOwnership.verify(input)) === true;
		} catch {
			return false;
		}
	};
	const requireStateOwnership = async (
		program: IacProgram,
		phase: AlchemyStateOwnershipCheck["phase"],
		deadline: OperationDeadline,
	): Promise<void> => {
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		const verified = await verifyStateOwnership(program, phase, deadline);
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		if (!verified)
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
		deadline: OperationDeadline,
		phase: "plan" | "execute" | "drift",
		onBodyFailure?: () => void,
	): Promise<A> => {
		let result: Exit.Exit<A, unknown>;
		try {
			const supplied = Effect.scoped(
				Effect.provide(Effect.exit(effect), runtimeLayer).pipe(
					Effect.provideService(AlchemyContext, {
						dotAlchemy: runtimeDirectory,
						dev: false,
						adopt: false,
					}),
				),
			);
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the runtime layer and AlchemyContext supply the declared services, and scoped supplies Scope.
			const complete = supplied as Effect.Effect<
				Exit.Exit<A, unknown>,
				unknown,
				never
			>;
			result = await Effect.runPromise(complete);
		} catch {
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
			throw safeFailure(
				phase === "drift" ? "DRIFT_CHECK_UNAVAILABLE" : "PLAN_UNAVAILABLE",
			);
		}
		if (Exit.isFailure(result)) {
			onBodyFailure?.();
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
			throw safeFailure(
				phase === "drift" ? "DRIFT_CHECK_UNAVAILABLE" : "PLAN_UNAVAILABLE",
			);
		}
		return result.value;
	};
	const verifyStateWithinDeadline = (
		plan: Parameters<typeof verifyAlchemyStateIdentities>[0],
		deadline: OperationDeadline,
	) =>
		Effect.gen(function* () {
			if (deadlineExpired(deadline)) return false;
			return yield* verifyAlchemyStateIdentities(plan);
		});
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
		deadline: OperationDeadline,
	): Promise<IacRouteResolution | undefined> => {
		if (deadlineExpired(deadline)) return undefined;
		if (resolveRoute === undefined || program.operationGeneration === undefined)
			return undefined;
		try {
			const input = Object.freeze({
				tenantId: target.tenantId,
				deploymentId: program.deploymentId,
				programId: program.programId,
				resourceId: program.resourceId,
				logicalStackName: program.stackName,
				declarationDigest: capturedProgram(program).declarationDigest,
				operation: program.action === "destroy" ? "destroy" : "deploy",
				operationGeneration: program.operationGeneration,
				requestId,
			});
			if (deadlineExpired(deadline)) return undefined;
			const result = await resolveRoute(input);
			if (deadlineExpired(deadline)) return undefined;
			return readRouteResolution(result);
		} catch {
			return undefined;
		}
	};
	const verifyRoute = async (
		input: IacRoutePermit,
		requestId: string,
		operation: IacRouteOperation,
		deadline: OperationDeadline,
		expected?: FinancialExpectation,
	): Promise<IacRoutePermit | undefined> => {
		if (deadlineExpired(deadline)) return undefined;
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
		if (deadlineExpired(deadline)) return undefined;
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
			return;
		}
	};
	const assessPricingCore = async (
		program: IacProgram,
		deadline: OperationDeadline,
	) => {
		const stableProgram = snapshotProgram(program);
		const key = checkProgram(stableProgram);
		if (!fenceMapHas(previews, key) && fenceMapSize(previews) >= 128)
			throw new AlchemyIacError(
				"PREVIEW_LIMIT",
				"provider preview capacity reached",
			);
		fenceMapDelete(previews, key);
		await requireStateOwnership(stableProgram, "plan", deadline);
		verifyCompositeEnvironment(
			composite,
			target,
			"plan",
			stableProgram.action === "destroy" ? "destroy" : "deploy",
		);
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		const result = await run(
			Effect.gen(function* () {
				if (deadlineExpired(deadline))
					return { ok: false as const, error: deadlineError(deadline) };
				const plan = yield* planned(stableProgram);
				if (deadlineExpired(deadline))
					return { ok: false as const, error: deadlineError(deadline) };
				const initialState = yield* verifyStateWithinDeadline(plan, deadline);
				if (deadlineExpired(deadline))
					return { ok: false as const, error: deadlineError(deadline) };
				if (!initialState)
					return {
						ok: false as const,
						error: new AlchemyIacError(
							"STATE_IDENTITY_UNVERIFIED",
							"persisted Alchemy state identities are ambiguous or unavailable",
						),
					};
				if (deadlineExpired(deadline))
					return { ok: false as const, error: deadlineError(deadline) };
				try {
					const inspected = inspectSafely(plan);
					const ownerVerified = yield* Effect.promise(() =>
						verifyStateOwnership(stableProgram, "plan", deadline),
					);
					if (deadlineExpired(deadline))
						return { ok: false as const, error: deadlineError(deadline) };
					if (!ownerVerified)
						return {
							ok: false as const,
							error: new AlchemyIacError(
								"STATE_SCOPE_UNVERIFIED",
								"state ownership changed during planning",
							),
						};
					const stateVerified = yield* verifyStateWithinDeadline(
						plan,
						deadline,
					);
					if (deadlineExpired(deadline))
						return { ok: false as const, error: deadlineError(deadline) };
					if (!stateVerified)
						return {
							ok: false as const,
							error: new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state changed during planning",
							),
						};
					if (reinspectSafely(plan) !== inspected.digest)
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
			deadline,
			"plan",
		);
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		if (!result.ok) throw result.error;
		const digest = scopedPlanDigest(result.inspected.digest, stableProgram);
		const plan = financialInputs(digest, stableProgram);
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		let assessment: Assessment & { diff: IacDiff };
		try {
			assessment = {
				...financial.assess(plan),
				diff: {
					summary: `${result.inspected.changes} planned resource changes`,
					changes: result.inspected.changes,
				},
			};
		} catch {
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
			throw new AlchemyIacError(
				"PRICING_ASSESSMENT_UNAVAILABLE",
				"the financial assessment could not be completed",
			);
		}
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		if (!fenceMapHas(previews, key) && fenceMapSize(previews) >= 128)
			throw new AlchemyIacError(
				"PREVIEW_LIMIT",
				"provider preview capacity reached",
			);
		fenceMapSet(previews, key, digest);
		return assessment;
	};
	const boundedRead = <T>(
		deadline: OperationDeadline,
		work: () => Promise<T>,
		onTimeout: () => void = () => {},
	): Promise<BoundedValue<T>> => {
		if (fenceSetSize(reading) >= 128)
			throw new AlchemyIacError(
				"READ_OPERATION_LIMIT",
				"too many planning or refresh operations remain in flight",
			);
		const token = Symbol("alchemy-read");
		fenceSetAdd(reading, token);
		let started = false;
		return boundedOperation(
			deadline,
			async () => {
				started = true;
				try {
					return await work();
				} finally {
					fenceSetDelete(reading, token);
				}
			},
			() => {
				if (!started) fenceSetDelete(reading, token);
				onTimeout();
			},
		);
	};
	const assessPricingOperation = async (
		program: IacProgram,
		deadline: OperationDeadline,
	) => {
		const stableProgram = snapshotProgram(program);
		const key = checkProgram(stableProgram);
		const result = (
			await boundedRead(
				deadline,
				() => assessPricingCore(stableProgram, deadline),
				() => {
					fenceMapDelete(previews, key);
				},
			)
		).value;
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		return result;
	};
	const assessPricing: AlchemyIacProvider<Assessment>["assessPricing"] = (
		program,
	) =>
		assessPricingOperation(
			program,
			startDeadline("preview", operationTimeoutMs),
		);
	const preview = async (program: IacProgram): Promise<IacDiff> => {
		const deadline = startDeadline("preview", operationTimeoutMs);
		const result = await assessPricingOperation(program, deadline);
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		return result.diff;
	};
	const executeUnlocked = async (
		program: IacProgram,
		requestId: string,
		operation: IacRouteOperation,
		deadline: OperationDeadline,
		fenceKey: string,
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
		const priorReservation = fenceMapGet(claimed, key);
		if (priorReservation !== undefined)
			throw new AlchemyIacError(
				"EXECUTION_ALREADY_CLAIMED",
				"execution has already been claimed",
				undefined,
				priorReservation,
			);
		const previewDigest = fenceMapGet(previews, key);
		if (previewDigest === undefined)
			throw new AlchemyIacError(
				"PREVIEW_REQUIRED",
				"preview this program before applying it",
			);
		let heldReservation: string | undefined;
		let result:
			| { error: unknown }
			| { outputs: Record<string, string>; admission: HeldFinancialDecision };
		await requireStateOwnership(program, "plan", deadline);
		verifyCompositeEnvironment(
			composite,
			target,
			"plan",
			program.action === "destroy" ? "destroy" : "deploy",
		);
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		let bodyFailed = false;
		try {
			result = await run(
				Effect.gen(function* () {
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					const plan = yield* planned(program);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					const initialState = yield* verifyStateWithinDeadline(plan, deadline);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (!initialState)
						return {
							error: new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state identities are ambiguous or unavailable",
							),
						};
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					let inspected: ReturnType<typeof inspectAlchemyPlan>;
					try {
						inspected = inspectSafely(plan);
					} catch (error) {
						return { error };
					}
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
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
					const planOwnership = yield* Effect.promise(() =>
						verifyStateOwnership(program, "plan", deadline),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (!planOwnership)
						return {
							error: new AlchemyIacError(
								"STATE_SCOPE_UNVERIFIED",
								"state ownership changed before admission",
							),
						};
					const routeBeforeAdmission = yield* Effect.promise(() =>
						verifyRoute(
							permit,
							requestId,
							operation,
							deadline,
							checkedExpectation,
						),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (routeBeforeAdmission === undefined)
						return {
							error: new AlchemyIacError(
								"ROUTE_PERMIT_UNVERIFIED",
								"the shared route authority did not verify this attempt",
							),
						};
					const consumed = yield* Effect.promise(async () => {
						if (deadlineExpired(deadline)) return false;
						try {
							return (await route?.consumeAttempt(permit)) === true;
						} catch {
							return false;
						}
					});
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (!consumed)
						return {
							error: new AlchemyIacError(
								"ROUTE_PERMIT_UNVERIFIED",
								"the route attempt could not be consumed exactly once",
							),
						};
					deadline.phase = "admission";
					const admitted = yield* Effect.promise(async () => {
						if (deadlineExpired(deadline))
							return { error: deadlineError(deadline) };
						try {
							const plan = financialInputs(admittedPlanDigest, program);
							if (deadlineExpired(deadline))
								return { error: deadlineError(deadline) };
							return {
								decision: await financial.admit(
									requestId,
									plan,
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
					const expiredAfterAdmission = deadlineExpired(deadline);
					if ("error" in admitted)
						return {
							error: expiredAfterAdmission
								? deadlineError(deadline)
								: admitted.error,
						};
					const decision = readFinancialDecision(
						admitted.decision,
						target.tenantId,
					);
					const knownReservation = readKnownReservation(
						admitted.decision,
						requestId,
						target.targetId,
						target.tenantId,
					);
					if (knownReservation !== undefined)
						deadline.reservationId = knownReservation;
					if (expiredAfterAdmission || deadlineExpired(deadline)) {
						const lateReservation = knownReservation;
						if (
							lateReservation === `iac:${requestId}` &&
							reservationName(lateReservation)
						) {
							deadline.reservationId = lateReservation;
							fenceMapSet(unresolved, fenceKey, lateReservation);
							void markUncertain(lateReservation);
						}
						return { error: deadlineError(deadline) };
					}
					if (decision === undefined) {
						const unsupportedEvidence =
							knownReservation !== undefined &&
							hasUnsupportedSettlementEvidence(
								admitted.decision,
								requestId,
								target.targetId,
							);
						if (knownReservation !== undefined) {
							deadline.reservationId = knownReservation;
							fenceMapSet(unresolved, fenceKey, knownReservation);
							yield* Effect.promise(() => markUncertain(knownReservation));
						}
						return {
							error: new AlchemyIacError(
								unsupportedEvidence
									? "ADMISSION_UNSUPPORTED_EVIDENCE"
									: "ADMISSION_RECEIPT_INVALID",
								unsupportedEvidence
									? "the IaC financial port cannot authenticate fence or settlement evidence"
									: "admission receipt could not be safely inspected",
								undefined,
								knownReservation,
							),
						};
					}
					if (
						decision.requestId !== requestId ||
						decision.targetId !== target.targetId ||
						(decision.reservation !== undefined &&
							knownReservation === undefined)
					)
						return {
							error: new AlchemyIacError(
								"ADMISSION_RECEIPT_INVALID",
								"admission or reservation belongs to another scope",
							),
						};
					if (decision.status !== "admitted")
						return {
							error: new AlchemyIacError(
								decision.code || "ADMISSION_FAILED",
								decision.message || "target was not admitted",
								decision,
								knownReservation,
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
								/^sha256:[a-f0-9]{64}$/u.test(
									decision.reservation.executionDigest ?? "",
								) &&
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
						const reservationId = knownReservation;
						if (reservationId !== undefined) {
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
					deadline.phase = "held";
					deadline.reservationId = claimedReservationId;
					heldReservation = claimedReservationId;
					fenceMapSet(claimed, key, claimedReservationId);
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
								executionDigest: decision.reservation.executionDigest,
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
								executionDigest: decision.reservation.executionDigest,
								unboundedExposure: false,
							},
						};
					}
					const confirmed = yield* Effect.promise(async () => {
						if (deadlineExpired(deadline)) return false;
						try {
							const held = structuredClone(admission);
							const plan = financialInputs(admittedPlanDigest, program);
							if (deadlineExpired(deadline)) return false;
							return (await financial.revalidate(held, plan)) === true;
						} catch {
							return false;
						}
					});
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
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
						verifyRoute(
							permit,
							requestId,
							operation,
							deadline,
							checkedExpectation,
						),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
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
						resolveAuthorizedOperation(program, requestId, deadline),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
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
						if (deadlineExpired(deadline))
							return { error: deadlineError(deadline) };
						if (inspectSafely(plan).digest !== inspected.digest) {
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
					const applyOwnership = yield* Effect.promise(() =>
						verifyStateOwnership(program, "apply", deadline),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (!applyOwnership) {
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
					const finalState = yield* verifyStateWithinDeadline(plan, deadline);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (!finalState) {
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
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					try {
						if (reinspectSafely(plan) !== inspected.digest) {
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
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					deadline.phase = "provider";
					const outcome = yield* Effect.exit(
						Effect.gen(function* () {
							if (deadlineExpired(deadline))
								return yield* Effect.fail(deadlineError(deadline));
							return yield* Alchemist.apply(plan);
						}),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
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
					deadline.phase = "completed";
					const completedOwnership = yield* Effect.promise(() =>
						verifyStateOwnership(program, "complete", deadline),
					);
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
					if (!completedOwnership) {
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
						if (deadlineExpired(deadline))
							return { error: deadlineError(deadline) };
						authorizationVerified = inspected.revalidateSources();
					} catch {
						authorizationVerified = false;
					}
					if (deadlineExpired(deadline))
						return { error: deadlineError(deadline) };
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
				deadline,
				"execute",
				() => {
					bodyFailed = true;
				},
			);
		} catch (error) {
			if (bodyFailed && deadline.phase === "route") throw error;
			const reservation =
				heldReservation ?? deadline.reservationId ?? unresolved.get(fenceKey);
			if (deadline.phase !== "before-route") {
				unresolved.set(fenceKey, reservation);
				if (reservation !== undefined) {
					if (deadlineExpired(deadline)) void markUncertain(reservation);
					else await markUncertain(reservation);
				}
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				const code =
					deadline.phase === "route"
						? "ROUTE_OUTCOME_UNKNOWN"
						: deadline.phase === "admission"
							? "ADMISSION_OUTCOME_UNKNOWN"
							: deadline.phase === "completed"
								? "APPLY_CLEANUP_UNCERTAIN"
								: "APPLY_OUTCOME_UNKNOWN";
				throw new AlchemyIacError(
					code,
					"the route, financial hold or provider outcome requires reconciliation",
					undefined,
					reservation,
				);
			}
			throw error;
		}
		if ("error" in result) throw result.error;
		return result;
	};
	const executeCore = async (
		stableProgram: IacProgram,
		requestId: string | undefined,
		expected: FinancialExpectation | undefined,
		suppliedPermit: IacRoutePermit | undefined,
		deadline: OperationDeadline,
		fenceKey: string,
	) => {
		const key = checkProgram(stableProgram);
		if (fenceMapHas(unresolved, fenceKey)) {
			const reservationId = fenceMapGet(unresolved, fenceKey);
			throw new AlchemyIacError(
				reservationId === undefined
					? "EXECUTION_OUTCOME_UNRESOLVED"
					: "EXECUTION_ALREADY_CLAIMED",
				"the previous execution must be reconciled before another attempt",
				undefined,
				reservationId,
			);
		}
		if (fenceSetHas(running, fenceKey))
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
		const previewDigest = fenceMapGet(previews, key);
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
		if (fenceSetSize(running) + fenceMapSize(unresolved) >= 128)
			throw new AlchemyIacError(
				"EXECUTION_LIMIT",
				"provider execution capacity reached",
			);
		fenceSetAdd(running, fenceKey);
		try {
			await requireStateOwnership(stableProgram, "plan", deadline);
			const resolution = await resolveAuthorizedOperation(
				stableProgram,
				requestId,
				deadline,
			);
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
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
					deadline,
					fenceKey,
					checkedExpectation,
					suppliedPermit,
				);
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				fenceMapDelete(previews, key);
				fenceMapDelete(claimed, key);
				return result;
			}
			deadline.phase = "route";
			const state: RouteExecutionState = { invoked: false };
			let routeResult: Awaited<ReturnType<IacRoutePort["runDirect"]>>;
			try {
				const input = {
					tenantId: target.tenantId,
					requestId: resolvedRequestId,
					operation: routeOperation,
					targetId: target.targetId,
					plan: financialInputs(previewDigest, stableProgram),
				};
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				routeResult = await route.runDirect(input, async (attempt) => {
					if (state.invoked)
						throw new Error("route callback was invoked more than once");
					state.invoked = true;
					if (deadlineExpired(deadline)) {
						state.error = deadlineError(deadline);
						return {
							value: true,
							outcome: {
								status: "uncertain" as const,
								targetId: target.targetId,
							},
						};
					}
					const checkedAttempt = readRouteAttempt(attempt);
					if (checkedAttempt === undefined) {
						state.error = new AlchemyIacError(
							"ROUTE_OUTCOME_UNKNOWN",
							"the route authority returned a malformed attempt",
						);
						return {
							value: true,
							outcome: {
								status: "uncertain" as const,
								targetId: target.targetId,
							},
						};
					}
					if (deadlineExpired(deadline)) throw deadlineError(deadline);
					try {
						state.result = await executeUnlocked(
							stableProgram,
							resolvedRequestId,
							routeOperation,
							deadline,
							fenceKey,
							checkedExpectation,
							checkedAttempt.permit,
						);
						if (deadlineExpired(deadline)) throw deadlineError(deadline);
						return {
							value: true,
							outcome: {
								status: "selected" as const,
								targetId: target.targetId,
							},
						};
					} catch (error) {
						const failure = deadlineExpired(deadline)
							? deadlineError(deadline)
							: error instanceof AlchemyIacError
								? error
								: new AlchemyIacError(
										"ROUTE_OUTCOME_UNKNOWN",
										"the route attempt outcome is unknown",
									);
						if (
							!failure.requiresReconciliation &&
							failure.executionOutcome === "not-started"
						) {
							await checkedAttempt.deny();
							if (deadlineExpired(deadline)) {
								state.error = deadlineError(deadline);
								return {
									value: true,
									outcome: {
										status: "uncertain" as const,
										targetId: target.targetId,
									},
								};
							}
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
				});
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
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
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
			fenceMapDelete(previews, key);
			fenceMapDelete(claimed, key);
			return state.result;
		} catch (error) {
			if (error instanceof AlchemyIacError && error.requiresReconciliation)
				fenceMapSet(
					unresolved,
					fenceKey,
					error.reservationId ?? fenceMapGet(claimed, key),
				);
			throw error;
		} finally {
			fenceSetDelete(running, fenceKey);
		}
	};
	const execute = (
		program: IacProgram,
		requestId: string | undefined,
		expected: FinancialExpectation | undefined,
		suppliedPermit: IacRoutePermit | undefined,
		deadline: OperationDeadline,
	) => {
		const stableProgram = snapshotProgram(program);
		const stableExpectation =
			expected === undefined ? undefined : readFinancialExpectation(expected);
		if (expected !== undefined && stableExpectation === undefined)
			throw new AlchemyIacError(
				"EXPECTATION_INVALID",
				"the routing expectation is malformed",
			);
		const stablePermit =
			suppliedPermit === undefined
				? undefined
				: readRoutePermit(suppliedPermit);
		if (suppliedPermit !== undefined && stablePermit === undefined)
			throw new AlchemyIacError(
				"ROUTE_PERMIT_UNVERIFIED",
				"the route attempt permit is malformed",
			);
		const fenceKey = digestData({
			tenantId: target.tenantId,
			targetId: target.targetId,
			deploymentId: stableProgram.deploymentId,
			resourceId: stableProgram.resourceId,
		});
		if (fenceMapHas(unresolved, fenceKey)) {
			const reservationId = fenceMapGet(unresolved, fenceKey);
			throw new AlchemyIacError(
				reservationId === undefined
					? "EXECUTION_OUTCOME_UNRESOLVED"
					: "EXECUTION_ALREADY_CLAIMED",
				"the previous execution must be reconciled before another attempt",
				undefined,
				reservationId,
			);
		}
		if (fenceMapHas(pending, fenceKey))
			throw new AlchemyIacError(
				"EXECUTION_IN_PROGRESS",
				"another execution of this program must finish before retry",
			);
		if (fenceMapSize(pending) + fenceMapSize(unresolved) >= 128)
			throw new AlchemyIacError(
				"EXECUTION_LIMIT",
				"provider execution capacity reached",
			);
		const token = Symbol("alchemy-execution");
		fenceMapSet(pending, fenceKey, token);
		let started = false;
		return boundedOperation(
			deadline,
			async () => {
				started = true;
				try {
					return await executeCore(
						stableProgram,
						requestId,
						stableExpectation,
						stablePermit,
						deadline,
						fenceKey,
					);
				} finally {
					if (fenceMapGet(pending, fenceKey) === token)
						fenceMapDelete(pending, fenceKey);
				}
			},
			() => {
				if (!started && fenceMapGet(pending, fenceKey) === token)
					fenceMapDelete(pending, fenceKey);
				fenceMapSet(
					unresolved,
					fenceKey,
					deadline.reservationId ?? fenceMapGet(unresolved, fenceKey),
				);
				if (deadline.reservationId !== undefined)
					void markUncertain(deadline.reservationId);
			},
		);
	};
	const applyOperation = async (
		program: IacProgram,
		requestId: string | undefined,
		expected: FinancialExpectation | undefined,
		permit: IacRoutePermit | undefined,
		deadline: OperationDeadline,
	) => {
		const stableProgram = snapshotProgram(program);
		if (stableProgram.action === "destroy")
			throw new AlchemyIacError(
				"PROGRAM_SCOPE_MISMATCH",
				"apply cannot execute a destroy program",
			);
		const result = (
			await execute(stableProgram, requestId, expected, permit, deadline)
		).value;
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		return result;
	};
	const destroyOperation = async (
		program: IacProgram,
		requestId: string | undefined,
		expected: FinancialExpectation | undefined,
		permit: IacRoutePermit | undefined,
		deadline: OperationDeadline,
	) => {
		const stableProgram = snapshotProgram(program);
		if (stableProgram.action !== "destroy")
			throw new AlchemyIacError(
				"PROGRAM_SCOPE_MISMATCH",
				"destroy requires a destroy program",
			);
		const { admission } = (
			await execute(stableProgram, requestId, expected, permit, deadline)
		).value;
		if (deadlineExpired(deadline)) throw deadlineError(deadline);
		return { admission };
	};
	const applyWithAdmission: AlchemyIacProvider<Assessment>["applyWithAdmission"] =
		(program, requestId, expected, permit) =>
			applyOperation(
				program,
				requestId,
				expected,
				permit,
				startDeadline(
					permit === undefined ? "before-route" : "route",
					operationTimeoutMs,
				),
			);
	const destroyWithAdmission: AlchemyIacProvider<Assessment>["destroyWithAdmission"] =
		(program, requestId, expected, permit) =>
			destroyOperation(
				program,
				requestId,
				expected,
				permit,
				startDeadline(
					permit === undefined ? "before-route" : "route",
					operationTimeoutMs,
				),
			);
	return {
		id: "alchemy",
		preview,
		assessPricing,
		apply: async (program) => {
			const deadline = startDeadline("before-route", operationTimeoutMs);
			const result = await applyOperation(
				program,
				undefined,
				undefined,
				undefined,
				deadline,
			);
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
			return result.outputs;
		},
		applyWithAdmission,
		destroy: async (program) => {
			const deadline = startDeadline("before-route", operationTimeoutMs);
			await destroyOperation(
				program,
				undefined,
				undefined,
				undefined,
				deadline,
			);
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
		},
		destroyWithAdmission,
		refresh: async (program): Promise<IacDriftReport> => {
			const deadline = startDeadline("refresh", operationTimeoutMs);
			const stableProgram = snapshotProgram(program);
			checkProgram(stableProgram);
			const bounded = await boundedRead(deadline, async () => {
				const operation =
					stableProgram.action === "destroy" ? "destroy" : "deploy";
				await requireStateOwnership(stableProgram, "plan", deadline);
				verifyCompositeEnvironment(composite, target, "plan", operation);
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				const inspected = await run(
					Effect.gen(function* () {
						if (deadlineExpired(deadline)) throw deadlineError(deadline);
						const plan = yield* planned(stableProgram);
						if (deadlineExpired(deadline)) throw deadlineError(deadline);
						const validState = yield* verifyStateWithinDeadline(plan, deadline);
						if (deadlineExpired(deadline)) throw deadlineError(deadline);
						if (!validState)
							throw new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state identities are ambiguous or unavailable",
							);
						if (deadlineExpired(deadline)) throw deadlineError(deadline);
						return inspectSafely(plan);
					}),
					deadline,
					"plan",
				);
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				await requireStateOwnership(stableProgram, "plan", deadline);
				verifyCompositeEnvironment(composite, target, "plan", operation);
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				if (!inspected.revalidateSources())
					throw new AlchemyIacError(
						"COMPOSITE_PLAN_UNVERIFIED",
						"the source classification is no longer authorized",
					);
				await requireStateOwnership(stableProgram, "drift", deadline);
				const scan = await run(
					Effect.gen(function* () {
						if (deadlineExpired(deadline)) throw deadlineError(deadline);
						return yield* Alchemist.Drift.scan({
							stack,
							stage: target.stage,
						});
					}),
					deadline,
					"drift",
				);
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				await requireStateOwnership(stableProgram, "drift", deadline);
				verifyCompositeEnvironment(composite, target, "plan", operation);
				if (deadlineExpired(deadline)) throw deadlineError(deadline);
				if (!inspected.revalidateSources())
					throw new AlchemyIacError(
						"COMPOSITE_PLAN_UNVERIFIED",
						"the source classification is no longer authorized",
					);
				const report = readDrift(scan, target);
				if (report === undefined) {
					throw new AlchemyIacError(
						"DRIFT_CHECK_INCOMPLETE",
						"not every target resource could be inspected for drift",
					);
				}
				return report;
			});
			const result = bounded.value;
			if (deadlineExpired(deadline)) throw deadlineError(deadline);
			return result;
		},
	};
}
