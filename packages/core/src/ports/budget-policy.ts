import { fromJsonString } from "@bufbuild/protobuf";
import {
	type BudgetPolicyConstraintRecord,
	type BudgetPolicyEvaluationContextRecord,
	type BudgetPolicyEvaluationRecord,
	type BudgetPolicyMeasurementRecord,
	type BudgetPolicyRecord,
	BudgetPolicyRecordSchema,
	type BudgetScopeIdentityRecord,
} from "../_generated/budget_policy_pb.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";

// public-contract: shared authored budget policy discriminator across workload adapters.
export const BUDGET_POLICY_SCHEMA = "hobo.budget-policy/v1";

export type BudgetPolicyConstraint = Readonly<
	Omit<BudgetPolicyConstraintRecord, "$typeName" | "maximum"> & {
		maximum: number;
	}
>;
export type BudgetPolicy = Readonly<
	Omit<
		BudgetPolicyRecord,
		"$typeName" | "workloads" | "constraints" | "limitMicros"
	> & {
		limitMicros: number;
		workloads: readonly string[];
		constraints: readonly BudgetPolicyConstraint[];
	}
>;
export type BudgetScopeIdentity = Readonly<
	Omit<BudgetScopeIdentityRecord, "$typeName">
>;
export type BudgetPolicyEvaluation = Readonly<
	Omit<BudgetPolicyEvaluationRecord, "$typeName">
>;

/** The host supplies measured/projected values, not data from authored intent. */
export type BudgetPolicyEvaluationContext = Readonly<
	Omit<
		BudgetPolicyEvaluationContextRecord,
		"$typeName" | "boundKind" | "phase" | "measurements"
	> & {
		/** Native guarantees must come from the adapter's authenticated evidence port. */
		readonly boundKind: "native" | "conservative";
		readonly phase?: "plan" | "admit";
		readonly measurements: readonly Readonly<
			Omit<BudgetPolicyMeasurementRecord, "$typeName" | "target"> & {
				target?: string;
			}
		>[];
	}
>;

export class BudgetPolicyError extends Error {
	readonly code = "budget.policy.invalid";
}

const IDENTIFIER = /^[^\p{Cc}]{1,200}$/u;
const WORKLOAD = /^[a-z][a-z0-9_.-]{0,79}$/u;
const KEY = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;
const UNIT = /^[A-Za-z][A-Za-z0-9_.:/-]{0,79}$/u;
const FIELDS = new Set([
	"schemaVersion",
	"tenantId",
	"budgetId",
	"periodId",
	"revision",
	"workloads",
	"currency",
	"limitMicros",
	"objective",
	"enforcement",
	"periodKind",
	"periodStartsAtMs",
	"periodEndsAtMs",
	"constraints",
]);
const CONSTRAINT_FIELDS = new Set([
	"key",
	"workload",
	"unit",
	"maximum",
	"target",
]);

function invalid(message: string): never {
	throw new BudgetPolicyError(message);
}
function integer(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}
function quantity(value: JsonValue | undefined, field: string): number {
	if (!isJsonNumber(value) || !integer(value))
		invalid(`${field} must be an explicit nonnegative safe integer`);
	return value;
}
function field(value: JsonValue | undefined, name: string): string {
	if (!isJsonString(value) || !IDENTIFIER.test(value))
		invalid(
			`${name} must be a bounded nonempty identifier without control characters`,
		);
	return value;
}

/** Bounded JSON read which refuses duplicate object keys, including escaped aliases.
 * This also protects an enclosing CI policy before protobuf parsing discards aliases. */
export function parseBudgetPolicyDocumentJson(text: string): JsonValue {
	if (text.length > 262_144) invalid("budget policy document is too large");
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse is the native JSON boundary; the scanner below rejects duplicate keys.
		value = JSON.parse(text) as JsonValue;
	} catch {
		return invalid("budget policy document is not valid JSON");
	}
	let offset = 0;
	const space = () => {
		while (/\s/u.test(text[offset] ?? "") && offset < text.length) offset++;
	};
	function string(): string {
		const start = offset++;
		while (offset < text.length) {
			const char = text[offset++];
			if (char === "\\") offset++;
			else if (char === '"') break;
		}
		const decoded: JsonValue = JSON.parse(text.slice(start, offset));
		if (!isJsonString(decoded))
			return invalid("JSON object key is not a string");
		return decoded;
	}
	function walk(depth: number): void {
		if (depth > 32) invalid("budget policy nesting exceeds 32 levels");
		space();
		const char = text[offset];
		if (char === '"') {
			string();
			return;
		}
		if (char === "{" || char === "[") {
			const object = char === "{";
			const end = object ? "}" : "]";
			const keys = new Set<string>();
			offset++;
			space();
			while (text[offset] !== end) {
				if (object) {
					const name = string();
					if (keys.has(name))
						invalid("duplicate key in budget policy document");
					keys.add(name);
					if (keys.size > 4096) invalid("too many budget policy object fields");
					space();
					offset++;
				}
				walk(depth + 1);
				space();
				if (text[offset] !== ",") break;
				offset++;
				space();
			}
			offset++;
			return;
		}
		while (offset < text.length && !/[\s,}\]]/u.test(text[offset] ?? ""))
			offset++;
	}
	walk(0);
	return value;
}

export function parseBudgetPolicy(value: JsonValue): BudgetPolicy {
	if (!isJsonObject(value)) invalid("budget policy must be an object");
	for (const name of Object.keys(value))
		if (!FIELDS.has(name)) invalid(`unsupported budget policy field ${name}`);
	if (value.schemaVersion !== BUDGET_POLICY_SCHEMA)
		invalid("unsupported budget policy schema");
	for (const name of ["tenantId", "budgetId", "periodId", "revision"])
		field(value[name], name);
	quantity(value.limitMicros, "limitMicros");
	if (value.currency !== "USD")
		invalid("unsupported budget currency; no implicit conversion");
	if (value.objective !== "min-cost" && value.objective !== "maximize-credits")
		invalid("unsupported budget routing objective");
	if (value.enforcement !== "strict" && value.enforcement !== "conservative")
		invalid("budget enforcement must be explicit");
	if (
		!Array.isArray(value.workloads) ||
		value.workloads.length < 1 ||
		value.workloads.length > 32 ||
		value.workloads.some(
			(entry) => !isJsonString(entry) || !WORKLOAD.test(entry),
		) ||
		new Set(value.workloads).size !== value.workloads.length
	)
		invalid("invalid or duplicate budget workloads");
	if (value.periodKind === "fixed-window") {
		const start = quantity(value.periodStartsAtMs, "periodStartsAtMs");
		const end = quantity(value.periodEndsAtMs, "periodEndsAtMs");
		if (end <= start || end > 8_640_000_000_000_000)
			invalid("invalid fixed budget window");
	} else if (
		value.periodKind !== "manual" ||
		value.periodStartsAtMs !== undefined ||
		value.periodEndsAtMs !== undefined
	)
		invalid(
			"manual periods cannot imply a clock reset; fixed windows require explicit bounds",
		);
	const constraints = value.constraints ?? [];
	if (!Array.isArray(constraints) || constraints.length > 128)
		invalid("invalid budget constraints");
	const seen = new Set<string>();
	for (const constraint of constraints) {
		if (!isJsonObject(constraint))
			invalid("budget constraint must be an object");
		if (Object.keys(constraint).some((name) => !CONSTRAINT_FIELDS.has(name)))
			invalid("unsupported budget constraint control");
		const key = field(constraint.key, "constraint key");
		const workload = field(constraint.workload, "constraint workload");
		const unit = field(constraint.unit, "constraint unit");
		if (
			!KEY.test(key) ||
			!UNIT.test(unit) ||
			(workload !== "*" && !value.workloads.includes(workload))
		)
			invalid("invalid constraint namespace or workload");
		quantity(constraint.maximum, "constraint maximum");
		if (
			constraint.target !== undefined &&
			(!isJsonString(constraint.target) ||
				constraint.target.length > 200 ||
				/\p{Cc}/u.test(constraint.target))
		)
			invalid("invalid constraint target");
		const identity = JSON.stringify([workload, key, constraint.target ?? ""]);
		if (seen.has(identity)) invalid("duplicate budget constraint");
		seen.add(identity);
	}
	let record: BudgetPolicyRecord;
	try {
		record = fromJsonString(BudgetPolicyRecordSchema, JSON.stringify(value));
	} catch {
		return invalid("budget policy does not match its generated wire contract");
	}
	const { $typeName: _wire, ...policy } = record;
	if (record.limitMicros === undefined)
		invalid("explicit budget amount required");
	return Object.freeze({
		...policy,
		limitMicros: record.limitMicros,
		workloads: Object.freeze([...record.workloads]),
		constraints: Object.freeze(
			record.constraints.map(({ $typeName: _type, ...constraint }) => {
				if (constraint.maximum === undefined)
					invalid("explicit constraint amount required");
				return Object.freeze({ ...constraint, maximum: constraint.maximum });
			}),
		),
	});
}

export function parseBudgetPolicyJson(text: string): BudgetPolicy {
	return parseBudgetPolicy(parseBudgetPolicyDocumentJson(text));
}

function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isJsonObject(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** Stable, complete content to hash; no policy controls are excluded. */
export function canonicalBudgetPolicyJson(policy: BudgetPolicy): string {
	const parsed = parseBudgetPolicyJson(JSON.stringify(policy));
	const constraints = [...parsed.constraints].sort((left, right) => {
		const a = JSON.stringify([left.workload, left.key, left.target]);
		const b = JSON.stringify([right.workload, right.key, right.target]);
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return canonical(
		parseBudgetPolicyDocumentJson(
			JSON.stringify({
				...parsed,
				workloads: [...parsed.workloads].sort(),
				constraints,
			}),
		),
	);
}

export function budgetScopeIdentityKey(identity: BudgetScopeIdentity): string {
	const values = [
		identity.tenantId,
		identity.budgetId,
		identity.periodId,
		identity.policyRevision,
	];
	if (values.some((value) => !isJsonString(value) || !IDENTIFIER.test(value)))
		invalid("complete budget scope identity required");
	return JSON.stringify(values);
}

export function budgetThresholdSignalKey(
	identity: BudgetScopeIdentity,
	fraction: number,
	transition: "crossed" | "recovered" | "reset",
	cycle: number,
): string {
	if (
		!Number.isFinite(fraction) ||
		fraction <= 0 ||
		fraction > 1 ||
		!Number.isInteger(cycle) ||
		(transition === "reset" ? cycle !== 0 : cycle < 1) ||
		cycle > 4294967295 ||
		!["crossed", "recovered", "reset"].includes(transition)
	)
		invalid("invalid scoped budget threshold signal");
	return `budget:v2:${encodeURIComponent(budgetScopeIdentityKey(identity))}:${fraction}:${transition}:${cycle}`;
}

/** Pure feasibility. An applicable unknown metric fails closed. Planning is not admission. */
export function evaluateBudgetPolicy(
	policy: BudgetPolicy,
	context: BudgetPolicyEvaluationContext,
): BudgetPolicyEvaluation {
	const refuse = (code: string, reason: string): BudgetPolicyEvaluation =>
		Object.freeze({ ok: false, code, reason, requiresNativeBound: false });
	let parsed: BudgetPolicy;
	try {
		parsed = parseBudgetPolicyJson(JSON.stringify(policy));
	} catch {
		return refuse("budget.policy.invalid", "budget policy is invalid");
	}
	if (!parsed.workloads.includes(context.workload))
		return refuse(
			"budget.policy.workload",
			"policy does not apply to this workload",
		);
	if (
		parsed.tenantId !== context.tenantId ||
		parsed.budgetId !== context.budgetId ||
		parsed.periodId !== context.periodId ||
		parsed.revision !== context.policyRevision
	)
		return refuse(
			"budget.policy.scope",
			"financial authority and policy identity differ",
		);
	if (
		!integer(context.nowMs) ||
		!integer(context.costBoundMicros) ||
		!integer(context.exposureMicros)
	)
		return refuse(
			"budget.policy.quantity",
			"trusted quantities must be nonnegative safe integers",
		);
	if (
		context.phase !== undefined &&
		context.phase !== "plan" &&
		context.phase !== "admit"
	)
		return refuse("budget.policy.phase", "unsupported evaluation phase");
	if (context.boundKind !== "native" && context.boundKind !== "conservative")
		return refuse(
			"budget.policy.bound",
			"unsupported financial bound provenance",
		);
	if (
		parsed.periodKind === "fixed-window" &&
		(context.nowMs < (parsed.periodStartsAtMs ?? Infinity) ||
			context.nowMs >= (parsed.periodEndsAtMs ?? -Infinity))
	)
		return refuse("budget.policy.period", "budget window is not active");
	const requiresNativeBound =
		parsed.enforcement === "strict" && context.boundKind !== "native";
	if (requiresNativeBound && context.phase !== "plan")
		return refuse(
			"budget.policy.native-bound",
			"strict admission requires an authenticated provider-enforced bound",
		);
	const projected =
		BigInt(context.exposureMicros) + BigInt(context.costBoundMicros);
	if (projected > BigInt(parsed.limitMicros))
		return refuse(
			"budget.policy.exhausted",
			"projected commitments exceed the budget",
		);
	const measurements = new Map<string, { unit: string; value: number }>();
	for (const measurement of context.measurements) {
		const key = JSON.stringify([measurement.key, measurement.target ?? ""]);
		if (measurements.has(key) || !integer(measurement.value))
			return refuse(
				"budget.policy.measurement",
				"duplicate or invalid trusted measurement",
			);
		measurements.set(key, measurement);
	}
	const workCost = measurements.get(JSON.stringify(["work.cost", ""]));
	if (
		workCost &&
		(workCost.unit !== "USD.micros" ||
			workCost.value !== context.costBoundMicros)
	)
		return refuse(
			"budget.policy.measurement",
			"work cost must equal the complete financial bound",
		);
	measurements.set(JSON.stringify(["work.cost", ""]), {
		unit: "USD.micros",
		value: context.costBoundMicros,
	});
	if (parsed.periodKind === "fixed-window") {
		const duration = measurements.get(JSON.stringify(["work.duration", ""]));
		if (duration?.unit !== "ms")
			return refuse(
				"budget.policy.unsupported-constraint",
				"fixed-window admission requires a bounded work duration",
			);
		if (
			BigInt(context.nowMs) + BigInt(duration.value) >
			BigInt(parsed.periodEndsAtMs ?? 0)
		)
			return refuse(
				"budget.policy.period",
				"work crosses an unfunded budget boundary",
			);
	}
	for (const constraint of parsed.constraints) {
		if (constraint.workload !== "*" && constraint.workload !== context.workload)
			continue;
		const measurement = measurements.get(
			JSON.stringify([constraint.key, constraint.target]),
		);
		if (!measurement || measurement.unit !== constraint.unit)
			return refuse(
				"budget.policy.unsupported-constraint",
				`required metric is unavailable: ${constraint.key}`,
			);
		if (measurement.value > constraint.maximum)
			return refuse(
				"budget.policy.constraint",
				`projected metric exceeds its ceiling: ${constraint.key}`,
			);
	}
	return Object.freeze({
		ok: true,
		code: "budget.policy.feasible",
		reason: requiresNativeBound
			? "plan is feasible; native proof is required before admission"
			: "projected commitments satisfy the policy",
		projectedMicros: Number(projected),
		remainingMicros: parsed.limitMicros - Number(projected),
		requiresNativeBound,
	});
}
