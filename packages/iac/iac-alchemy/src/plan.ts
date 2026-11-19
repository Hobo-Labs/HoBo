import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { StackPlan } from "alchemy/Alchemist";
import * as Output from "alchemy/Output";
import type { Target } from "./_generated/alchemy_iac_pb.js";
import { compareCodeUnits } from "./code-unit-order.js";
import type { FinancialDecision } from "./port.js";
import {
	type AlchemyPriorStateSecrets,
	type AlchemySecretFingerprint,
	type CapturedAlchemySecrets,
	captureAlchemyPlanSecrets,
	captureAlchemySecrets,
	fingerprintAlchemyRedacted,
	isAlchemyRedacted,
	secretResourceDomain,
	verifyAlchemySecrets,
} from "./secret-fingerprint.js";
import {
	type AlchemySourceBinding,
	type AlchemySourceClaim,
	type AlchemySourceRequirement,
	alchemySourceFor,
	captureAlchemySourceRequirements,
} from "./source-fence.js";
import { safeAlchemyFqn, safeAlchemyState } from "./state-identity.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

const hasOwnDescriptor = Object.hasOwn;
const isPlanProxy = utilTypes.isProxy;
const NativePlanMap = Map;
const planMapGet = NativePlanMap.prototype.get;
const planMapSet = NativePlanMap.prototype.set;
const createNull = Object.create;
const defineProperty = Object.defineProperty;
const freezeCaptured = Object.freeze;
const nativeString = String;

function appendOwnData<Value>(values: Value[], value: Value): void {
	const property: PropertyDescriptor = createNull(null);
	property.value = value;
	property.enumerable = true;
	property.configurable = true;
	property.writable = true;
	defineProperty(values, nativeString(values.length), freezeCaptured(property));
}

function sourceRequirementFor(
	requirements: readonly AlchemySourceRequirement[] | undefined,
	resourceId: string,
): AlchemySourceRequirement | undefined {
	if (requirements === undefined) return undefined;
	for (let index = 0; index < requirements.length; index++) {
		const entry = requirements[index];
		if (entry?.resourceId === resourceId) return entry;
	}
	return undefined;
}

function sourceInventoryMatches(
	requirements: readonly AlchemySourceRequirement[] | undefined,
	claims: readonly AlchemySourceClaim[],
): boolean {
	if (requirements === undefined) return claims.length === 0;
	if (requirements.length !== claims.length) return false;
	for (let index = 0; index < requirements.length; index++) {
		const required = requirements[index];
		if (required === undefined) return false;
		let matched = false;
		for (let position = 0; position < claims.length; position++) {
			const claim = claims[position];
			if (
				claim !== undefined &&
				claim.resourceId === required.resourceId &&
				claim.resourceType === required.resourceType &&
				claim.bindleName === required.bindleName &&
				claim.applicationName === required.applicationName &&
				claim.sourceKind === required.sourceKind &&
				claim.sourcePath === required.sourcePath
			) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}

function snapshotSourceClaims(
	claims: readonly AlchemySourceClaim[],
): readonly AlchemySourceClaim[] {
	const result: AlchemySourceClaim[] = [];
	for (let index = 0; index < claims.length; index++) {
		const claim = claims[index];
		if (claim === undefined)
			throw new AlchemyIacError(
				"SOURCE_FENCE_INCOMPLETE",
				"source claim is unavailable",
			);
		appendOwnData(result, freezeCaptured({ ...claim }));
	}
	return freezeCaptured(result);
}

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface AlchemyCompositeGuard {
	readonly proofRef: string;
	readonly environmentDigest: string;
	readonly verifyEnvironment: (input: AlchemyCompositeEnvironment) => boolean;
	readonly verifyPlan: (input: AlchemyCompositeObservation) => boolean;

	readonly sourceRequirements: readonly AlchemySourceRequirement[];

	readonly secretFingerprint?: AlchemySecretFingerprint;
}

export interface AlchemyCompositeEnvironment {
	readonly phase: "plan" | "apply";
	readonly operation: "deploy" | "destroy";
	readonly targetId: string;
	readonly tenantId: string;
	readonly stackName: string;
	readonly stage: string;
	readonly programResourceId: string;
	readonly sourceDigest: string;
	readonly environmentDigest: string;
	readonly proofRef: string;
	readonly inventoryEvidenceRef: string;
	readonly sourceRequirements: readonly AlchemySourceRequirement[];
	readonly scope: readonly {
		readonly resourceId: string;
		readonly resourceType: string;
		readonly providerId: string;
		readonly providerAccountRef: string;
		readonly productId: string;
	}[];
}

export interface AlchemyCompositeEffect {
	readonly kind: "action" | "expression" | "command";
	readonly type: string;
	readonly fingerprint: string;
}

export interface AlchemyCompositeObservation
	extends Omit<AlchemyCompositeEnvironment, "phase"> {
	readonly structuralDigest: string;
	readonly effects: readonly AlchemyCompositeEffect[];
	readonly sourceClaims: readonly AlchemySourceClaim[];
	readonly historicalSources: readonly AlchemyHistoricalSource[];

	readonly historicalResources: readonly AlchemyHistoricalResource[];
}

export interface AlchemyHistoricalSource {
	readonly resourceId: string;
	readonly resourceType: string;
	readonly priorStateDigest: string;
}

export interface AlchemyHistoricalResource {
	readonly resourceId: string;
	readonly resourceType: string;

	readonly priorResourceType: string;
	readonly action:
		| "create"
		| "update"
		| "adopted"
		| "replace"
		| "noop"
		| "delete"
		| "orphaned";
	readonly priorStateDigest: string;

	readonly renamedFrom: readonly string[];
}

const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getOwnDescriptors = Object.getOwnPropertyDescriptors;
const getOwnSymbols = Object.getOwnPropertySymbols;
const getPrototype = Object.getPrototypeOf;
const objectKeys = Object.keys;
const objectEntries = Object.entries;
const isArray = Array.isArray;
const reflectGet = Reflect.get;
const reflectApply = Reflect.apply;
const functionToString = Function.prototype.toString;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_EFFECTS = 1024;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: native rename lists are inspected as bounded external data. */
function captureRenamedFrom(value: unknown): readonly string[] | undefined {
	if (value === undefined) return Object.freeze([]);
	if (
		isPlanProxy(value) ||
		!isArray(value) ||
		value.length > 256 ||
		getOwnSymbols(value).length !== 0
	)
		return undefined;
	const properties = getOwnDescriptors(value);
	if (objectKeys(properties).length !== value.length + 1) return undefined;
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = hasOwnDescriptor(properties, String(index))
			? properties[String(index)]
			: undefined;
		if (
			item === undefined ||
			!hasOwnDescriptor(item, "value") ||
			!item.enumerable ||
			typeof item.value !== "string" ||
			!safeAlchemyFqn(item.value)
		)
			return undefined;
		result.push(item.value);
	}
	return new Set(result).size === result.length
		? Object.freeze(result)
		: undefined;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

function fingerprintFunction(value: (...args: never[]) => void): string {
	const source = reflectApply(functionToString, value, []);
	if (source.length > 65_536 || source.includes("[native code]"))
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"effect code is not inspectable",
		);
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export class AlchemyIacError extends Error {
	readonly requiresReconciliation: boolean;
	readonly executionOutcome: "not-started" | "unknown" | "completed";

	constructor(
		readonly code: string,
		message: string,
		readonly admission?: FinancialDecision,
		readonly reservationId?: string,
	) {
		super(`${code}: ${message}`);
		this.name = "AlchemyIacError";
		this.requiresReconciliation =
			reservationId !== undefined ||
			code === "ADMISSION_UNSUPPORTED_EVIDENCE" ||
			code === "APPLY_CLEANUP_UNCERTAIN" ||
			code === "EXECUTION_DEADLINE_BEFORE_ROUTE" ||
			code === "ROUTE_DEADLINE_UNKNOWN" ||
			code === "ADMISSION_DEADLINE_UNKNOWN" ||
			code === "EXECUTION_DEADLINE_AFTER_ADMISSION" ||
			code === "PROVIDER_DEADLINE_UNKNOWN" ||
			code === "ROUTE_COMPLETION_DEADLINE_UNKNOWN" ||
			code === "ADMISSION_OUTCOME_UNKNOWN" ||
			code === "ADMISSION_RECEIPT_INVALID" ||
			code === "EXECUTION_IN_PROGRESS" ||
			code === "EXECUTION_OUTCOME_UNRESOLVED" ||
			code === "EXECUTION_ALREADY_CLAIMED" ||
			code === "ROUTE_OUTCOME_UNKNOWN" ||
			code === "ROUTE_IN_PROGRESS" ||
			code === "ROUTE_ALREADY_FINISHED" ||
			code === "ROUTE_PERMIT_UNVERIFIED" ||
			admission?.status === "uncertain" ||
			admission?.status === "replay" ||
			admission?.budget?.reservation === "held" ||
			admission?.budget?.reservation === "uncertain";
		this.executionOutcome =
			code === "PREVIEW_DEADLINE_EXCEEDED" ||
			code === "REFRESH_DEADLINE_EXCEEDED" ||
			code === "ADMISSION_UNSUPPORTED_EVIDENCE" ||
			code === "EXECUTION_DEADLINE_BEFORE_ROUTE" ||
			code === "ROUTE_DEADLINE_UNKNOWN" ||
			code === "ADMISSION_DEADLINE_UNKNOWN" ||
			code === "EXECUTION_DEADLINE_AFTER_ADMISSION" ||
			code === "STATE_IDENTITY_UNVERIFIED" ||
			code === "STATE_SCOPE_UNVERIFIED" ||
			code === "PLAN_CHANGED_AFTER_ADMISSION" ||
			code === "PLAN_UNINSPECTABLE_AFTER_ADMISSION"
				? "not-started"
				: code === "ROUTE_COMPLETION_DEADLINE_UNKNOWN" ||
						code === "APPLY_CLEANUP_UNCERTAIN" ||
						code === "APPLY_OUTPUT_UNREPRESENTABLE" ||
						code === "STATE_SCOPE_UNCERTAIN" ||
						code === "SOURCE_FENCE_UNCERTAIN" ||
						code === "COMPOSITE_AUTHORIZATION_UNCERTAIN"
					? "completed"
					: this.requiresReconciliation
						? "unknown"
						: "not-started";
	}
}

let inspectionErrors: WeakMap<object, string> | undefined;

function inspectionFailure(code: string, message: string): AlchemyIacError {
	const error = new AlchemyIacError(code, message);
	inspectionErrors?.set(error, code);
	return error;
}

function detached<T>(work: () => T): T {
	const previous = inspectionErrors;
	inspectionErrors = undefined;
	try {
		return work();
	} finally {
		inspectionErrors = previous;
	}
}

function inspectResult<T>(
	work: () => T,
):
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: string } {
	const previous = inspectionErrors;
	const owned = new WeakMap<object, string>();
	inspectionErrors = owned;
	try {
		return { ok: true, value: work() };
	} catch (error) {
		return {
			ok: false,
			code:
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: only an object identity can be looked up in the private WeakMap. */
				(typeof error === "object" && error !== null && !isPlanProxy(error)
					? owned.get(error)
					: undefined) ?? "PLAN_UNINSPECTABLE",
		};
	} finally {
		inspectionErrors = previous;
	}
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/no-reflect-get -- SAFETY: this is the Alchemy plan input boundary; it inspects untrusted values and Alchemy's symbol-based output proxy before producing bounded canonical data. */
function isPlanOutput(value: unknown): boolean {
	try {
		return Output.isOutput(value);
	} catch {
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"a plan output cannot be inspected",
		);
	}
}

function encode(
	value: unknown,
	ancestors: Set<object>,
	budget: { remaining: number },
	depth: number,
	references?: ReadonlyMap<
		object,
		{ resourceId: string; resourceType: string }
	>,
	effects?: AlchemyCompositeEffect[],
	secrets?: CapturedAlchemySecrets,
	path: readonly string[] = [],
): JsonValue {
	if (--budget.remaining < 0 || depth > 32)
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"plan exceeds the fingerprint limits",
		);
	if (value === undefined) return ["undefined"];
	if (value === null) return ["null"];
	if (typeof value === "boolean") return ["boolean", value];
	if (typeof value === "string") {
		if (value.length > 4096)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"plan string exceeds the fingerprint limit",
			);
		return ["string", value];
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"plan contains a non-finite number",
			);
		return ["number", Object.is(value, -0) ? "-0" : String(value)];
	}
	if (
		references !== undefined &&
		(typeof value === "object" || typeof value === "function")
	) {
		const reference = references.get(value);
		if (reference !== undefined)
			return ["alchemy-resource", reference.resourceId, reference.resourceType];
	}
	if (
		references !== undefined &&
		(typeof value === "object" || typeof value === "function") &&
		isPlanOutput(value)
	) {
		if (ancestors.has(value))
			throw inspectionFailure("PLAN_UNINSPECTABLE", "plan contains a cycle");
		ancestors.add(value);
		try {
			let expression: unknown;
			try {
				expression = reflectGet(value, Output.ExprSymbol);
			} catch {
				throw inspectionFailure(
					"PLAN_UNINSPECTABLE",
					"a plan output cannot be inspected",
				);
			}
			if (typeof expression !== "object" || expression === null)
				throw inspectionFailure(
					"PLAN_UNINSPECTABLE",
					"invalid output expression",
				);
			if (isPlanProxy(expression))
				throw inspectionFailure(
					"PLAN_UNINSPECTABLE",
					"a plan output expression is not inspectable",
				);
			const prototype = getPrototype(expression);
			const data = (key: string): unknown => {
				const descriptor = getOwnDescriptor(expression, key);
				if (descriptor === undefined || !hasOwnDescriptor(descriptor, "value"))
					throw inspectionFailure(
						"PLAN_UNINSPECTABLE",
						"invalid output expression",
					);
				return descriptor.value;
			};
			if (
				prototype === Output.PropExpr.prototype &&
				data("kind") === "PropExpr"
			) {
				const identifier = data("identifier");
				const source = data("expr");
				if (
					typeof identifier !== "string" ||
					identifier.length === 0 ||
					identifier.length > 200 ||
					!isPlanOutput(source)
				)
					throw inspectionFailure(
						"PLAN_UNINSPECTABLE",
						"invalid output property",
					);
				return [
					"alchemy-property",
					identifier,
					encode(
						source,
						ancestors,
						budget,
						depth + 1,
						references,
						effects,
						secrets,
						[...path, "e:PropExpr.expr"],
					),
				];
			}
			if (
				prototype === Output.LiteralExpr.prototype &&
				data("kind") === "LiteralExpr"
			)
				return [
					"alchemy-literal",
					encode(
						data("value"),
						ancestors,
						budget,
						depth + 1,
						references,
						effects,
						secrets,
						[...path, "e:LiteralExpr.value"],
					),
				];
			if (prototype === Output.AllExpr.prototype && data("kind") === "AllExpr")
				return [
					"alchemy-all",
					encode(
						data("outs"),
						ancestors,
						budget,
						depth + 1,
						references,
						effects,
						secrets,
						[...path, "e:AllExpr.outs"],
					),
				];
			if (
				prototype === Output.NamedExpr.prototype &&
				data("kind") === "NamedExpr"
			) {
				const bindingName = data("bindingName");
				if (typeof bindingName !== "string" || bindingName.length > 200)
					throw inspectionFailure("PLAN_UNINSPECTABLE", "invalid output name");
				return [
					"alchemy-named",
					bindingName,
					encode(
						data("expr"),
						ancestors,
						budget,
						depth + 1,
						references,
						effects,
						secrets,
						[...path, "e:NamedExpr.expr"],
					),
				];
			}
			const executableKind =
				prototype === Output.ApplyExpr.prototype && data("kind") === "ApplyExpr"
					? "ApplyExpr"
					: prototype === Output.FlatMapExpr.prototype &&
							data("kind") === "FlatMapExpr"
						? "FlatMapExpr"
						: prototype === Output.EffectExpr.prototype &&
								data("kind") === "EffectExpr"
							? "EffectExpr"
							: undefined;
			if (executableKind !== undefined) {
				if (effects === undefined || effects.length >= MAX_EFFECTS)
					throw inspectionFailure(
						"PLAN_UNSUPPORTED_EFFECTS",
						"executable outputs require host authorization",
					);
				const callback = data("f");
				if (typeof callback !== "function")
					throw inspectionFailure(
						"PLAN_UNINSPECTABLE",
						"invalid output callback",
					);
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the runtime guard established that this value is callable; fingerprinting never invokes it.
				const fingerprint = fingerprintFunction(
					callback as (...args: never[]) => void,
				);
				effects.push({ kind: "expression", type: executableKind, fingerprint });
				return [
					"alchemy-executable",
					executableKind,
					fingerprint,
					encode(
						data("expr"),
						ancestors,
						budget,
						depth + 1,
						references,
						effects,
						secrets,
						[...path, `e:${executableKind}.expr`],
					),
				];
			}
			if (
				prototype === Output.ResourceExpr.prototype &&
				data("kind") === "ResourceExpr"
			) {
				const source = data("src");
				const reference =
					typeof source === "object" && source !== null
						? references.get(source)
						: undefined;
				if (reference !== undefined)
					return [
						"alchemy-resource",
						reference.resourceId,
						reference.resourceType,
					];
			}
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"output expression is not a scoped resource property",
			);
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object")
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"plan contains an unsupported value",
		);
	if (isPlanProxy(value))
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"plan contains an unsupported proxy",
		);
	if (isAlchemyRedacted(value)) {
		if (secrets === undefined)
			throw inspectionFailure(
				"PLAN_SECRET_UNVERIFIED",
				"redacted plan values require an independently authenticated secret fingerprint key",
			);
		try {
			return [
				"alchemy-redacted",
				fingerprintAlchemyRedacted(value, secrets, path),
			];
		} catch {
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"a redacted plan value cannot be safely identified",
			);
		}
	}
	if (ancestors.has(value))
		throw inspectionFailure("PLAN_UNINSPECTABLE", "plan contains a cycle");
	ancestors.add(value);
	try {
		const descriptors = getOwnDescriptors(value);
		if (getOwnSymbols(value).length > 0)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"plan contains symbol properties",
			);
		if (isArray(value)) {
			if (
				value.length > 1024 ||
				objectKeys(descriptors).some(
					(key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key),
				)
			)
				throw inspectionFailure(
					"PLAN_UNINSPECTABLE",
					"plan array is not bounded data",
				);
			const items: JsonValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const key = String(index);
				const descriptor = hasOwnDescriptor(descriptors, key)
					? descriptors[key]
					: undefined;
				if (descriptor === undefined || !hasOwnDescriptor(descriptor, "value"))
					throw inspectionFailure(
						"PLAN_UNINSPECTABLE",
						"plan array contains a hole or accessor",
					);
				items.push(
					encode(
						descriptor.value,
						ancestors,
						budget,
						depth + 1,
						references,
						effects,
						secrets,
						[...path, `i:${index}`],
					),
				);
			}
			return ["array", items];
		}
		const prototype = getPrototype(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"plan contains non-data objects or unresolved references",
			);
		const pairs: JsonValue[] = [];
		for (const key of objectKeys(descriptors).sort()) {
			const descriptor = hasOwnDescriptor(descriptors, key)
				? descriptors[key]
				: undefined;
			if (
				descriptor === undefined ||
				!hasOwnDescriptor(descriptor, "value") ||
				!descriptor.enumerable ||
				key.length > 200
			)
				throw inspectionFailure(
					"PLAN_UNINSPECTABLE",
					"plan contains hidden or computed properties",
				);
			pairs.push([
				key,
				encode(
					descriptor.value,
					ancestors,
					budget,
					depth + 1,
					references,
					effects,
					secrets,
					[...path, `p:${key}`],
				),
			]);
		}
		return ["object", pairs];
	} finally {
		ancestors.delete(value);
	}
}

export function digestData(value: unknown): string {
	return detached(() => digest(value));
}

function hashAlchemyPriorStateInternal(
	value: unknown,
	input?: AlchemyPriorStateSecrets,
): string {
	let secrets: CapturedAlchemySecrets | undefined;
	if (input !== undefined) {
		try {
			secrets = captureAlchemySecrets(input);
			if (!verifyAlchemySecrets(secrets)) throw new Error("unverified");
		} catch {
			throw inspectionFailure(
				"PLAN_SECRET_UNVERIFIED",
				"the host secret fingerprint key could not be authenticated",
			);
		}
	}
	return digest(value, undefined, undefined, secrets);
}

export function hashAlchemyPriorState(
	value: unknown,
	input?: AlchemyPriorStateSecrets,
): string {
	return detached(() => hashAlchemyPriorStateInternal(value, input));
}

function digest(
	value: unknown,
	references?: ReadonlyMap<
		object,
		{ resourceId: string; resourceType: string }
	>,
	effects?: AlchemyCompositeEffect[],
	secrets?: CapturedAlchemySecrets,
): string {
	return `sha256:${createHash("sha256")
		.update(
			JSON.stringify(
				encode(
					value,
					new Set(),
					{ remaining: 20_000 },
					0,
					references,
					effects,
					secrets,
				),
			),
		)
		.digest("hex")}`;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/no-reflect-get */

interface InspectedAlchemyPlan {
	digest: string;
	changes: number;
	hasSourceClaims: boolean;
	revalidateSources(): boolean;
}

function secretsFor(
	guard: AlchemyCompositeGuard | undefined,
	target: Target,
	verify: boolean,
): CapturedAlchemySecrets | undefined {
	try {
		if (guard === undefined) return undefined;
		if (isPlanProxy(guard)) throw new Error("invalid secret authority");
		const field = getOwnDescriptor(guard, "secretFingerprint");
		if (field === undefined) return undefined;
		if (!hasOwnDescriptor(field, "value"))
			throw new Error("invalid secret authority");
		if (field.value === undefined) return undefined;
		const context = captureAlchemyPlanSecrets(
			{
				tenantId: target.tenantId,
				targetId: target.targetId,
				stackName: target.stackName,
				stage: target.stage,
			},
			field.value,
		);
		if (verify && !verifyAlchemySecrets(context)) throw new Error("unverified");
		return context;
	} catch {
		throw inspectionFailure(
			"PLAN_SECRET_UNVERIFIED",
			"the host secret fingerprint key could not be authenticated",
		);
	}
}

function inspectUnverified(
	plan: StackPlan,
	target: Target,
	guard?: AlchemyCompositeGuard,
	verifySourceCallbacks = true,
): InspectedAlchemyPlan & {
	effects: AlchemyCompositeEffect[];
	sourceClaims: AlchemySourceClaim[];
	historicalSources: AlchemyHistoricalSource[];
	historicalResources: AlchemyHistoricalResource[];
} {
	const allowEffects = guard !== undefined;
	const requirements =
		guard === undefined
			? undefined
			: captureAlchemySourceRequirements(guard.sourceRequirements);
	if (guard !== undefined && requirements === undefined)
		throw new AlchemyIacError(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"source requirements could not be captured",
		);
	if (plan.stack.name !== target.stackName || plan.stack.stage !== target.stage)
		throw inspectionFailure(
			"TARGET_SCOPE_MISMATCH",
			"plan stack or stage differs from the configured target",
		);
	const secrets = secretsFor(guard, target, verifySourceCallbacks);
	const secretDomains = new NativePlanMap<string, CapturedAlchemySecrets>();
	const secretDomainContexts: CapturedAlchemySecrets[] = [];
	const digestPrior = (
		/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: prior state is provider data and the bounded encoder validates it before hashing. */
		value: unknown,
		resourceId: string,
		resourceType: string,
		domain: "prior-state" | "deletion-properties" = "prior-state",
	) => {
		let context: CapturedAlchemySecrets | undefined;
		if (secrets !== undefined) {
			const key = `${domain.length}:${domain}${resourceId.length}:${resourceId}${resourceType.length}:${resourceType}`;
			context = reflectApply(planMapGet, secretDomains, [key]);
			if (context === undefined) {
				context = secretResourceDomain(
					secrets,
					domain,
					resourceId,
					resourceType,
				);
				if (
					context === undefined ||
					(verifySourceCallbacks && !verifyAlchemySecrets(context))
				)
					throw inspectionFailure(
						"PLAN_SECRET_UNVERIFIED",
						"the host secret fingerprint scope could not be authenticated",
					);
				reflectApply(planMapSet, secretDomains, [key, context]);
				appendOwnData(secretDomainContexts, context);
			}
		}
		return digest(value, undefined, undefined, context);
	};
	if (plan.native.selectedFqns !== undefined)
		throw inspectionFailure(
			"PLAN_UNSUPPORTED_EFFECTS",
			"partial plans cannot be financially covered",
		);
	const actionKeys = [
		...objectKeys(plan.native.actions),
		...objectEntries(plan.native.actionDeletions)
			.filter(([, node]) => node !== undefined)
			.map(([key]) => key),
	];
	if (!allowEffects && (plan.actions.length > 0 || actionKeys.length > 0))
		throw inspectionFailure(
			"PLAN_UNSUPPORTED_EFFECTS",
			"stack actions require host authorization",
		);
	if (
		actionKeys.length !== plan.actions.length ||
		new Set(actionKeys).size !== actionKeys.length ||
		actionKeys.some((key) => !plan.actions.some((row) => row.fqn === key))
	)
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"native plan and action descriptions differ",
		);
	if (
		plan.resources.length + plan.actions.length === 0 ||
		plan.resources.length + plan.actions.length > 256 ||
		plan.resources.length + plan.actions.length !== target.resources.length
	)
		throw inspectionFailure(
			"TARGET_INVENTORY_INCOMPLETE",
			"every planned resource must have one financial scope",
		);
	const rows = [...plan.resources].sort((a, b) =>
		compareCodeUnits(a.fqn, b.fqn),
	);
	const nativeKeys = [
		...objectKeys(plan.native.resources),
		...objectEntries(plan.native.deletions)
			.filter(([, node]) => node !== undefined)
			.map(([key]) => key),
	];
	if (
		nativeKeys.length !== rows.length ||
		new Set(nativeKeys).size !== nativeKeys.length ||
		nativeKeys.some((key) => !rows.some((row) => row.fqn === key))
	)
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"native plan contains resources absent from its description",
		);
	const actionRows = [...plan.actions].sort((a, b) =>
		compareCodeUnits(a.fqn, b.fqn),
	);
	const allNames = [
		...rows.map((row) => row.fqn),
		...actionRows.map((row) => row.fqn),
	];
	if (new Set(allNames).size !== allNames.length)
		throw inspectionFailure(
			"TARGET_INVENTORY_INCOMPLETE",
			"plan contains duplicate resource identifiers",
		);
	const scopes = [...target.resources].sort((a, b) =>
		compareCodeUnits(a.resourceId, b.resourceId),
	);
	if (new Set(scopes.map((scope) => scope.resourceId)).size !== scopes.length)
		throw inspectionFailure(
			"TARGET_INVENTORY_INCOMPLETE",
			"target contains duplicate resource scopes",
		);
	const references = new Map<
		object,
		{ resourceId: string; resourceType: string }
	>();
	const scopeByName = new Map(scopes.map((scope) => [scope.resourceId, scope]));
	const effects: AlchemyCompositeEffect[] = [];
	const sourceClaims: AlchemySourceClaim[] = [];
	const sourceBindings: AlchemySourceBinding[] = [];
	const historicalResources: AlchemyHistoricalResource[] = [];
	const priorStateChecks: Array<() => boolean> = [];
	const historicalStates: {
		resourceId: string;
		resourceType: string;
		state: object;
	}[] = [];
	const actions = actionRows.map((row) => {
		const node =
			plan.native.actions[row.fqn] ?? plan.native.actionDeletions[row.fqn];
		const scope = scopeByName.get(row.fqn);
		if (
			scope === undefined ||
			scope.resourceType !== `alchemy:action:${row.actionType}`
		)
			throw inspectionFailure(
				"TARGET_INVENTORY_INCOMPLETE",
				"every action needs an exact financial scope",
			);
		if (
			node === undefined ||
			node.def.FQN !== row.fqn ||
			node.def.Type !== row.actionType ||
			node.def.LogicalId !== row.logicalId ||
			node.action !== row.action
		)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"plan action description differs from its native action",
			);
		if (
			!safeAlchemyFqn(row.fqn) ||
			(node.state !== undefined && !safeAlchemyState(node.state, row.fqn))
		)
			throw inspectionFailure(
				"STATE_IDENTITY_UNVERIFIED",
				"the action and its persisted state have inconsistent identities",
			);
		const fingerprint = fingerprintFunction(node.def.Run);
		effects.push({ kind: "action", type: node.def.Type, fingerprint });
		references.set(node.def, {
			resourceId: scope.resourceId,
			resourceType: scope.resourceType,
		});
		return {
			row,
			scope: {
				resourceId: scope.resourceId,
				resourceType: scope.resourceType,
				providerId: scope.providerId,
				providerAccountRef: scope.providerAccountRef,
				productId: scope.productId,
			},
			input: "input" in node ? node.input : undefined,
			declaredInput: node.def.Input,
			captures: node.def.Captures,
			state: node.state,
			downstream: node.downstream,
			forced: "forced" in node ? node.forced : undefined,
			runner: fingerprint,
		};
	});
	const resources = rows.map((row) => {
		const scope = scopeByName.get(row.fqn);
		if (
			scope === undefined ||
			scope.resourceId !== row.fqn ||
			scope.resourceType !== row.resourceType
		)
			throw inspectionFailure(
				"TARGET_INVENTORY_INCOMPLETE",
				"plan and target resource scopes do not match",
			);
		const node =
			plan.native.resources[row.fqn] ?? plan.native.deletions[row.fqn];
		if (
			node === undefined ||
			node.resource.FQN !== row.fqn ||
			node.resource.Type !== row.resourceType ||
			node.action !== row.action
		)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"plan description does not match the native plan",
			);
		const stateDescriptor = getOwnDescriptor(node, "state");
		const renameDescriptor = getOwnDescriptor(node, "renamedFrom");
		if (
			stateDescriptor === undefined ||
			!hasOwnDescriptor(stateDescriptor, "value") ||
			(renameDescriptor !== undefined &&
				!hasOwnDescriptor(renameDescriptor, "value"))
		)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"resource state and rename fields must be own data properties",
			);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the checked own data value is validated and canonically hashed before use.
		const previous = stateDescriptor.value as
			| import("alchemy/State").ResourceState
			| undefined;
		const renamedFrom = captureRenamedFrom(renameDescriptor?.value);
		const formerFqns = captureRenamedFrom(node.resource.FormerFqns);
		if (
			!safeAlchemyFqn(row.fqn) ||
			(previous !== undefined && !safeAlchemyState(previous, row.fqn)) ||
			formerFqns === undefined ||
			renamedFrom === undefined
		)
			throw inspectionFailure(
				"STATE_IDENTITY_UNVERIFIED",
				"the resource and its persisted or former state have unsafe identities",
			);
		if (
			![
				"create",
				"update",
				"adopted",
				"replace",
				"noop",
				"delete",
				"orphaned",
			].includes(row.action)
		)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"the resource action is unsupported",
			);
		if (
			row.resourceType === "Rivet.Namespace" &&
			(plan.native.destroy === true ||
				(row.action !== "create" && row.action !== "noop") ||
				(row.action === "create" && previous !== undefined) ||
				renamedFrom.length !== 0 ||
				formerFqns.length !== 0)
		)
			throw inspectionFailure(
				"RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED",
				"Rivet namespaces cannot be deleted; uncertain creation, update, replacement, removal and rename are unsupported",
			);
		if (
			previous === undefined &&
			(node.action !== "create" || renamedFrom.length !== 0)
		)
			throw inspectionFailure(
				"PLAN_UNINSPECTABLE",
				"a historical resource action requires prior state",
			);
		let expectedStateDigest: string | undefined;
		if (previous !== undefined) {
			const properties = getOwnDescriptors(previous);
			const type = hasOwnDescriptor(properties, "resourceType")
				? properties.resourceType
				: undefined;
			const logicalId = hasOwnDescriptor(properties, "logicalId")
				? properties.logicalId
				: undefined;
			const instanceId = hasOwnDescriptor(properties, "instanceId")
				? properties.instanceId
				: undefined;
			const status = hasOwnDescriptor(properties, "status")
				? properties.status
				: undefined;
			if (
				type === undefined ||
				!hasOwnDescriptor(type, "value") ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: provider state is a persisted external boundary. */
				typeof type.value !== "string" ||
				type.value.length === 0 ||
				type.value.length > 200 ||
				type.value.trim() !== type.value ||
				/[\p{Cc}]/u.test(type.value) ||
				(type.value !== row.resourceType &&
					!node.provider.aliases?.includes(type.value)) ||
				logicalId === undefined ||
				!hasOwnDescriptor(logicalId, "value") ||
				logicalId.value !== node.resource.LogicalId ||
				instanceId === undefined ||
				!hasOwnDescriptor(instanceId, "value") ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: provider state is a persisted external boundary. */
				typeof instanceId.value !== "string" ||
				instanceId.value.length === 0 ||
				instanceId.value.length > 200 ||
				instanceId.value.trim() !== instanceId.value ||
				/[\p{Cc}]/u.test(instanceId.value) ||
				status === undefined ||
				!hasOwnDescriptor(status, "value") ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: persisted status is validated before use. */
				typeof status.value !== "string" ||
				![
					"creating",
					"created",
					"updating",
					"updated",
					"deleting",
					"replacing",
					"replaced",
				].includes(status.value)
			)
				throw inspectionFailure(
					"STATE_IDENTITY_UNVERIFIED",
					"the prior resource state has an invalid type, identity, or status",
				);
			if (
				type.value === "Rivet.Namespace" &&
				row.resourceType !== "Rivet.Namespace"
			)
				throw inspectionFailure(
					"RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED",
					"a retained Rivet namespace cannot change resource type",
				);

			const allowedStatuses = {
				create: ["creating"],
				update: ["created", "updated", "updating", "replaced"],
				adopted: ["created", "updated", "updating", "replaced"],
				replace: [
					"creating",
					"created",
					"updating",
					"updated",
					"replacing",
					"replaced",
				],
				noop: ["created", "updated"],
				delete: [
					"creating",
					"created",
					"updating",
					"updated",
					"deleting",
					"replacing",
					"replaced",
				],
				orphaned: [
					"creating",
					"created",
					"updating",
					"updated",
					"deleting",
					"replacing",
					"replaced",
				],
			} satisfies Readonly<Record<string, readonly string[]>>;
			if (!allowedStatuses[row.action]?.includes(status.value))
				throw inspectionFailure(
					"STATE_IDENTITY_UNVERIFIED",
					"the prior state does not match the planned resource action",
				);
			expectedStateDigest = digestPrior(previous, row.fqn, row.resourceType);
			historicalResources.push({
				resourceId: row.fqn,
				resourceType: row.resourceType,
				priorResourceType: type.value,
				action: row.action,
				priorStateDigest: expectedStateDigest,
				renamedFrom,
			});
		}
		const expectedAction = row.action;
		const expectedResourceId = row.fqn;
		const expectedResourceType = row.resourceType;
		const expectedLogicalId = node.resource.LogicalId;
		priorStateChecks.push(() => {
			try {
				const current = getOwnDescriptor(node, "state");
				const rename = getOwnDescriptor(node, "renamedFrom");
				if (
					current === undefined ||
					!hasOwnDescriptor(current, "value") ||
					(rename !== undefined && !hasOwnDescriptor(rename, "value")) ||
					node.action !== expectedAction ||
					row.action !== expectedAction ||
					row.fqn !== expectedResourceId ||
					row.resourceType !== expectedResourceType ||
					node.resource.FQN !== expectedResourceId ||
					node.resource.Type !== expectedResourceType ||
					node.resource.LogicalId !== expectedLogicalId
				)
					return false;
				const currentRename = captureRenamedFrom(rename?.value);
				const currentFormerFqns = captureRenamedFrom(node.resource.FormerFqns);
				if (
					currentFormerFqns === undefined ||
					currentFormerFqns.length !== formerFqns.length ||
					currentFormerFqns.some(
						(value, index) => value !== formerFqns[index],
					) ||
					currentRename === undefined ||
					currentRename.length !== renamedFrom.length ||
					currentRename.some((value, index) => value !== renamedFrom[index])
				)
					return false;
				return expectedStateDigest === undefined
					? current.value === undefined
					: current.value !== undefined &&
							digestPrior(
								current.value,
								expectedResourceId,
								expectedResourceType,
							) === expectedStateDigest;
			} catch {
				return false;
			}
		});
		const source = alchemySourceFor(node.resource);
		const required = sourceRequirementFor(requirements, row.fqn);
		if (source !== undefined) {
			if (guard === undefined)
				throw inspectionFailure(
					"SOURCE_FENCE_REQUIRED",
					"source-backed resources require trusted host authorization",
				);
			const claim = source.claim;
			if (
				claim.resourceId !== row.fqn ||
				claim.resourceType !== row.resourceType ||
				claim.sourceDigest !== target.sourceDigest ||
				claim.environmentDigest !== guard.environmentDigest ||
				claim.proofRef !== guard.proofRef
			)
				throw inspectionFailure(
					"SOURCE_FENCE_MISMATCH",
					"the source fence does not match the financial target and resource",
				);
			if (verifySourceCallbacks) {
				let verified = false;
				try {
					verified = acceptSynchronousTrue(source.verify(claim));
				} catch {
					verified = false;
				}
				if (!verified)
					throw inspectionFailure(
						"SOURCE_FENCE_UNVERIFIED",
						"the host source fence is unavailable or revoked",
					);
			}
			appendOwnData(sourceClaims, claim);
			appendOwnData(sourceBindings, source);
		}
		if (source === undefined && required !== undefined) {
			if (
				guard === undefined ||
				node.action !== "delete" ||
				required.resourceType !== row.resourceType
			)
				throw inspectionFailure(
					"SOURCE_FENCE_INCOMPLETE",
					"an executable resource is missing its registered source claim",
				);
			appendOwnData(
				sourceClaims,
				freezeCaptured({
					...required,
					sourceDigest: target.sourceDigest,
					environmentDigest: guard.environmentDigest,
					proofRef: guard.proofRef,
				}),
			);
		}
		if (
			node.action === "delete" &&
			(source !== undefined || required !== undefined)
		) {
			const state = node.state;
			if (
				state === undefined ||
				state === null ||
				(state.status !== "created" && state.status !== "updated") ||
				state.fqn !== row.fqn ||
				state.resourceType !== row.resourceType ||
				state.logicalId !== node.resource.LogicalId ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: persisted provider state is an external boundary and may be malformed. */
				typeof state.instanceId !== "string" ||
				state.instanceId.length === 0 ||
				state.instanceId.length > 200 ||
				state.instanceId.trim() !== state.instanceId ||
				/[\p{Cc}]/u.test(state.instanceId) ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: persisted provider state is an external boundary and may be malformed. */
				typeof state.props !== "object" ||
				state.props === null ||
				isArray(state.props) ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: persisted provider state is an external boundary and may be malformed. */
				typeof state.attr !== "object" ||
				state.attr === null ||
				isArray(state.attr) ||
				state.propsIncomplete === true
			)
				throw inspectionFailure(
					"SOURCE_FENCE_INCOMPLETE",
					"source deletion requires complete stable prior resource state",
				);
			if (
				digestPrior(
					state.props,
					row.fqn,
					row.resourceType,
					"deletion-properties",
				) !==
				digestPrior(
					node.resource.Props,
					row.fqn,
					row.resourceType,
					"deletion-properties",
				)
			)
				throw inspectionFailure(
					"SOURCE_FENCE_MISMATCH",
					"the deletion resource does not match the authenticated prior properties",
				);
			historicalStates.push({
				resourceId: row.fqn,
				resourceType: row.resourceType,
				state,
			});
		}
		references.set(node.resource, {
			resourceId: scope.resourceId,
			resourceType: scope.resourceType,
		});
		if (node.resource.Type.startsWith("Command.")) {
			if (!allowEffects)
				throw inspectionFailure(
					"PLAN_UNSUPPORTED_EFFECTS",
					"command resources require host authorization",
				);
			effects.push({
				kind: "command",
				type: node.resource.Type,
				fingerprint: digestData({
					resourceId: row.fqn,
					resourceType: row.resourceType,
				}),
			});
		}
		return {
			row,
			scope: {
				resourceId: scope.resourceId,
				resourceType: scope.resourceType,
				providerId: scope.providerId,
				providerAccountRef: scope.providerAccountRef,
				productId: scope.productId,
			},
			props: "props" in node ? node.props : undefined,
			state: node.state,
			bindings: node.bindings,
			downstream: node.downstream,
			mode: node.mode,
			providerVersion: node.provider.version,
			resourceLogicalId: node.resource.LogicalId,
			resourceProps: node.resource.Props,
			removalPolicy: node.resource.RemovalPolicy,
			adopt: node.resource.Adopt,
			resourceMode: node.resource.Mode,
			requiresImplementation: node.resource.RequiresImplementation,
			formerFqns: node.resource.FormerFqns,
			rename: "renamedFrom" in node ? node.renamedFrom : undefined,
			drift: "drift" in node ? node.drift : undefined,
			adopting: "adopting" in node ? node.adopting : undefined,
			deleteFirst: "deleteFirst" in node ? node.deleteFirst : undefined,
			restart: "restart" in node ? node.restart : undefined,
			adoptionBlocked:
				"adoptionBlocked" in node ? node.adoptionBlocked : undefined,
			deferredAdoption:
				"deferredAdoption" in node ? node.deferredAdoption : undefined,
		};
	});
	if (!priorStateChecks.every((check) => check()))
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"prior resource state changed during inspection",
		);
	if (!sourceInventoryMatches(requirements, sourceClaims))
		throw inspectionFailure(
			"SOURCE_FENCE_INCOMPLETE",
			"source claims do not match the complete host inventory",
		);
	const historicalSources = historicalStates.map(
		({ resourceId, resourceType, state }) => ({
			resourceId,
			resourceType,
			priorStateDigest: digestPrior(state, resourceId, resourceType),
		}),
	);
	const material = {
		stack: plan.stack,
		sourceDigest: target.sourceDigest,
		targetId: target.targetId,
		tenantId: target.tenantId,
		programResourceId: target.programResourceId,
		inventoryEvidenceRef: target.inventoryEvidenceRef,
		resources,
		actions,
		sourceClaims,
		historicalSources,
		historicalResources,
		cycles: [...plan.native.cycleMembers].sort(),
		defaultMode: plan.native.defaultMode,
		output: plan.native.output,
		destroy: plan.native.destroy,
	};
	const planDigest = digest(
		material,
		references,
		allowEffects ? effects : undefined,
		secrets,
	);
	const changes =
		rows.filter((row) => row.action !== "noop").length +
		actionRows.filter((row) => row.action !== "noop").length;
	return {
		digest: planDigest,
		changes,
		effects,
		sourceClaims,
		historicalSources,
		historicalResources,
		hasSourceClaims: sourceClaims.length > 0,
		revalidateSources: () => {
			if (secrets !== undefined && !verifyAlchemySecrets(secrets)) return false;
			for (let index = 0; index < secretDomainContexts.length; index++) {
				const context = secretDomainContexts[index];
				if (context === undefined || !verifyAlchemySecrets(context))
					return false;
			}
			for (let index = 0; index < sourceBindings.length; index++) {
				const binding = sourceBindings[index];
				if (binding === undefined) return false;
				try {
					if (!acceptSynchronousTrue(binding.verify(binding.claim)))
						return false;
				} catch {
					return false;
				}
			}
			return true;
		},
	};
}

function validateGuard(guard: AlchemyCompositeGuard): void {
	if (
		!DIGEST.test(guard.environmentDigest) ||
		guard.proofRef.length === 0 ||
		guard.proofRef.length > 200 ||
		guard.proofRef.trim() !== guard.proofRef ||
		/[\p{Cc}]/u.test(guard.proofRef) ||
		captureAlchemySourceRequirements(guard.sourceRequirements) === undefined
	)
		throw inspectionFailure(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"a bounded host proof and immutable environment digest are required",
		);
}

function compositeScope(target: Target): AlchemyCompositeEnvironment["scope"] {
	return Object.freeze(
		target.resources.map((entry) =>
			Object.freeze({
				resourceId: entry.resourceId,
				resourceType: entry.resourceType,
				providerId: entry.providerId,
				providerAccountRef: entry.providerAccountRef,
				productId: entry.productId,
			}),
		),
	);
}

function verifyCompositeEnvironmentInternal(
	guard: AlchemyCompositeGuard,
	target: Target,
	phase: AlchemyCompositeEnvironment["phase"],
	operation: AlchemyCompositeEnvironment["operation"],
): void {
	validateGuard(guard);
	secretsFor(guard, target, true);
	let accepted = false;
	try {
		accepted = acceptSynchronousTrue(
			guard.verifyEnvironment(
				Object.freeze({
					phase,
					operation,
					targetId: target.targetId,
					tenantId: target.tenantId,
					stackName: target.stackName,
					stage: target.stage,
					programResourceId: target.programResourceId,
					sourceDigest: target.sourceDigest,
					environmentDigest: guard.environmentDigest,
					proofRef: guard.proofRef,
					inventoryEvidenceRef: target.inventoryEvidenceRef,
					sourceRequirements: guard.sourceRequirements,
					scope: compositeScope(target),
				}),
			),
		);
	} catch {
		accepted = false;
	}
	if (!accepted)
		throw inspectionFailure(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"the host did not verify the sandbox and scoped credentials",
		);
}

export function verifyCompositeEnvironment(
	guard: AlchemyCompositeGuard,
	target: Target,
	phase: AlchemyCompositeEnvironment["phase"],
	operation: AlchemyCompositeEnvironment["operation"],
): void {
	detached(() =>
		verifyCompositeEnvironmentInternal(guard, target, phase, operation),
	);
}

function authorizedPlanDigest(
	structuralDigest: string,
	guard: AlchemyCompositeGuard,
): string {
	return digestData({
		structuralDigest,
		proofRef: guard.proofRef,
		environmentDigest: guard.environmentDigest,
	});
}

function reinspectAlchemyPlanInternal(
	plan: StackPlan,
	target: Target,
	guard: AlchemyCompositeGuard,
): string {
	validateGuard(guard);
	return authorizedPlanDigest(
		inspectUnverified(plan, target, guard, false).digest,
		guard,
	);
}

function inspectAlchemyPlanInternal(
	plan: StackPlan,
	target: Target,
	guard?: AlchemyCompositeGuard,
): InspectedAlchemyPlan {
	if (guard === undefined)
		throw inspectionFailure(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"host authorization and a complete source inventory are required",
		);
	validateGuard(guard);
	const inspection = inspectUnverified(plan, target, guard);
	const observation: AlchemyCompositeObservation = Object.freeze({
		operation: plan.native.destroy === true ? "destroy" : "deploy",
		targetId: target.targetId,
		tenantId: target.tenantId,
		stackName: target.stackName,
		stage: target.stage,
		programResourceId: target.programResourceId,
		sourceDigest: target.sourceDigest,
		environmentDigest: guard.environmentDigest,
		proofRef: guard.proofRef,
		structuralDigest: inspection.digest,
		inventoryEvidenceRef: target.inventoryEvidenceRef,
		sourceRequirements: guard.sourceRequirements,
		scope: compositeScope(target),
		effects: Object.freeze(
			inspection.effects.map((effect) => Object.freeze({ ...effect })),
		),
		sourceClaims: snapshotSourceClaims(inspection.sourceClaims),
		historicalSources: Object.freeze(
			inspection.historicalSources.map((source) =>
				Object.freeze({ ...source }),
			),
		),
		historicalResources: Object.freeze(
			inspection.historicalResources.map((resource) =>
				Object.freeze({
					...resource,
					renamedFrom: Object.freeze([...resource.renamedFrom]),
				}),
			),
		),
	});
	let accepted = false;
	try {
		accepted = acceptSynchronousTrue(guard.verifyPlan(observation));
	} catch {
		accepted = false;
	}
	if (!accepted)
		throw inspectionFailure(
			"COMPOSITE_PLAN_UNVERIFIED",
			"the host did not authorize the complete effect graph",
		);
	const checked = inspectUnverified(plan, target, guard);
	if (inspection.digest !== checked.digest)
		throw inspectionFailure(
			"PLAN_UNINSPECTABLE",
			"the native plan changed during verification",
		);
	return {
		digest: authorizedPlanDigest(inspection.digest, guard),
		changes: inspection.changes,
		hasSourceClaims: inspection.hasSourceClaims,
		revalidateSources: () => {
			try {
				return (
					inspection.revalidateSources() &&
					acceptSynchronousTrue(guard.verifyPlan(observation))
				);
			} catch {
				return false;
			}
		},
	};
}

export function inspectAlchemyPlan(
	plan: StackPlan,
	target: Target,
	guard?: AlchemyCompositeGuard,
): InspectedAlchemyPlan {
	return detached(() => inspectAlchemyPlanInternal(plan, target, guard));
}

export function reinspectAlchemyPlan(
	plan: StackPlan,
	target: Target,
	guard: AlchemyCompositeGuard,
): string {
	return detached(() => reinspectAlchemyPlanInternal(plan, target, guard));
}

export function captureAlchemyInspection(
	plan: StackPlan,
	target: Target,
	guard: AlchemyCompositeGuard,
) {
	return inspectResult(() => inspectAlchemyPlanInternal(plan, target, guard));
}

export function captureAlchemyReinspection(
	plan: StackPlan,
	target: Target,
	guard: AlchemyCompositeGuard,
) {
	return inspectResult(() => reinspectAlchemyPlanInternal(plan, target, guard));
}
