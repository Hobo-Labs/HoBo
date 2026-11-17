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
	UnpricedPolicyProof,
	UnpricedScopeProof,
} from "./port.js";
import { captureAlchemyProgram } from "./program-boundary.js";
import {
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
export { captureAlchemyOptions } from "./input-boundary.js";
export type {
	AlchemyBindleMapping,
	AlchemyBindleOptions,
	AlchemyMappedPrimitive,
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
export type {
	AlchemyCompositeEffect,
	AlchemyCompositeEnvironment,
	AlchemyCompositeGuard,
	AlchemyCompositeObservation,
} from "./plan.js";
export { AlchemyIacError } from "./plan.js";
export type {
	FinancialDecision,
	FinancialExpectation,
	FinancialPlan,
	FinancialPort,
	HeldFinancialDecision,
	IacDiff,
	IacDriftReport,
	IacProgram,
	IacProvider,
	UnpricedPolicyProof,
	UnpricedScopeProof,
} from "./port.js";
export type { CapturedAlchemyProgram } from "./program-boundary.js";
export { captureAlchemyProgram } from "./program-boundary.js";
export { alchemyStateScopeKey } from "./state-identity.js";

export type AlchemyTargetInput = Omit<Target, "$typeName" | "resources"> & {
	readonly resources: readonly Omit<ResourceScope, "$typeName">[];
};

export function alchemyTarget(input: AlchemyTargetInput): Target {
	return captureAlchemyTarget(input);
}

export interface AlchemyIacProviderOptions<
	Output,
	Requirements,
	Assessment extends object,
> {
	readonly stack: Stack.ConfiguredStack<Output, Requirements>;
	readonly target: Target;
	/** A host-supplied runtime layer, including any credentials and execution services. */
	readonly runtimeLayer: Layer.Layer<
		Alchemist.Services | Requirements,
		unknown,
		never
	>;
	readonly runtimeDirectory: string;
	readonly financial: FinancialPort<Assessment>;
	/** Host-owned authorization for executable plan effects in an immutable sandbox. */
	readonly composite?: AlchemyCompositeGuard;
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
	): Promise<{
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	}>;
	destroyWithAdmission(
		program: IacProgram,
		requestId?: string,
		expected?: FinancialExpectation,
	): Promise<{ admission: HeldFinancialDecision }>;
}

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
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
function captureCompositeGuard(
	input: AlchemyCompositeGuard | undefined,
): AlchemyCompositeGuard | undefined {
	if (input === undefined) return undefined;
	try {
		const { proofRef, environmentDigest, verifyEnvironment, verifyPlan } =
			input;
		if (
			typeof proofRef !== "string" ||
			!name(proofRef) ||
			typeof environmentDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(environmentDigest) ||
			typeof verifyEnvironment !== "function" ||
			typeof verifyPlan !== "function"
		)
			throw new Error("invalid host guard");
		return Object.freeze({
			proofRef,
			environmentDigest,
			verifyEnvironment: verifyEnvironment.bind(input),
			verifyPlan: verifyPlan.bind(input),
		});
	} catch {
		throw new AlchemyIacError(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"host sandbox verification is malformed or unavailable",
		);
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: admission receipts cross a provider boundary; inspect own data properties before returning an independent domain value. */
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

function readFinancialDecision(input: unknown): FinancialDecision | undefined {
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
		const result: FinancialDecision = {
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
	const composite = captureCompositeGuard(options.composite);
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
	const stack = guardAlchemyStack(options.stack);
	if (
		!isAbsolute(options.runtimeDirectory) ||
		options.stack.stackName !== target.stackName ||
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
	const previews = new Map<string, string>();
	const claimed = new Map<string, string>();
	const running = new Set<string>();
	const unresolved = new Set<string>();
	const checkProgram = (input: IacProgram) => {
		const captured = captureAlchemyProgram(input);
		const program = captured.program;
		if (
			![
				program.programId,
				program.deploymentId,
				program.resourceId,
				program.provider,
				program.driver,
				program.stackName,
			].every(name) ||
			program.resourceId !== target.programResourceId ||
			program.stackName !== target.stackName ||
			!["preview", "apply", "destroy"].includes(program.action)
		) {
			throw new AlchemyIacError(
				"PROGRAM_SCOPE_MISMATCH",
				"program does not match the configured target",
			);
		}
		if (captured.declarationPresence === "present")
			throw new AlchemyIacError(
				"PROGRAM_DECLARATION_UNVERIFIED",
				"a host authority must authenticate the desired declaration against the configured stack",
			);
		const key = digestData({
			programId: program.programId,
			deploymentId: program.deploymentId,
			resourceId: program.resourceId,
			provider: program.provider,
			driver: program.driver,
			stackName: program.stackName,
			operation: program.action === "destroy" ? "destroy" : "deploy",
			targetId: target.targetId,
			tenantId: target.tenantId,
			operationGeneration: program.operationGeneration,
			declarationDigest: captured.declarationDigest,
		});
		return { program, key };
	};
	const run = async <A>(
		effect: Effect.Effect<
			A,
			unknown,
			Alchemist.Services | Requirements | import("effect/Scope").Scope
		>,
	): Promise<A> => {
		const supplied = Effect.scoped(
			Effect.provide(effect, options.runtimeLayer).pipe(
				Effect.provideService(AlchemyContext, {
					dotAlchemy: options.runtimeDirectory,
					dev: false,
					adopt: false,
				}),
			),
		);
		// SAFETY: the runtime layer and AlchemyContext supply the declared services, and scoped supplies Scope.
		const complete = supplied as Effect.Effect<A, unknown, never>;
		return Effect.runPromise(complete);
	};
	const planned = (program: Readonly<IacProgram>) =>
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
		program: Readonly<IacProgram>,
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
	const markUncertain = async (reservationId: string): Promise<void> => {
		try {
			await options.financial.uncertain(reservationId);
		} catch {
			/* preserve the durable hold */
		}
	};
	const assessPricing: AlchemyIacProvider<Assessment>["assessPricing"] = async (
		input,
	) => {
		const { program, key } = checkProgram(input);
		if (!previews.has(key) && previews.size >= 128)
			throw new AlchemyIacError(
				"PREVIEW_LIMIT",
				"provider preview capacity reached",
			);
		if (composite !== undefined)
			verifyCompositeEnvironment(
				composite,
				target,
				"plan",
				program.action === "destroy" ? "destroy" : "deploy",
			);
		const result = await run(
			Effect.gen(function* () {
				const plan = yield* planned(program);
				if (!(yield* verifyAlchemyStateIdentities(plan)))
					return {
						ok: false as const,
						error: new AlchemyIacError(
							"STATE_IDENTITY_UNVERIFIED",
							"persisted Alchemy state identities are ambiguous or unavailable",
						),
					};
				try {
					return {
						ok: true as const,
						inspected: inspectAlchemyPlan(plan, target, composite),
					};
				} catch (error) {
					return { ok: false as const, error };
				}
			}),
		);
		if (!result.ok) throw result.error;
		previews.set(key, result.inspected.digest);
		return {
			...options.financial.assess(
				financialInputs(result.inspected.digest, program),
			),
			diff: {
				summary: `${result.inspected.changes} planned resource changes`,
				changes: result.inspected.changes,
			},
		};
	};
	const preview = async (program: IacProgram): Promise<IacDiff> =>
		(await assessPricing(program)).diff;
	const executeUnlocked = async (
		input: IacProgram,
		requestedId?: string,
		expected?: FinancialExpectation,
		requireDestroy = false,
	): Promise<{
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	}> => {
		const { program, key } = checkProgram(input);
		if (requireDestroy && program.action !== "destroy")
			throw new AlchemyIacError(
				"PROGRAM_SCOPE_MISMATCH",
				"destroy requires a destroy program",
			);
		const requestId = requestedId ?? key;
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
		if (composite !== undefined)
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
					if (inspected.digest !== previewDigest)
						return {
							error: new AlchemyIacError(
								"PLAN_CHANGED",
								"the plan changed after preview",
							),
						};
					const admitted = yield* Effect.promise(async () => {
						try {
							return {
								decision: await options.financial.admit(
									requestId,
									financialInputs(inspected.digest, program),
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
					if (!(yield* verifyAlchemyStateIdentities(plan))) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"STATE_IDENTITY_UNVERIFIED",
								"persisted Alchemy state identities changed or became unavailable; the reservation is retained",
								undefined,
								claimedReservationId,
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
						admission = {
							...decision,
							budget: { evaluation: "allowed", reservation: "held" },
							reservation: { reservationId: claimedReservationId },
						};
					}
					const confirmed = yield* Effect.promise(async () => {
						try {
							return (
								(await options.financial.revalidate(
									structuredClone(admission),
									financialInputs(inspected.digest, program),
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
					try {
						if (composite !== undefined)
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
	const execute = async (
		input: IacProgram,
		requestId?: string,
		expected?: FinancialExpectation,
		requireDestroy = false,
	) => {
		const { program, key } = checkProgram(input);
		if (unresolved.has(key)) {
			const reservationId = claimed.get(key);
			throw new AlchemyIacError(
				reservationId === undefined
					? "EXECUTION_OUTCOME_UNRESOLVED"
					: "EXECUTION_ALREADY_CLAIMED",
				"the previous execution must be reconciled before another attempt",
				undefined,
				reservationId,
			);
		}
		if (running.has(key))
			throw new AlchemyIacError(
				"EXECUTION_IN_PROGRESS",
				"another execution of this program must finish before retry",
			);
		if (running.size >= 128)
			throw new AlchemyIacError(
				"EXECUTION_LIMIT",
				"provider execution capacity reached",
			);
		running.add(key);
		try {
			return await executeUnlocked(program, requestId, expected, requireDestroy);
		} catch (error) {
			if (error instanceof AlchemyIacError && error.requiresReconciliation)
				unresolved.add(key);
			throw error;
		} finally {
			running.delete(key);
		}
	};
	const applyWithAdmission: AlchemyIacProvider<Assessment>["applyWithAdmission"] =
		async (input, requestId, expected) => {
			const { program } = checkProgram(input);
			if (program.action === "destroy")
				throw new AlchemyIacError(
					"PROGRAM_SCOPE_MISMATCH",
					"apply cannot execute a destroy program",
				);
			return execute(program, requestId, expected);
		};
	const destroyWithAdmission: AlchemyIacProvider<Assessment>["destroyWithAdmission"] =
		async (program, requestId, expected) => {
			const { admission } = await execute(program, requestId, expected, true);
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
			checkProgram(program);
			const scan = await run(
				Alchemist.Drift.scan({ stack, stage: target.stage }),
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
