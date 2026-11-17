import { createHash } from "node:crypto";
import type { StackPlan } from "alchemy/Alchemist";
import * as Output from "alchemy/Output";
import type { Target } from "./_generated/alchemy_iac_pb.js";
import type { FinancialDecision } from "./port.js";
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
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_EFFECTS = 1024;

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
			code === "ADMISSION_OUTCOME_UNKNOWN" ||
			code === "ADMISSION_RECEIPT_INVALID" ||
			code === "EXECUTION_IN_PROGRESS" ||
			code === "EXECUTION_OUTCOME_UNRESOLVED" ||
			code === "EXECUTION_ALREADY_CLAIMED" ||
			admission?.status === "uncertain" ||
			admission?.status === "replay" ||
			admission?.budget?.reservation === "held" ||
			admission?.budget?.reservation === "uncertain";
		this.executionOutcome =
			code === "APPLY_OUTPUT_UNREPRESENTABLE"
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
}

function inspectUnverified(
	plan: StackPlan,
	target: Target,
	allowEffects: boolean,
): InspectedAlchemyPlan & { effects: AlchemyCompositeEffect[] } {
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
		if (
			!safeAlchemyFqn(row.fqn) ||
			(node.state !== undefined && !safeAlchemyState(node.state, row.fqn)) ||
			node.resource.FormerFqns?.some(
				(former: string) => !safeAlchemyFqn(former),
			) ||
			("renamedFrom" in node &&
				node.renamedFrom?.some((former: string) => !safeAlchemyFqn(former)))
		)
			throw new AlchemyIacError(
				"STATE_IDENTITY_UNVERIFIED",
				"the resource and its persisted or former state have unsafe identities",
			);
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
	const material = {
		stack: plan.stack,
		sourceDigest: target.sourceDigest,
		targetId: target.targetId,
		tenantId: target.tenantId,
		programResourceId: target.programResourceId,
		inventoryEvidenceRef: target.inventoryEvidenceRef,
		resources,
		actions,
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
	return { digest: planDigest, changes, effects };
}

function validateGuard(guard: AlchemyCompositeGuard): void {
	if (
		!DIGEST.test(guard.environmentDigest) ||
		guard.proofRef.length === 0 ||
		guard.proofRef.length > 200 ||
		guard.proofRef.trim() !== guard.proofRef ||
		/[\p{Cc}]/u.test(guard.proofRef)
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

export function inspectAlchemyPlan(
	plan: StackPlan,
	target: Target,
	guard?: AlchemyCompositeGuard,
): InspectedAlchemyPlan {
	const inspection = inspectUnverified(plan, target, guard !== undefined);
	if (inspection.effects.length === 0) return inspection;
	if (guard === undefined)
		throw new AlchemyIacError(
			"PLAN_UNSUPPORTED_EFFECTS",
			"host authorization is required for executable effects",
		);
	validateGuard(guard);
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
		scope: compositeScope(target),
		effects: Object.freeze(
			inspection.effects.map((effect) => Object.freeze({ ...effect })),
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
	const checked = inspectUnverified(plan, target, true);
	if (inspection.digest !== checked.digest)
		throw new AlchemyIacError(
			"PLAN_UNINSPECTABLE",
			"the native plan changed during verification",
		);
	return {
		digest: digestData({
			structuralDigest: inspection.digest,
			proofRef: guard.proofRef,
			environmentDigest: guard.environmentDigest,
		}),
		changes: inspection.changes,
	};
}
