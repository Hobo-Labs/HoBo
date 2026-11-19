import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	AvailabilityViewRequestSchema,
	type AvailabilityBreakdown as BreakdownWire,
	type AvailabilityDeployAssessment as DeployAssessmentWire,
	type AvailabilityGraph as GraphWire,
	type AvailabilityIssue as IssueWire,
	type AvailabilityNodeEstimate as NodeEstimateWire,
	type AvailabilityNode as NodeWire,
	type AvailabilityViewRequest as RequestWire,
	type AvailabilitySummary as SummaryWire,
	type AvailabilityView as ViewWire,
	type AvailabilityWarning as WarningWire,
} from "./_generated/availability_view_pb.js";
import { isJsonString } from "./json.js";

export const AVAILABILITY_VIEW_VERSION = "hobo.availability-view/v1";
const DEFAULT_UNRATED_AVAILABILITY = 0.95;
const DEFAULT_DIVERGENCE_THRESHOLD = 0.02;
const MINUTES_PER_YEAR = 365 * 24 * 60;
const MAX_DECISIONS = 100_000;

export type AvailabilityNode = Readonly<
	Omit<
		NodeWire,
		"$typeName" | "dependsOn" | "members" | "sharedDependencies"
	> & {
		dependsOn?: readonly string[];
		members?: readonly string[];
		sharedDependencies?: readonly string[];
	}
>;
export type AvailabilityGraph = Readonly<
	Omit<GraphWire, "$typeName" | "nodes"> & {
		nodes: Readonly<Record<string, AvailabilityNode>>;
	}
>;
export type AvailabilityViewRequest = Readonly<
	Omit<
		RequestWire,
		"$typeName" | "graph" | "observedAvailability" | "availabilitySlo"
	> & {
		graph: AvailabilityGraph;
		observedAvailability?: number | null;
		availabilitySlo?: number | null;
	}
>;
export type AvailabilityWarning = Readonly<
	Omit<WarningWire, "$typeName" | "sharedDependencies"> & {
		sharedDependencies?: readonly string[];
	}
>;
export type AvailabilityIssue = Readonly<Omit<IssueWire, "$typeName">>;
export type AvailabilityNodeEstimate = Readonly<
	Omit<NodeEstimateWire, "$typeName">
>;
export type AvailabilityBreakdown = Readonly<
	Omit<BreakdownWire, "$typeName" | "byNode" | "countedNodes"> & {
		byNode: Readonly<Record<string, AvailabilityNodeEstimate>>;
		countedNodes: readonly string[];
	}
>;
export type AvailabilitySummary = Readonly<Omit<SummaryWire, "$typeName">>;
export type AvailabilityDeployAssessment = Readonly<
	Omit<DeployAssessmentWire, "$typeName" | "effect" | "warnings"> & {
		effect: "allow" | "warn";
		warnings: readonly AvailabilityWarning[];
	}
>;
export type AvailabilityView = Readonly<
	Omit<
		ViewWire,
		| "$typeName"
		| "status"
		| "estimatedAvailability"
		| "estimatedDowntimeMinutesPerYear"
		| "observedAvailability"
		| "availabilitySlo"
		| "summary"
		| "canDeploy"
		| "warnings"
		| "errors"
		| "breakdown"
	> & {
		status: "estimated" | "invalid-graph";
		estimatedAvailability: number | null;
		estimatedDowntimeMinutesPerYear: number | null;
		observedAvailability: number | null;
		availabilitySlo: number | null;
		summary: AvailabilitySummary;
		canDeploy: AvailabilityDeployAssessment;
		warnings: readonly AvailabilityWarning[];
		errors: readonly AvailabilityIssue[];
		breakdown: AvailabilityBreakdown;
	}
>;

export function parseAvailabilityViewRequest(
	value: JsonValue,
): AvailabilityViewRequest {
	const parsed = fromJson(AvailabilityViewRequestSchema, value);
	if (parsed.graph === undefined)
		throw new TypeError("availability graph is required");
	return {
		graph: parsed.graph,
		observedAvailability: parsed.observedAvailability ?? null,
		availabilitySlo: parsed.availabilitySlo ?? null,
		conservativeUnratedAvailability: parsed.conservativeUnratedAvailability,
		divergenceThreshold: parsed.divergenceThreshold,
	};
}

type BooleanOperation = "and" | "or";
type Decision = Readonly<{
	variable: number;
	unavailable: number;
	available: number;
}>;

class AvailabilityGraphError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

class AvailabilityModel {
	private readonly decisions: Decision[] = [];
	private readonly unique = new Map<string, number>();
	private readonly variables = new Map<string, number>();
	private readonly chances: number[] = [];
	private readonly combinations = new Map<string, number>();
	private readonly calculated = new Map<number, number>([
		[0, 0],
		[1, 1],
	]);

	variable(key: string, chance: number): number {
		if (chance === 0) return 0;
		if (chance === 1) return 1;
		let index = this.variables.get(key);
		if (index === undefined) {
			index = this.chances.length;
			this.variables.set(key, index);
			this.chances.push(chance);
		}
		return this.decision(index, 0, 1);
	}

	combine(operation: BooleanOperation, left: number, right: number): number {
		if (left === right) return left;
		if (operation === "and") {
			if (left === 0 || right === 0) return 0;
			if (left === 1) return right;
			if (right === 1) return left;
		} else {
			if (left === 1 || right === 1) return 1;
			if (left === 0) return right;
			if (right === 0) return left;
		}
		const first = Math.min(left, right);
		const second = Math.max(left, right);
		const key = `${operation}:${first}:${second}`;
		const cached = this.combinations.get(key);
		if (cached !== undefined) return cached;
		const leftNode = this.decisions[first - 2];
		const rightNode = this.decisions[second - 2];
		if (leftNode === undefined || rightNode === undefined) {
			throw new Error("availability decision is missing");
		}
		const variable = Math.min(leftNode.variable, rightNode.variable);
		const unavailable = this.combine(
			operation,
			leftNode.variable === variable ? leftNode.unavailable : first,
			rightNode.variable === variable ? rightNode.unavailable : second,
		);
		const available = this.combine(
			operation,
			leftNode.variable === variable ? leftNode.available : first,
			rightNode.variable === variable ? rightNode.available : second,
		);
		const result = this.decision(variable, unavailable, available);
		this.combinations.set(key, result);
		return result;
	}

	probability(root: number): number {
		const cached = this.calculated.get(root);
		if (cached !== undefined) return cached;
		const decision = this.decisions[root - 2];
		if (decision === undefined)
			throw new Error("availability decision is missing");
		const chance = this.chances[decision.variable];
		if (chance === undefined) throw new Error("availability chance is missing");
		const result =
			(1 - chance) * this.probability(decision.unavailable) +
			chance * this.probability(decision.available);
		this.calculated.set(root, result);
		return result;
	}

	private decision(
		variable: number,
		unavailable: number,
		available: number,
	): number {
		if (unavailable === available) return unavailable;
		const key = `${variable}:${unavailable}:${available}`;
		const cached = this.unique.get(key);
		if (cached !== undefined) return cached;
		if (this.decisions.length >= MAX_DECISIONS) {
			throw new AvailabilityGraphError(
				"graph-too-complex",
				"availability graph exceeds the decision limit",
			);
		}
		const id = this.decisions.length + 2;
		this.decisions.push({ variable, unavailable, available });
		this.unique.set(key, id);
		return id;
	}
}

function ratio(value: number, field: string): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError(`${field} must be a number from 0 to 1`);
	}
	return value;
}

function rounded(value: number, places: number): number {
	return Number(value.toFixed(places));
}

export function formatAvailabilityPercent(
	value: number | null | undefined,
): string {
	return value === null || value === undefined
		? "unknown"
		: `${(ratio(value, "availability") * 100).toFixed(3)}%`;
}

function summary(
	estimated: number | null,
	observed: number | null,
): AvailabilitySummary {
	const gap =
		estimated === null || observed === null
			? null
			: Math.abs(estimated - observed);
	return {
		estimated: formatAvailabilityPercent(estimated),
		observed: formatAvailabilityPercent(observed),
		estimateObservedGap: formatAvailabilityPercent(gap),
	};
}

function dependencies(
	value: readonly string[] | undefined,
	node: string,
	field: string,
): readonly string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.some((item) => !isJsonString(item) || item.length === 0)
	) {
		throw new AvailabilityGraphError(
			"invalid-dependency-list",
			`node ${node} ${field} must be a list of names`,
		);
	}
	return [...new Set(value)];
}

export function computeAvailabilityView(
	request: AvailabilityViewRequest,
): AvailabilityView {
	const observed =
		request.observedAvailability == null
			? null
			: ratio(request.observedAvailability, "observedAvailability");
	const slo =
		request.availabilitySlo == null
			? null
			: ratio(request.availabilitySlo, "availabilitySlo");
	const fallback = ratio(
		request.conservativeUnratedAvailability ?? DEFAULT_UNRATED_AVAILABILITY,
		"conservativeUnratedAvailability",
	);
	const divergence = ratio(
		request.divergenceThreshold ?? DEFAULT_DIVERGENCE_THRESHOLD,
		"divergenceThreshold",
	);
	const graph = request.graph;
	const warnings: AvailabilityWarning[] = [];
	const countedNodes: string[] = [];
	const byNode = new Map<string, AvailabilityNodeEstimate>();
	const model = new AvailabilityModel();
	const resolved = new Map<string, number>();
	const active = new Set<string>();
	let rawEstimate: number;
	try {
		if (!graph?.root || !graph.nodes) {
			throw new AvailabilityGraphError(
				"invalid-graph",
				"graph requires root and nodes",
			);
		}
		const hop = ratio(
			graph.defaultHopAvailability ?? 1,
			"defaultHopAvailability",
		);
		function visit(id: string, path: readonly string[]): number {
			if (active.has(id)) {
				throw new AvailabilityGraphError(
					"cycle-detected",
					`cycle detected: ${[...path, id].join(" -> ")}`,
				);
			}
			const cached = resolved.get(id);
			if (cached !== undefined) return cached;
			const node = Object.hasOwn(graph.nodes, id) ? graph.nodes[id] : undefined;
			if (node === undefined)
				throw new AvailabilityGraphError("missing-node", `missing node: ${id}`);
			active.add(id);
			const nextPath = [...path, id];
			const kind = node.type ?? "component";
			let result: number;
			if (kind === "redundant-set") {
				if (
					node.availability !== undefined ||
					node.provider !== undefined ||
					dependencies(node.dependsOn, id, "dependsOn").length > 0
				) {
					throw new AvailabilityGraphError(
						"invalid-redundant-set",
						`redundant set ${id} cannot declare component fields`,
					);
				}
				const members = dependencies(node.members, id, "members");
				if (members.length === 0)
					throw new AvailabilityGraphError(
						"invalid-redundant-set",
						`redundant set ${id} requires members`,
					);
				result = 0;
				for (const member of members)
					result = model.combine("or", result, visit(member, nextPath));
				const shared = dependencies(
					node.sharedDependencies,
					id,
					"sharedDependencies",
				);
				if (shared.length > 0) {
					warnings.push({
						code: "redundancy-shared-failure-domain",
						message: "redundant set has shared dependencies",
						node: id,
						sharedDependencies: shared,
					});
					for (const dependency of shared)
						result = model.combine("and", result, visit(dependency, nextPath));
				}
			} else if (kind === "component") {
				if (
					dependencies(node.members, id, "members").length > 0 ||
					dependencies(node.sharedDependencies, id, "sharedDependencies")
						.length > 0
				) {
					throw new AvailabilityGraphError(
						"invalid-component",
						`component ${id} cannot declare redundancy fields`,
					);
				}
				countedNodes.push(id);
				const chance =
					node.availability === undefined
						? fallback
						: ratio(node.availability, `nodes.${id}.availability`);
				if (node.availability === undefined)
					warnings.push({
						code: "unrated-provider",
						message:
							"provider/resource SLA is unrated; conservative default used",
						node: id,
						provider: node.provider ?? id,
						assumedAvailability: fallback,
					});
				result = model.variable(JSON.stringify(["component", id]), chance);
				for (const dependency of dependencies(
					node.dependsOn,
					id,
					"dependsOn",
				)) {
					const pathAvailability = model.variable(
						JSON.stringify(["hop", id, dependency]),
						hop,
					);
					result = model.combine(
						"and",
						result,
						model.combine("and", pathAvailability, visit(dependency, nextPath)),
					);
				}
			} else {
				throw new AvailabilityGraphError(
					"invalid-node-type",
					`node ${id} has an unsupported type`,
				);
			}
			active.delete(id);
			resolved.set(id, result);
			return result;
		}
		const root = visit(graph.root, []);
		rawEstimate = model.probability(root);
		for (const [id, formula] of resolved) {
			const node = graph.nodes[id];
			if (node !== undefined)
				byNode.set(id, {
					type: node.type ?? "component",
					availability: rounded(model.probability(formula), 6),
				});
		}
	} catch (error) {
		const issue: AvailabilityIssue = {
			code:
				error instanceof AvailabilityGraphError ? error.code : "invalid-graph",
			message: error instanceof Error ? error.message : String(error),
		};
		return {
			schema: AVAILABILITY_VIEW_VERSION,
			status: "invalid-graph",
			estimatedAvailability: null,
			estimatedDowntimeMinutesPerYear: null,
			observedAvailability: observed,
			availabilitySlo: slo,
			summary: summary(null, observed),
			canDeploy: { effect: "warn", warnings: [{ ...issue, hardGate: false }] },
			warnings,
			errors: [issue],
			breakdown: { byNode: Object.fromEntries(byNode), countedNodes },
		};
	}
	const estimate = rounded(rawEstimate, 6);
	if (observed !== null) {
		const gap = Math.abs(rawEstimate - observed);
		if (gap >= divergence)
			warnings.push({
				code: "estimate-observed-divergence",
				message: "observed availability diverges from the estimate",
				estimatedAvailability: estimate,
				observedAvailability: observed,
				gap: rounded(gap, 6),
			});
	}
	const deploymentWarnings: AvailabilityWarning[] = [];
	if (slo !== null && rawEstimate < slo)
		deploymentWarnings.push({
			code: "availability-floor-unmet",
			message: "architecture-derived estimate is below availabilitySlo",
			hardGate: false,
			estimatedAvailability: estimate,
			availabilitySlo: slo,
		});
	return {
		schema: AVAILABILITY_VIEW_VERSION,
		status: "estimated",
		estimatedAvailability: estimate,
		estimatedDowntimeMinutesPerYear: rounded(
			(1 - rawEstimate) * MINUTES_PER_YEAR,
			3,
		),
		observedAvailability: observed,
		availabilitySlo: slo,
		summary: summary(estimate, observed),
		canDeploy: {
			effect: deploymentWarnings.length > 0 ? "warn" : "allow",
			warnings: deploymentWarnings,
		},
		warnings,
		errors: [],
		breakdown: { byNode: Object.fromEntries(byNode), countedNodes },
	};
}
