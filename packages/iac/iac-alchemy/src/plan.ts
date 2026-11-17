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
					encode(source, ancestors, budget, depth + 1, references),
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
					encode(descriptor.value, ancestors, budget, depth + 1, references),
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
				encode(descriptor.value, ancestors, budget, depth + 1, references),
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
): string {
	return `sha256:${createHash("sha256")
		.update(
			JSON.stringify(
				encode(value, new Set(), { remaining: 20_000 }, 0, references),
			),
		)
		.digest("hex")}`;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/no-reflect-get */

interface InspectedAlchemyPlan {
	digest: string;
	changes: number;
}

export function inspectAlchemyPlan(
	plan: StackPlan,
	target: Target,
): InspectedAlchemyPlan {
	if (plan.stack.name !== target.stackName || plan.stack.stage !== target.stage)
		throw new AlchemyIacError(
			"TARGET_SCOPE_MISMATCH",
			"plan stack or stage differs from the configured target",
		);
	if (plan.native.selectedFqns !== undefined || plan.actions.length > 0)
		throw new AlchemyIacError(
			"PLAN_UNSUPPORTED_EFFECTS",
			"partial plans and stack actions cannot be financially covered",
		);
	if (
		plan.resources.length === 0 ||
		plan.resources.length > 256 ||
		plan.resources.length !== target.resources.length
	)
		throw new AlchemyIacError(
			"TARGET_INVENTORY_INCOMPLETE",
			"every planned resource must have one financial scope",
		);
	const rows = [...plan.resources].sort((a, b) => a.fqn.localeCompare(b.fqn));
	if (new Set(rows.map((row) => row.fqn)).size !== rows.length)
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
	const resources = rows.map((row, index) => {
		const scope = scopes[index];
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
			resourceProps: node.resource.Props,
			removalPolicy: node.resource.RemovalPolicy,
			adopt: node.resource.Adopt,
			formerFqns: node.resource.FormerFqns,
			rename: "renamedFrom" in node ? node.renamedFrom : undefined,
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
		resources,
		cycles: [...plan.native.cycleMembers].sort(),
		output: plan.native.output,
		destroy: plan.native.destroy,
	};
	const planDigest = digest(material, references);
	const changes = rows.filter((row) => row.action !== "noop").length;
	return { digest: planDigest, changes };
}
