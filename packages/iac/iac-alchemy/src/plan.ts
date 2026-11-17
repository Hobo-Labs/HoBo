import { createHash } from "node:crypto";
import type { StackPlan } from "alchemy/Alchemist";
import * as Output from "alchemy/Output";
import type { Target } from "./_generated/alchemy_iac_pb.js";
import type { FinancialDecision } from "./port.js";
import {
	type AlchemySourceBinding,
	type AlchemySourceClaim,
	type AlchemySourceRequirement,
	alchemySourceFor,
	captureAlchemySourceRequirements,
} from "./source-fence.js";
import { safeAlchemyFqn, safeAlchemyState } from "./state-identity.js";

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** A host-owned verifier must authenticate the sandbox, credentials, and complete effect scope. */
export interface AlchemyCompositeGuard {
	readonly proofRef: string;
	readonly environmentDigest: string;
	readonly verifyEnvironment: (input: AlchemyCompositeEnvironment) => boolean;
	readonly verifyPlan: (input: AlchemyCompositeObservation) => boolean;
	/** Complete host-authenticated executable-source inventory; empty must be explicit. */
	readonly sourceRequirements: readonly AlchemySourceRequirement[];
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
	/** Exact plan state for every prior resource; this may include a provider-adopted state. */
	readonly historicalResources: readonly AlchemyHistoricalResource[];
}

export interface AlchemyHistoricalSource {
	readonly resourceId: string;
	readonly resourceType: string;
	readonly priorStateDigest: string;
}

/** Prior plan state for independent authorization of physical-resource effects. */
export interface AlchemyHistoricalResource {
	readonly resourceId: string;
	readonly resourceType: string;
	/** The persisted type, which can differ only for a provider-declared alias. */
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
	/** Former state keys Alchemy will migrate into this plan node. */
	readonly renamedFrom: readonly string[];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_EFFECTS = 1024;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: native rename lists are inspected as bounded external data. */
function captureRenamedFrom(value: unknown): readonly string[] | undefined {
	if (value === undefined) return Object.freeze([]);
	if (
		!Array.isArray(value) ||
		value.length > 256 ||
		Object.getOwnPropertySymbols(value).length !== 0
	)
		return undefined;
	const properties = Object.getOwnPropertyDescriptors(value);
	if (Object.keys(properties).length !== value.length + 1) return undefined;
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = properties[String(index)];
		if (
			item === undefined ||
			!("value" in item) ||
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
	const source = Function.prototype.toString.call(value);
	if (source.length > 65_536 || source.includes("[native code]"))
		throw new AlchemyIacError(
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

// Tagged encoding avoids collisions between absent values and user data.
// Exotic objects, accessors, cycles and oversized inputs cannot be pinned.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/no-reflect-get -- SAFETY: this is the Alchemy plan input boundary; it inspects untrusted values and Alchemy's symbol-based output proxy before producing bounded canonical data. */
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
): JsonValue {
	if (--budget.remaining < 0 || depth > 32)
		throw new AlchemyIacError(
			"PLAN_UNINSPECTABLE",
			"plan exceeds the fingerprint limits",
		);
	if (value === undefined) return ["undefined"];
	if (value === null) return ["null"];
	if (typeof value === "boolean") return ["boolean", value];
	if (typeof value === "string") {
		if (value.length > 4096)
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"plan string exceeds the fingerprint limit",
			);
		return ["string", value];
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new AlchemyIacError(
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
		Output.isOutput(value)
	) {
		if (ancestors.has(value))
			throw new AlchemyIacError("PLAN_UNINSPECTABLE", "plan contains a cycle");
		ancestors.add(value);
		try {
			const expression: unknown = Reflect.get(value, Output.ExprSymbol);
			if (typeof expression !== "object" || expression === null)
				throw new AlchemyIacError(
					"PLAN_UNINSPECTABLE",
					"invalid output expression",
				);
			const prototype = Object.getPrototypeOf(expression);
			const data = (key: string): unknown => {
				const descriptor = Object.getOwnPropertyDescriptor(expression, key);
				if (descriptor === undefined || !("value" in descriptor))
					throw new AlchemyIacError(
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
					!Output.isOutput(source)
				)
					throw new AlchemyIacError(
						"PLAN_UNINSPECTABLE",
						"invalid output property",
					);
				return [
					"alchemy-property",
					identifier,
					encode(source, ancestors, budget, depth + 1, references, effects),
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
					),
				];
			if (
				prototype === Output.NamedExpr.prototype &&
				data("kind") === "NamedExpr"
			) {
				const bindingName = data("bindingName");
				if (typeof bindingName !== "string" || bindingName.length > 200)
					throw new AlchemyIacError(
						"PLAN_UNINSPECTABLE",
						"invalid output name",
					);
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
					throw new AlchemyIacError(
						"PLAN_UNSUPPORTED_EFFECTS",
						"executable outputs require host authorization",
					);
				const callback = data("f");
				if (typeof callback !== "function")
					throw new AlchemyIacError(
						"PLAN_UNINSPECTABLE",
						"invalid output callback",
					);
				// SAFETY: the runtime guard established that this value is callable; fingerprinting never invokes it.
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
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"output expression is not a scoped resource property",
			);
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object")
		throw new AlchemyIacError(
			"PLAN_UNINSPECTABLE",
			"plan contains an unsupported value",
		);
	if (ancestors.has(value))
		throw new AlchemyIacError("PLAN_UNINSPECTABLE", "plan contains a cycle");
	ancestors.add(value);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length > 0)
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"plan contains symbol properties",
			);
		if (Array.isArray(value)) {
			if (
				value.length > 1024 ||
				Object.keys(descriptors).some(
					(key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key),
				)
			)
				throw new AlchemyIacError(
					"PLAN_UNINSPECTABLE",
					"plan array is not bounded data",
				);
			const items: JsonValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = descriptors[String(index)];
				if (descriptor === undefined || !("value" in descriptor))
					throw new AlchemyIacError(
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
					),
				);
			}
			return ["array", items];
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"plan contains non-data objects or unresolved references",
			);
		const pairs: JsonValue[] = [];
		for (const key of Object.keys(descriptors).sort()) {
			const descriptor = descriptors[key];
			if (
				descriptor === undefined ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				key.length > 200
			)
				throw new AlchemyIacError(
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
				),
			]);
		}
		return ["object", pairs];
	} finally {
		ancestors.delete(value);
	}
}

export function digestData(value: unknown): string {
	return digest(value);
}

/** Hash independently authenticated, inspectable prior resource state. */
export function hashAlchemyPriorState(value: unknown): string {
	return digestData(value);
}

function digest(
	value: unknown,
	references?: ReadonlyMap<
		object,
		{ resourceId: string; resourceType: string }
	>,
	effects?: AlchemyCompositeEffect[],
): string {
	return `sha256:${createHash("sha256")
		.update(
			JSON.stringify(
				encode(value, new Set(), { remaining: 20_000 }, 0, references, effects),
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
	if (plan.stack.name !== target.stackName || plan.stack.stage !== target.stage)
		throw new AlchemyIacError(
			"TARGET_SCOPE_MISMATCH",
			"plan stack or stage differs from the configured target",
		);
	if (plan.native.selectedFqns !== undefined)
		throw new AlchemyIacError(
			"PLAN_UNSUPPORTED_EFFECTS",
			"partial plans cannot be financially covered",
		);
	const actionKeys = [
		...Object.keys(plan.native.actions),
		...Object.entries(plan.native.actionDeletions)
			.filter(([, node]) => node !== undefined)
			.map(([key]) => key),
	];
	if (!allowEffects && (plan.actions.length > 0 || actionKeys.length > 0))
		throw new AlchemyIacError(
			"PLAN_UNSUPPORTED_EFFECTS",
			"stack actions require host authorization",
		);
	if (
		actionKeys.length !== plan.actions.length ||
		new Set(actionKeys).size !== actionKeys.length ||
		actionKeys.some((key) => !plan.actions.some((row) => row.fqn === key))
	)
		throw new AlchemyIacError(
			"PLAN_UNINSPECTABLE",
			"native plan and action descriptions differ",
		);
	if (
		plan.resources.length + plan.actions.length === 0 ||
		plan.resources.length + plan.actions.length > 256 ||
		plan.resources.length + plan.actions.length !== target.resources.length
	)
		throw new AlchemyIacError(
			"TARGET_INVENTORY_INCOMPLETE",
			"every planned resource must have one financial scope",
		);
	const rows = [...plan.resources].sort((a, b) => a.fqn.localeCompare(b.fqn));
	const nativeKeys = [
		...Object.keys(plan.native.resources),
		...Object.entries(plan.native.deletions)
			.filter(([, node]) => node !== undefined)
			.map(([key]) => key),
	];
	if (
		nativeKeys.length !== rows.length ||
		new Set(nativeKeys).size !== nativeKeys.length ||
		nativeKeys.some((key) => !rows.some((row) => row.fqn === key))
	)
		throw new AlchemyIacError(
			"PLAN_UNINSPECTABLE",
			"native plan contains resources absent from its description",
		);
	const actionRows = [...plan.actions].sort((a, b) =>
		a.fqn.localeCompare(b.fqn),
	);
	const allNames = [
		...rows.map((row) => row.fqn),
		...actionRows.map((row) => row.fqn),
	];
	if (new Set(allNames).size !== allNames.length)
		throw new AlchemyIacError(
			"TARGET_INVENTORY_INCOMPLETE",
			"plan contains duplicate resource identifiers",
		);
	const scopes = [...target.resources].sort((a, b) =>
		a.resourceId.localeCompare(b.resourceId),
	);
	if (new Set(scopes.map((scope) => scope.resourceId)).size !== scopes.length)
		throw new AlchemyIacError(
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
			throw new AlchemyIacError(
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
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"plan action description differs from its native action",
			);
		if (
			!safeAlchemyFqn(row.fqn) ||
			(node.state !== undefined && !safeAlchemyState(node.state, row.fqn))
		)
			throw new AlchemyIacError(
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
			throw new AlchemyIacError(
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
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"plan description does not match the native plan",
			);
		const stateDescriptor = Object.getOwnPropertyDescriptor(node, "state");
		const renameDescriptor = Object.getOwnPropertyDescriptor(
			node,
			"renamedFrom",
		);
		if (
			stateDescriptor === undefined ||
			!("value" in stateDescriptor) ||
			(renameDescriptor !== undefined && !("value" in renameDescriptor))
		)
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"resource state and rename fields must be own data properties",
			);
		// SAFETY: the checked own data value is validated and canonically hashed before use.
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
			throw new AlchemyIacError(
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
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"the resource action is unsupported",
			);
		if (
			previous === undefined &&
			(node.action !== "create" || renamedFrom.length !== 0)
		)
			throw new AlchemyIacError(
				"PLAN_UNINSPECTABLE",
				"a historical resource action requires prior state",
			);
		let expectedStateDigest: string | undefined;
		if (previous !== undefined) {
			const properties = Object.getOwnPropertyDescriptors(previous);
			const type = properties.resourceType;
			const logicalId = properties.logicalId;
			const instanceId = properties.instanceId;
			const status = properties.status;
			if (
				type === undefined ||
				!("value" in type) ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: provider state is a persisted external boundary. */
				typeof type.value !== "string" ||
				type.value.length === 0 ||
				type.value.length > 200 ||
				type.value.trim() !== type.value ||
				/[\p{Cc}]/u.test(type.value) ||
				(type.value !== row.resourceType &&
					!node.provider.aliases?.includes(type.value)) ||
				logicalId === undefined ||
				!("value" in logicalId) ||
				logicalId.value !== node.resource.LogicalId ||
				instanceId === undefined ||
				!("value" in instanceId) ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: provider state is a persisted external boundary. */
				typeof instanceId.value !== "string" ||
				instanceId.value.length === 0 ||
				instanceId.value.length > 200 ||
				instanceId.value.trim() !== instanceId.value ||
				/[\p{Cc}]/u.test(instanceId.value) ||
				status === undefined ||
				!("value" in status) ||
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
				throw new AlchemyIacError(
					"STATE_IDENTITY_UNVERIFIED",
					"the prior resource state has an invalid type, identity, or status",
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
				throw new AlchemyIacError(
					"STATE_IDENTITY_UNVERIFIED",
					"the prior state does not match the planned resource action",
				);
			expectedStateDigest = hashAlchemyPriorState(previous);
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
				const current = Object.getOwnPropertyDescriptor(node, "state");
				const rename = Object.getOwnPropertyDescriptor(node, "renamedFrom");
				if (
					current === undefined ||
					!("value" in current) ||
					(rename !== undefined && !("value" in rename)) ||
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
							hashAlchemyPriorState(current.value) === expectedStateDigest;
			} catch {
				return false;
			}
		});
		const source = alchemySourceFor(node.resource);
		const required = guard?.sourceRequirements?.find(
			(entry) => entry.resourceId === row.fqn,
		);
		if (source !== undefined) {
			if (guard === undefined)
				throw new AlchemyIacError(
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
				throw new AlchemyIacError(
					"SOURCE_FENCE_MISMATCH",
					"the source fence does not match the financial target and resource",
				);
			if (verifySourceCallbacks) {
				let verified = false;
				try {
					verified = source.verify(claim) === true;
				} catch {
					/* host refusal */
				}
				if (!verified)
					throw new AlchemyIacError(
						"SOURCE_FENCE_UNVERIFIED",
						"the host source fence is unavailable or revoked",
					);
			}
			sourceClaims.push(claim);
			sourceBindings.push(source);
		}
		if (source === undefined && required !== undefined) {
			if (
				guard === undefined ||
				node.action !== "delete" ||
				required.resourceType !== row.resourceType
			)
				throw new AlchemyIacError(
					"SOURCE_FENCE_INCOMPLETE",
					"an executable resource is missing its registered source claim",
				);
			sourceClaims.push(
				Object.freeze({
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
				Array.isArray(state.props) ||
				/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: persisted provider state is an external boundary and may be malformed. */
				typeof state.attr !== "object" ||
				state.attr === null ||
				Array.isArray(state.attr) ||
				state.propsIncomplete === true
			)
				throw new AlchemyIacError(
					"SOURCE_FENCE_INCOMPLETE",
					"source deletion requires complete stable prior resource state",
				);
			if (
				hashAlchemyPriorState(state.props) !==
				hashAlchemyPriorState(node.resource.Props)
			)
				throw new AlchemyIacError(
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
				throw new AlchemyIacError(
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
		throw new AlchemyIacError(
			"PLAN_UNINSPECTABLE",
			"prior resource state changed during inspection",
		);
	const requirements = guard?.sourceRequirements;
	if (
		(sourceClaims.length > 0 && requirements === undefined) ||
		(requirements !== undefined &&
			(requirements.length !== sourceClaims.length ||
				requirements.some(
					(required) =>
						!sourceClaims.some(
							(claim) =>
								claim.resourceId === required.resourceId &&
								claim.resourceType === required.resourceType &&
								claim.bindleName === required.bindleName &&
								claim.applicationName === required.applicationName &&
								claim.sourceKind === required.sourceKind &&
								claim.sourcePath === required.sourcePath,
						),
				)))
	)
		throw new AlchemyIacError(
			"SOURCE_FENCE_INCOMPLETE",
			"source claims do not match the complete host inventory",
		);
	const historicalSources = historicalStates.map(
		({ resourceId, resourceType, state }) => ({
			resourceId,
			resourceType,
			priorStateDigest: hashAlchemyPriorState(state),
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
		revalidateSources: () =>
			sourceBindings.every((binding) => {
				try {
					return binding.verify(binding.claim) === true;
				} catch {
					return false;
				}
			}),
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
		throw new AlchemyIacError(
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

export function verifyCompositeEnvironment(
	guard: AlchemyCompositeGuard,
	target: Target,
	phase: AlchemyCompositeEnvironment["phase"],
	operation: AlchemyCompositeEnvironment["operation"],
): void {
	validateGuard(guard);
	let accepted = false;
	try {
		accepted =
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
			) === true;
	} catch {
		/* verifier failure is a refusal */
	}
	if (!accepted)
		throw new AlchemyIacError(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			"the host did not verify the sandbox and scoped credentials",
		);
}

/** Bind a structural plan fingerprint to the captured host authority. */
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

/**
 * Final synchronous reinspection after the last asynchronous state scan.
 * This intentionally invokes no host or source verifier: those authorities
 * must keep their previously verified fences effective through provider start.
 */
export function reinspectAlchemyPlan(
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

export function inspectAlchemyPlan(
	plan: StackPlan,
	target: Target,
	guard?: AlchemyCompositeGuard,
): InspectedAlchemyPlan {
	if (guard === undefined)
		throw new AlchemyIacError(
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
		sourceClaims: Object.freeze(
			inspection.sourceClaims.map((claim) => Object.freeze({ ...claim })),
		),
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
		accepted = guard.verifyPlan(observation) === true;
	} catch {
		/* verifier failure is a refusal */
	}
	if (!accepted)
		throw new AlchemyIacError(
			"COMPOSITE_PLAN_UNVERIFIED",
			"the host did not authorize the complete effect graph",
		);
	const checked = inspectUnverified(plan, target, guard);
	if (inspection.digest !== checked.digest)
		throw new AlchemyIacError(
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
					guard.verifyPlan(observation) === true
				);
			} catch {
				return false;
			}
		},
	};
}
