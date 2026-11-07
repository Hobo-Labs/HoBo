import { createHash } from "node:crypto";
import {
	create,
	fromJson,
	toJson,
	type DescMessage,
	type JsonValue,
	// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Fixed upstream protobuf export; the local alias names its generated record role.
	type MessageShape as MessageRecord,
} from "@bufbuild/protobuf";
import {
	canonicalJson,
	createEffectSpec,
	createResilienceProfile,
	pureEffects,
} from "@hobo/contracts";
import {
	type Budget,
	type CapabilityClass,
	type CapabilityRequirements,
	type Constraints,
	type OwnerRef,
	type ResourceIntent,
	type RoutingCandidate,
	type RoutingPreferences,
	type RoutingSnapshot,
	type MetricContract,
	type MetricVector,
	type PreferenceModel,
	type RoutingDecisionHistory,
	type StabilityPolicy,
	type RoutingScenario,
	ResourceIntentSchema,
	RoutingCandidateSchema,
	MetricContractSchema,
	RoutingScenarioSchema,
	MetricVectorSchema,
	PreferenceModelSchema,
	StabilityPolicySchema,
	DecisionGraphSchema,
	ParetoFrontierSchema,
	RoutingDecisionSchema,
} from "../src/_generated/finops_budget_routing_control_plane_pb.js";
import { isJsonObject, isJsonString } from "../src/json.js";

type ParsedIntent = ResourceIntent & {
	owner: OwnerRef;
	capability: CapabilityClass & {
		requirements: CapabilityRequirements & {
			latencyP95Ms: number;
			minAvailability: number;
		};
	};
	budget: Budget & { amount: number };
	constraints: Constraints & { maxCost: number; minSecurityLevel: number };
	routing: RoutingPreferences;
};
type ParsedCandidate = RoutingCandidate & {
	monthlyCost: number;
	reliability: number;
	latencyP95Ms: number;
	risk: number;
	securityLevel: number;
	transitionCost: number;
	commitmentBound: number;
};
type ParsedSnapshot = RoutingSnapshot & { ledgerSeq: number };
type ParsedScenario = RoutingScenario & {
	intent: ParsedIntent;
	candidates: ParsedCandidate[];
	snapshot: ParsedSnapshot;
	budgetState: NonNullable<RoutingScenario["budgetState"]> & {
		spendToDate: number;
		committedCost: number;
		uncertainCost: number;
		recoveryReserve: number;
	};
	preference: PreferenceModel;
	stability: StabilityPolicy;
};

const SYSTEM = {
	"cost.monthly": {
		unit: "USD",
		source: "focus-ledger",
		normalization: "fixed-usd-10000/v1",
		field: "cost",
	},
	"reliability.uptime": {
		unit: "ratio",
		source: "opentelemetry-slo",
		normalization: "fixed-0-1/v1",
		field: "reliability",
	},
	"latency.p95": {
		unit: "ms",
		source: "opentelemetry-metrics",
		normalization: "fixed-ms-200/v1",
		field: "latency",
	},
	"risk.incident": {
		unit: "ratio",
		source: "incident-system",
		normalization: "fixed-0-1/v1",
		field: "risk",
	},
} as const;
const FORBIDDEN_KEYS = new Set([
	"provider",
	"providerId",
	"cloud",
	"sku",
	"skuId",
	"region",
	"account",
	"accountId",
	"subscriptionId",
	"billingAccountId",
	"backend",
	"backendApi",
	"stack",
]);
const SUPPORTED_TRANSFORMS = new Set(["weighted_sum", "ratio"]);

/** The parser is the only boundary from untrusted JSON into generated records. */
function decode<S extends DescMessage>(
	schema: S,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the untrusted JSON boundary; fromJson below parses the selected generated schema.
	value: unknown,
): MessageRecord<S> {
	// SAFETY: protobuf JSON decoder owns structural validation at this boundary.
	const json = JSON.parse(
		JSON.stringify(value, (key, nested) =>
			key === "$typeName" ? undefined : nested,
		),
	) as JsonValue;
	return fromJson(schema, json);
}

function finite(
	value: number | undefined,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): value is number {
	return (
		value !== undefined &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max
	);
}

function money(value: number | undefined): value is number {
	return (
		finite(value, 0, Number.MAX_SAFE_INTEGER / 1_000_000) &&
		Number.isSafeInteger(Math.round(value * 1_000_000)) &&
		Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 1e-6
	);
}

function moneySum(...amounts: number[]): number {
	const micros = amounts.reduce(
		(sum, amount) => sum + Math.round(amount * 1_000_000),
		0,
	);
	return Number.isSafeInteger(micros)
		? micros / 1_000_000
		: Number.POSITIVE_INFINITY;
}

function nonempty(value: string): boolean {
	return value.trim().length > 0;
}
function instant(value: string): boolean {
	return nonempty(value) && Number.isFinite(Date.parse(value));
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript catch values are untrusted; this boundary normalizes them to a public diagnostic.
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "invalid protobuf JSON";
}
function hash<T>(value: T): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function round(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}
function required<T>(value: T | undefined, label: string): T {
	if (value === undefined)
		throw new Error(`parsed invariant missing: ${label}`);
	return value;
}

/** Content references are computed from the exact parsed catalog/registry. */
export function routingInputHashes(
	candidates: readonly unknown[],
	metrics: readonly unknown[],
) {
	const catalog = candidates
		.map((value) => decode(RoutingCandidateSchema, value))
		.sort((left, right) => left.id.localeCompare(right.id));
	const registry = metrics
		.map((value) => decode(MetricContractSchema, value))
		.sort((left, right) => left.name.localeCompare(right.name));
	return {
		catalogHash: hash(
			catalog.map((value) => toJson(RoutingCandidateSchema, value)),
		),
		metricRegistryHash: hash(
			registry.map((value) => toJson(MetricContractSchema, value)),
		),
	};
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public parser accepts untrusted authoring JSON and refines it through ResourceIntentSchema and relational checks.
export function parseResourceIntent(raw: unknown) {
	const errors: string[] = [];
	inspectProviderLeakage(raw, "intent", errors);
	let intent: ResourceIntent;
	try {
		intent = decode(ResourceIntentSchema, raw);
	} catch (error) {
		return {
			ok: false as const,
			errors: [...errors, errorText(error)],
			intent: null,
		};
	}
	if (intent.schemaVersion !== "hobo.finops.resource-intent/v1")
		errors.push("intent.schemaVersion must be hobo.finops.resource-intent/v1");
	if (
		!intent.owner ||
		![
			intent.owner.tenant,
			intent.owner.workspace,
			intent.owner.environment,
		].every(nonempty)
	)
		errors.push("intent.owner requires tenant, workspace, and environment");
	const requirements = intent.capability?.requirements;
	if (
		!intent.capability ||
		!nonempty(intent.capability.category) ||
		!requirements
	)
		errors.push("intent.capability and requirements are required");
	if (
		!requirements ||
		!finite(requirements.latencyP95Ms, 0) ||
		!finite(requirements.minAvailability, 0, 1) ||
		!nonempty(requirements.compliance)
	)
		errors.push(
			"intent.requirements require finite latency, numeric availability floor, and compliance",
		);
	if (
		requirements?.availability === "high" &&
		(requirements.minAvailability ?? 0) < 0.95
	)
		errors.push("high availability requires minAvailability >= 0.95");
	if (
		!intent.budget ||
		!money(intent.budget.amount) ||
		intent.budget.currency !== "USD"
	)
		errors.push(
			"intent.budget requires a finite nonnegative USD amount with at most six decimals",
		);
	if (!intent.budget || !["monthly", "yearly"].includes(intent.budget.period))
		errors.push("intent.budget.period must be monthly or yearly");
	if (
		!intent.budget ||
		!["notify", "requireApproval"].includes(intent.budget.softLimitBehavior)
	)
		errors.push("unsupported soft budget behavior");
	if (
		!intent.budget ||
		!["deny", "freeze", "suspend"].includes(intent.budget.hardLimitBehavior)
	)
		errors.push("hard budget behavior must deny, freeze, or suspend");
	if (
		!intent.constraints ||
		!money(intent.constraints.maxCost) ||
		!finite(intent.constraints.minSecurityLevel) ||
		intent.constraints.allowedJurisdictions.length === 0
	)
		errors.push(
			"intent.constraints require finite maxCost/security and nonempty allowedJurisdictions",
		);
	if (
		!intent.routing ||
		!["balanced", "cost", "reliability", "performance", "customBlend"].includes(
			intent.routing.objective,
		)
	)
		errors.push("unsupported routing objective");
	// SAFETY: generated records narrow only after all required fields/invariants pass.
	return errors.length > 0
		? { ok: false as const, errors, intent: null }
		: { ok: true as const, errors, intent: intent as ParsedIntent };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public registry parser checks the collection and decodes every generated MetricContract record below.
export function parseMetricContracts(raw: unknown) {
	const errors: string[] = [];
	const contracts: MetricContract[] = [];
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256)
		return {
			ok: false as const,
			errors: [
				"metric contract registry must contain between 1 and 256 records",
			],
			contracts,
		};
	for (const item of raw) {
		try {
			contracts.push(decode(MetricContractSchema, item));
		} catch (error) {
			errors.push(errorText(error));
		}
	}
	const byName = new Map<string, MetricContract>();
	for (const metric of contracts) {
		const prefix = `metric.${metric.name || "unknown"}`;
		if (!nonempty(metric.name) || byName.has(metric.name))
			errors.push(`${prefix}.name must be unique and nonempty`);
		byName.set(metric.name, metric);
		if (!["system", "derived", "user"].includes(metric.tier))
			errors.push(`${prefix}.tier must be system, derived, or user`);
		if (!/^v\d+\.\d+\.\d+$/u.test(metric.version))
			errors.push(`${prefix}.version must be semantic and explicit`);
		if (metric.tier === "system") {
			if (!metric.unit)
				errors.push(`${prefix}.unit is required for system metrics`);
			const expected = Object.entries(SYSTEM).find(
				([name]) => name === metric.name,
			)?.[1];
			if (
				!expected ||
				metric.unit !== expected.unit ||
				metric.source !== expected.source ||
				metric.normalization !== expected.normalization ||
				metric.version !== "v1.0.0" ||
				metric.mutable
			)
				errors.push(
					`${prefix}.semantics must match the immutable versioned system registry`,
				);
		}
		if (metric.tier === "derived") {
			if (metric.dependsOn.length === 0 || metric.transforms.length !== 1)
				errors.push(
					`${prefix}.dependsOn and exactly one supported transform are required`,
				);
			for (const transform of metric.transforms)
				if (!SUPPORTED_TRANSFORMS.has(transform))
					errors.push(
						`${prefix}.transforms contains unapproved transform ${transform}`,
					);
			if (metric.transforms[0] === "ratio" && metric.dependsOn.length !== 2)
				errors.push(`${prefix}.ratio requires exactly two inputs`);
		}
		if (metric.tier === "user") {
			if (
				!metric.requiresApproval ||
				metric.approvalState !== "approved" ||
				!nonempty(metric.approvalRef)
			)
				errors.push(
					`${prefix}.requiresApproval requires an approved, referenced registry entry`,
				);
			if (metric.compositionSources.length === 0)
				errors.push(`${prefix}.compositionSources is required`);
			for (const source of metric.compositionSources)
				if (source.startsWith("raw:") || source.startsWith("otel."))
					errors.push(
						`${prefix}.compositionSources cannot reference raw telemetry ${source}`,
					);
		}
		const dependencies =
			metric.tier === "derived" ? metric.dependsOn : metric.compositionSources;
		if (
			(metric.tier === "derived" && metric.transforms[0] === "weighted_sum") ||
			metric.tier === "user"
		) {
			const weights = Object.entries(metric.weights);
			if (
				weights.length !== dependencies.length ||
				weights.some(
					([name, weight]) =>
						!dependencies.includes(name) || !finite(weight, 0, 1),
				) ||
				Math.abs(weights.reduce((sum, [, weight]) => sum + weight, 0) - 1) >
					1e-9
			)
				errors.push(
					`${prefix}.weights must cover its dependency names and sum to one`,
				);
		}
	}
	for (const name of Object.keys(SYSTEM))
		if (byName.get(name)?.tier !== "system")
			errors.push(`required system metric ${name} is missing`);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	function visit(name: string) {
		if (visited.has(name)) return;
		if (visiting.has(name)) {
			errors.push(`metric dependency cycle at ${name}`);
			return;
		}
		const metric = byName.get(name);
		if (!metric) {
			errors.push(`unknown metric dependency ${name}`);
			return;
		}
		visiting.add(name);
		const dependencies =
			metric.tier === "derived" ? metric.dependsOn : metric.compositionSources;
		for (const dependency of dependencies) {
			const source = byName.get(dependency);
			if (source?.tier === "user")
				errors.push(
					`composition dependency ${dependency} must be system or approved derived`,
				);
			visit(dependency);
		}
		visiting.delete(name);
		visited.add(name);
	}
	for (const metric of contracts) visit(metric.name);
	return errors.length
		? {
				ok: false as const,
				errors: [...new Set(errors)],
				contracts: [],
			}
		: { ok: true as const, errors, contracts };
}

function parseCandidates(
	raw: readonly RoutingCandidate[],
	errors: string[],
): ParsedCandidate[] {
	const candidates: ParsedCandidate[] = [];
	const ids = new Set<string>();
	for (const value of raw) {
		const candidate = decode(RoutingCandidateSchema, value);
		if (!nonempty(candidate.id) || ids.has(candidate.id))
			errors.push("candidate IDs must be unique and nonempty");
		ids.add(candidate.id);
		if (
			!money(candidate.monthlyCost) ||
			!money(candidate.transitionCost) ||
			!money(candidate.commitmentBound) ||
			candidate.commitmentBound <
				moneySum(candidate.monthlyCost ?? 0, candidate.transitionCost ?? 0)
		)
			errors.push(
				`${candidate.id}: finite commitmentBound must cover operating and transition cost`,
			);
		if (
			!finite(candidate.reliability, 0, 1) ||
			!finite(candidate.latencyP95Ms) ||
			!finite(candidate.risk, 0, 1) ||
			!finite(candidate.securityLevel)
		)
			errors.push(
				`${candidate.id}: candidate measurements must be finite and in range`,
			);
		if (
			!nonempty(candidate.capabilityClass) ||
			!nonempty(candidate.jurisdiction) ||
			!["monthly", "yearly"].includes(candidate.period)
		)
			errors.push(
				`${candidate.id}: capability, jurisdiction, and period required`,
			);
		// SAFETY: generated record refinement is consumed only when errors remain empty.
		candidates.push(candidate as ParsedCandidate);
	}
	return candidates;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Scenario authoring enters through RoutingScenarioSchema before the stronger cross-record invariants run.
function parseScenario(raw: unknown) {
	const errors: string[] = [];
	let input: RoutingScenario;
	try {
		input = decode(RoutingScenarioSchema, raw);
	} catch (error) {
		return { ok: false as const, errors: [errorText(error)], input: null };
	}
	const intent = parseResourceIntent(input.intent);
	const metrics = parseMetricContracts(input.metricContracts);
	errors.push(...intent.errors, ...metrics.errors);
	const candidates = parseCandidates(input.candidates, errors);
	if (input.candidates.length > 512 || input.history.length > 2048)
		errors.push(
			"routing proof limits candidates to 512 and history to 2048 records",
		);
	if (!nonempty(input.id)) errors.push("scenario id required");
	const budget = input.budgetState;
	if (
		!budget ||
		![
			budget.spendToDate,
			budget.committedCost,
			budget.uncertainCost,
			budget.recoveryReserve,
		].every((value) => money(value))
	)
		errors.push(
			"finite budget spend, commitments, unresolved exposure, and recovery reserve required",
		);
	const snapshot = input.snapshot;
	if (
		!snapshot ||
		![
			snapshot.catalogHash,
			snapshot.metricRegistryHash,
			snapshot.budgetId,
			snapshot.periodId,
			snapshot.policyRevision,
		].every(nonempty) ||
		!Number.isSafeInteger(snapshot.ledgerSeq) ||
		!instant(snapshot.observedAt)
	)
		errors.push(
			"complete pinned snapshot with safe ledger sequence and evaluation time required",
		);
	if (snapshot && intent.intent) {
		const period =
			intent.intent.budget.period === "monthly"
				? snapshot.observedAt.slice(0, 7)
				: snapshot.observedAt.slice(0, 4);
		if (snapshot.periodId !== period)
			errors.push("snapshot period must contain its evaluation instant");
	}
	if (snapshot) {
		const expectedHashes = routingInputHashes(
			input.candidates,
			input.metricContracts,
		);
		if (
			snapshot.catalogHash !== expectedHashes.catalogHash ||
			snapshot.metricRegistryHash !== expectedHashes.metricRegistryHash
		)
			errors.push(
				"snapshot content hashes do not match the parsed candidate catalog and metric registry",
			);
	}
	const nowMs = Date.parse(snapshot?.observedAt ?? "");
	let previousMs = Number.NEGATIVE_INFINITY;
	for (const history of input.history) {
		const decidedMs = Date.parse(history.decidedAt);
		if (
			!nonempty(history.candidateId) ||
			!instant(history.decidedAt) ||
			decidedMs < previousMs ||
			decidedMs > nowMs
		)
			errors.push(
				"history must be chronological, nonfuture, and identify a placement",
			);
		previousMs = decidedMs;
		if (
			history.challengerSince &&
			(!instant(history.challengerSince) ||
				Date.parse(history.challengerSince) > nowMs ||
				!nonempty(history.challengerCandidateId))
		)
			errors.push("challenger dwell evidence must be pinned and nonfuture");
	}
	const preference =
		input.preference ??
		defaultPreference(input.intent?.routing?.objective ?? "balanced");
	if (input.intent?.routing?.objective === "customBlend" && !input.preference)
		errors.push("customBlend requires an explicit preference model");
	const weights = [
		preference.costWeight,
		preference.reliabilityWeight,
		preference.latencyWeight,
		preference.riskWeight,
		...Object.values(preference.customWeights),
	];
	if (
		preference.normalizationVersion !== "fixed-reference/v1" ||
		weights.some((value) => !finite(value, 0, 1)) ||
		Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-9
	)
		errors.push(
			"preference requires fixed-reference/v1 and finite weights summing to one",
		);
	for (const metric of Object.keys(preference.customWeights))
		if (
			!metrics.contracts.some(
				(item) => item.name === metric && item.tier !== "system",
			)
		)
			errors.push(`preference names unknown custom metric ${metric}`);
	const stability = input.stability ?? defaultStability();
	if (
		![stability.minImprovementThreshold, stability.migrationPenalty].every(
			(value) => finite(value, 0, 1),
		) ||
		![
			stability.cooldownMs,
			stability.flipWindowMs,
			stability.dwellMs,
			stability.flipLimitPerWindow,
		].every(Number.isSafeInteger) ||
		stability.flipLimitPerWindow < 1 ||
		stability.flipWindowMs < 1
	)
		errors.push("invalid stability policy");
	if (errors.length || !intent.ok || !metrics.ok)
		return { ok: false as const, errors, input: null };
	// SAFETY: this boundary alone narrows generated optional records after checks.
	return {
		ok: true as const,
		errors,
		input: {
			...input,
			intent: intent.intent,
			metricContracts: metrics.contracts,
			candidates,
			preference,
			stability,
		} as ParsedScenario,
	};
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public JSON entrypoint immediately delegates to parseScenario; rejected inputs never reach planning.
export function evaluateRoutingScenario(raw: unknown) {
	const parsed = parseScenario(raw);
	if (!parsed.ok)
		return {
			scenarioId:
				isJsonObject(raw) && isJsonString(raw.id) ? raw.id : "invalid",
			status: "rejected",
			parse: { errors: parsed.errors },
		};
	const input = parsed.input;
	const {
		id,
		intent,
		candidates,
		metricContracts,
		history,
		budgetState,
		snapshot,
		preference: model,
		stability: stabilityPolicy,
	} = input;
	const constraints = applyConstraints(intent, candidates);
	const policy = evaluateBudgetPolicy(input, constraints.allowed);
	const eligible = policy.candidatePolicies.filter(
		(item) => item.effect !== "deny",
	);
	const eligibleIds = new Set(eligible.map((item) => item.candidateId));
	const metricVectors = constraints.allowed
		.filter((candidate) => eligibleIds.has(candidate.id))
		.map((candidate) => buildMetricVector(candidate, metricContracts));
	const pareto = buildParetoFrontier(metricVectors);
	const preference = selectFromPareto(pareto, model, intent.routing.objective);
	const stability = applyStability(
		preference,
		metricVectors,
		history,
		stabilityPolicy,
		model,
		snapshot.observedAt,
	);
	const finalId = stability.selectedCandidateId;
	const finalPolicy = policy.candidatePolicies.find(
		(item) => item.candidateId === finalId,
	);
	const eventIds = [
		`evt:${id}:${snapshot.ledgerSeq + 1}`,
		`evt:${id}:${snapshot.ledgerSeq + 2}`,
		`evt:${id}:${snapshot.ledgerSeq + 3}`,
	] as const;
	const graph = {
		...create(DecisionGraphSchema, {
			id: `decision-graph:${id}`,
			generatedCandidateIds: candidates.map((candidate) => candidate.id),
			constraintResults: constraints.results,
			metricVectors,
			paretoFrontier: create(ParetoFrontierSchema, {
				candidateIds: pareto.candidateIds,
				dominatedCandidateIds: pareto.dominatedCandidateIds,
			}),
			finalCandidateId: finalId ?? undefined,
			rationale: [
				"constraint-filter-before-metrics",
				"policy-before-metric-vector",
				"pareto-frontier-before-preference",
				stability.overridden
					? "stability-overrode-preference"
					: "stability-accepted-preference",
			],
			snapshot,
			inputHash: hash(toJson(RoutingScenarioSchema, input)),
		}),
		rejectedCandidateIds: [
			...constraints.rejected.map((item) => item.candidateId),
			...policy.deniedCandidateIds,
		],
		policiesTriggered: policy.candidatePolicies.filter(
			(item) => item.effect !== "allow" || item.obligations.length > 0,
		),
		metricsEvaluated: {
			systemMetrics: metricVectors.length
				? metricContracts
						.filter((metric) => metric.tier === "system")
						.map((metric) => metric.name)
				: [],
			derivedMetrics: metricVectors.length
				? metricContracts
						.filter((metric) => metric.tier === "derived")
						.map((metric) => metric.name)
				: [],
			userMetrics: metricVectors.length
				? metricContracts
						.filter((metric) => metric.tier === "user")
						.map((metric) => metric.name)
				: [],
		},
		metricVersions: Object.fromEntries(
			metricContracts.map((metric) => [metric.name, metric.version]),
		),
		paretoSet: pareto.candidateIds,
		dominatedCandidateIds: pareto.dominatedCandidateIds,
		preferenceChoice: preference.selectedCandidateId,
		stabilityOverride: stability.overridden,
		finalSelection: finalId,
		auditRefs: [
			`budget-ledger:${snapshot.budgetId}:${snapshot.periodId}@seq:${snapshot.ledgerSeq}`,
			`catalog@${snapshot.catalogHash}`,
			`metric-registry@${snapshot.metricRegistryHash}`,
			`cloud-event:routing.Decided`,
			eventIds[1],
		],
	};
	const decision = {
		...create(RoutingDecisionSchema, {
			id: `routing-decision:${id}`,
			effect: finalId ? (finalPolicy?.effect ?? "deny") : "deny",
			selectedCandidateId: finalId ?? undefined,
			decisionGraphId: graph.id,
		}),
		reason: finalId
			? (finalPolicy?.reason ?? "missing-policy")
			: "no-eligible-candidates",
	};
	const actionPlan = compileActionPlan(decision);
	const events = [
		event(eventIds[0], snapshot, 1, "routing.CandidatesGenerated", {
			count: candidates.length,
		}),
		event(eventIds[1], snapshot, 2, "routing.Decided", {
			decisionId: decision.id,
			decisionGraphId: graph.id,
			effect: decision.effect,
			inputHash: graph.inputHash,
		}),
		event(eventIds[2], snapshot, 3, "routing.ActionPlanCompiled", {
			actionPlanId: actionPlan.id,
			backendNeutral: true,
			executionAuthorized: false,
		}),
	];
	return {
		scenarioId: id,
		status: decision.effect,
		parse: {
			intent: { ok: true, errors: [], intent },
			metrics: { ok: true, errors: [], contracts: metricContracts },
		},
		constraints,
		policy,
		metricVectors,
		pareto,
		preference,
		stability,
		decisionGraph: graph,
		routingDecision: decision,
		actionPlan,
		events,
		planningEffects: pureEffects(),
		budgetState,
	};
}

function applyConstraints(
	intent: ParsedIntent,
	candidates: readonly ParsedCandidate[],
) {
	const allowed: ParsedCandidate[] = [];
	const rejected: Array<{ candidateId: string; reasons: string[] }> = [];
	const results = candidates.map((candidate) => {
		const reasons: string[] = [];
		if (candidate.capabilityClass !== intent.capability.category)
			reasons.push("capability-mismatch");
		if (
			moneySum(candidate.monthlyCost, candidate.transitionCost) >
			intent.constraints.maxCost
		)
			reasons.push("max-cost-exceeded");
		if (candidate.latencyP95Ms > intent.capability.requirements.latencyP95Ms)
			reasons.push("latency-limit-exceeded");
		if (candidate.reliability < intent.capability.requirements.minAvailability)
			reasons.push("availability-floor-missing");
		if (
			!candidate.compliance.includes(intent.capability.requirements.compliance)
		)
			reasons.push("compliance-missing");
		if (
			!intent.constraints.allowedJurisdictions.includes(
				candidate.jurisdiction,
			) ||
			intent.constraints.disallowedJurisdictions.includes(
				candidate.jurisdiction,
			)
		)
			reasons.push("jurisdiction-not-allowed");
		if (candidate.securityLevel < intent.constraints.minSecurityLevel)
			reasons.push("security-level-too-low");
		if (!candidate.eligible) reasons.push("cost-routing-ineligible");
		if (candidate.period !== intent.budget.period)
			reasons.push("quote-period-mismatch");
		if (reasons.length) rejected.push({ candidateId: candidate.id, reasons });
		else allowed.push(candidate);
		return { candidateId: candidate.id, passed: reasons.length === 0, reasons };
	});
	return { allowed, rejected, results };
}

function evaluateBudgetPolicy(
	input: ParsedScenario,
	candidates: readonly ParsedCandidate[],
) {
	const state = input.budgetState;
	const committedExposure = moneySum(
		state.spendToDate,
		state.committedCost,
		state.uncertainCost,
		state.recoveryReserve,
	);
	const candidatePolicies = candidates.map((candidate) => {
		const projectedCost = moneySum(
			committedExposure,
			candidate.commitmentBound,
		);
		const effect =
			projectedCost > input.intent.budget.amount
				? "deny"
				: projectedCost > input.intent.budget.amount * 0.8 &&
						input.intent.budget.softLimitBehavior === "requireApproval"
					? "requireApproval"
					: "allow";
		return {
			candidateId: candidate.id,
			effect,
			projectedCost,
			commitmentBound: candidate.commitmentBound,
			reason:
				effect === "deny"
					? "hard-budget-limit"
					: effect === "requireApproval"
						? "soft-budget-threshold"
						: "within-budget",
			obligations:
				effect === "allow" && projectedCost > input.intent.budget.amount * 0.8
					? ["budget-soft-notify"]
					: [],
		};
	});
	return {
		evaluatedAt: input.snapshot.observedAt,
		committedExposure,
		candidatePolicies,
		deniedCandidateIds: candidatePolicies
			.filter((item) => item.effect === "deny")
			.map((item) => item.candidateId),
		approvalCandidateIds: candidatePolicies
			.filter((item) => item.effect === "requireApproval")
			.map((item) => item.candidateId),
	};
}

function buildMetricVector(
	candidate: ParsedCandidate,
	metrics: readonly MetricContract[],
): MetricVector {
	const values = new Map<string, number>([
		[
			"cost.monthly",
			1 /
				(1 +
					moneySum(candidate.monthlyCost, candidate.transitionCost) / 10_000),
		],
		["reliability.uptime", candidate.reliability],
		["latency.p95", 1 / (1 + candidate.latencyP95Ms / 200)],
		["risk.incident", 1 - candidate.risk],
	]);
	const byName = new Map(metrics.map((metric) => [metric.name, metric]));
	function evaluate(name: string): number {
		const known = values.get(name);
		if (known !== undefined) return known;
		const metric = byName.get(name);
		if (!metric) throw new Error(`parsed metric missing: ${name}`);
		const dependencies =
			metric.tier === "derived" ? metric.dependsOn : metric.compositionSources;
		let value: number;
		if (metric.transforms[0] === "ratio") {
			const numerator = evaluate(required(dependencies[0], "ratio numerator"));
			const denominator = evaluate(
				required(dependencies[1], "ratio denominator"),
			);
			value = denominator > 0 ? clamp(numerator / denominator) : 0;
		} else
			value = dependencies.reduce(
				(sum, dependency) =>
					sum +
					evaluate(dependency) *
						required(metric.weights[dependency], "metric weight"),
				0,
			);
		const result = round(value);
		values.set(name, result);
		return result;
	}
	for (const metric of metrics) evaluate(metric.name);
	const customMetrics = Object.fromEntries(
		metrics
			.filter((metric) => metric.tier !== "system")
			.map((metric) => [metric.name, evaluate(metric.name)]),
	);
	return create(MetricVectorSchema, {
		candidateId: candidate.id,
		cost: moneySum(candidate.monthlyCost, candidate.transitionCost),
		reliability: candidate.reliability,
		latency: candidate.latencyP95Ms,
		risk: candidate.risk,
		customMetrics,
		normalizedMetrics: Object.fromEntries(values),
	});
}

function buildParetoFrontier(vectors: readonly MetricVector[]) {
	const dominates = (left: MetricVector, right: MetricVector) => {
		const names = Object.keys(left.normalizedMetrics);
		return (
			names.every(
				(name) =>
					required(left.normalizedMetrics[name], name) >=
					required(right.normalizedMetrics[name], name),
			) &&
			names.some(
				(name) =>
					required(left.normalizedMetrics[name], name) >
					required(right.normalizedMetrics[name], name),
			)
		);
	};
	const dominatedIds = vectors
		.filter((candidate) =>
			vectors.some(
				(other) =>
					candidate.candidateId !== other.candidateId &&
					dominates(other, candidate),
			),
		)
		.map((candidate) => candidate.candidateId)
		.sort();
	return {
		candidateIds: vectors
			.filter((vector) => !dominatedIds.includes(vector.candidateId))
			.map((vector) => vector.candidateId),
		dominatedCandidateIds: dominatedIds,
		vectors,
	};
}

function score(vector: MetricVector, model: PreferenceModel): number {
	const value = (name: string) =>
		required(vector.normalizedMetrics[name], name);
	return round(
		value("cost.monthly") * model.costWeight +
			value("reliability.uptime") * model.reliabilityWeight +
			value("latency.p95") * model.latencyWeight +
			value("risk.incident") * model.riskWeight +
			Object.entries(model.customWeights).reduce(
				(sum, [name, weight]) => sum + value(name) * weight,
				0,
			),
	);
}

function selectFromPareto(
	pareto: ReturnType<typeof buildParetoFrontier>,
	model: PreferenceModel,
	objective: string,
) {
	const scored = pareto.vectors.map((vector) => ({
		candidateId: vector.candidateId,
		score: score(vector, model),
		onFrontier: pareto.candidateIds.includes(vector.candidateId),
	}));
	scored.sort((left, right) => {
		if (objective === "cost") {
			const leftVector = required(
				pareto.vectors.find(
					(vector) => vector.candidateId === left.candidateId,
				),
				"cost candidate",
			);
			const rightVector = required(
				pareto.vectors.find(
					(vector) => vector.candidateId === right.candidateId,
				),
				"cost candidate",
			);
			const delta =
				required(leftVector.cost, "candidate cost") -
				required(rightVector.cost, "candidate cost");
			if (delta !== 0) return delta;
		}
		return (
			right.score - left.score ||
			left.candidateId.localeCompare(right.candidateId)
		);
	});
	const selected = scored.find((candidate) => candidate.onFrontier);
	return {
		model,
		selectedCandidateId: selected?.candidateId ?? null,
		selectedScore: selected?.score ?? 0,
		scored,
		appliedOnlyWithinPareto: true,
	};
}

function applyStability(
	preference: ReturnType<typeof selectFromPareto>,
	vectors: readonly MetricVector[],
	history: readonly RoutingDecisionHistory[],
	policy: StabilityPolicy,
	model: PreferenceModel,
	now: string,
) {
	const previous = history.at(-1);
	const incumbent = vectors.find(
		(vector) => vector.candidateId === previous?.candidateId,
	);
	const nowMs = Date.parse(now);
	const flips = history.filter(
		(entry, index) =>
			index > 0 &&
			entry.candidateId !== history[index - 1]?.candidateId &&
			Date.parse(entry.decidedAt) >= nowMs - policy.flipWindowMs,
	).length;
	const flipsInWindow = Math.max(flips, previous?.flipsInWindow ?? 0);
	const incumbentScore = incumbent ? score(incumbent, model) : 0;
	const netScore = preference.selectedScore - policy.migrationPenalty;
	const improvementRatio =
		incumbentScore > 0
			? round((netScore - incumbentScore) / incumbentScore)
			: 1;
	const reasons: string[] = [];
	if (
		previous &&
		incumbent &&
		previous.candidateId !== preference.selectedCandidateId
	) {
		if (improvementRatio < policy.minImprovementThreshold)
			reasons.push("minimum-net-improvement");
		if (nowMs - Date.parse(previous.decidedAt) < policy.cooldownMs)
			reasons.push("cooldown");
		if (flipsInWindow >= policy.flipLimitPerWindow) reasons.push("flip-limit");
		if (
			policy.dwellMs > 0 &&
			(previous.challengerCandidateId !== preference.selectedCandidateId ||
				!previous.challengerSince ||
				nowMs - Date.parse(previous.challengerSince) < policy.dwellMs)
		)
			reasons.push("dwell-evidence-insufficient");
	}
	const overridden = reasons.length > 0;
	return {
		selectedCandidateId: overridden
			? (previous?.candidateId ?? null)
			: preference.selectedCandidateId,
		overridden,
		reason: overridden
			? "stability-cooldown-or-threshold"
			: previous && !incumbent
				? "incumbent-infeasible-recovery"
				: "stability-allows-change",
		reasons,
		improvementRatio,
		migrationPenalty: policy.migrationPenalty,
		flipsInWindow,
		policy,
	};
}

function compileActionPlan(decision: { id: string; effect: string }) {
	return {
		id: `action-plan:${decision.id}`,
		decisionId: decision.id,
		backendNeutral: true,
		actions: [
			{
				type:
					decision.effect === "deny"
						? "freeze"
						: decision.effect === "requireApproval"
							? "pause"
							: "migrate",
				scope: "resource-intent",
				targetConstraints: [
					"cost-within-budget",
					"availability-floor",
					"latency-within-intent",
				],
			},
		],
		allowedActions: [
			"deploy",
			"destroy",
			"scale",
			"migrate",
			"pause",
			"freeze",
			"upgrade",
		],
		execution: {
			authorized: false,
			requiresReservation: true,
			requiresObservedReadback: true,
			onUnknown: "reconcile",
			effects: createEffectSpec({
				purity: "noRollback",
				capabilities: ["allocates", "suspends"],
				domains: ["network", "iac", "externalCall", "metering"],
			}),
			mutationResilience: createResilienceProfile({
				id: "routing-mutation/v1",
				strategies: [
					{ kind: "timeout", deadlineMs: 30_000 },
					{ kind: "bulkhead", maxConcurrent: 1, maxQueue: 0 },
				],
			}),
			observationResilience: createResilienceProfile({
				id: "routing-observation/v1",
				strategies: [
					{
						kind: "retry",
						seed: decision.id,
						maxAttempts: 3,
						baseDelayMs: 100,
						maxDelayMs: 1_000,
						retryOn: "transient-only",
					},
					{ kind: "timeout", deadlineMs: 5_000 },
				],
			}),
		},
	};
}

function event<T>(
	id: string,
	snapshot: ParsedSnapshot,
	offset: number,
	type: string,
	data: T,
) {
	return {
		id,
		type,
		seq: snapshot.ledgerSeq + offset,
		time: snapshot.observedAt,
		source: "finops-budget-routing-control-plane",
		specversion: "1.0",
		data,
	};
}

function defaultPreference(objective: string): PreferenceModel {
	const weights: readonly [number, number, number, number] =
		objective === "cost"
			? [1, 0, 0, 0]
			: objective === "reliability"
				? [0, 1, 0, 0]
				: objective === "performance"
					? [0, 0, 1, 0]
					: [0.35, 0.35, 0.2, 0.1];
	return create(PreferenceModelSchema, {
		costWeight: weights[0],
		reliabilityWeight: weights[1],
		latencyWeight: weights[2],
		riskWeight: weights[3],
		normalizationVersion: "fixed-reference/v1",
	});
}

function defaultStability(): StabilityPolicy {
	return create(StabilityPolicySchema, {
		minImprovementThreshold: 0.12,
		cooldownMs: 86_400_000,
		migrationPenalty: 0.05,
		flipLimitPerWindow: 2,
		flipWindowMs: 86_400_000,
		dwellMs: 3_600_000,
	});
}

function inspectProviderLeakage(
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Structural authoring-boundary check rejects forbidden provider fields before protobuf decoding.
	value: unknown,
	path: string,
	errors: string[],
) {
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			inspectProviderLeakage(item, `${path}[${index}]`, errors),
		);
		return;
	}
	if (!isJsonObject(value)) return;
	for (const [key, nested] of Object.entries(value)) {
		if (FORBIDDEN_KEYS.has(key))
			errors.push(
				`${path}.${key} is adapter-specific and forbidden in router core inputs`,
			);
		inspectProviderLeakage(nested, `${path}.${key}`, errors);
	}
}
