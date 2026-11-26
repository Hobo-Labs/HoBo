import {
	type MinAvailabilitySpec,
	type PolicyDecision,
	parseRoutingPlan,
	type ResiliencySpec,
	type RoutingPlan,
	type RoutingWeightStrategy,
	type TenantId,
} from "@hobo/core";
import { cloneAsJson } from "../json.js";

export type RoutingTopology = Readonly<{
	service: string;
	tenantId: TenantId;
	stationId?: string;
	railHash?: `sha256:${string}`;
	/** Explicit cost-routing eligibility; single-writer resources cannot move by price. */
	costRouting?:
		| "stateless"
		| "active-active-eventual"
		| "pinned-with-replica"
		| "single-writer";
	backends: readonly Readonly<{
		id: string;
		service: string;
		locationHints?: readonly string[];
		endpoint?: string;
		weight?: number;
		healthy?: boolean;
	}>[];
}>;

export type RoutingSynthesisDenial = Readonly<{
	code:
		| "station-missing"
		| "policy-denied"
		| "policy-context-mismatch"
		| "policy-obligations-unsatisfied"
		| "availability-unsatisfied";
	message: string;
}>;

export type RoutingSynthesisResult =
	| Readonly<{ kind: "plan"; plan: RoutingPlan }>
	| Readonly<{ kind: "denied"; reasons: readonly RoutingSynthesisDenial[] }>;

export function synthesizeRoutingPlan(
	input: Readonly<{
		topology: RoutingTopology;
		availability?: MinAvailabilitySpec;
		resiliency?: ResiliencySpec;
		policyDecision: PolicyDecision;
		now?: string;
		planId?: string;
		/**
		 * Default "prefer-healthy". Pass "static" when the caller has already
		 * folded health into explicit weights (e.g. the control loop's swap
		 * plans) so weight-only providers can realize the plan in full.
		 */
		weightStrategy?: RoutingWeightStrategy;
	}>,
): RoutingSynthesisResult {
	if (!input.topology.stationId) {
		return deny(
			"station-missing",
			"routing synthesis requires Station context",
		);
	}
	if (input.policyDecision.effect === "deny") {
		return deny(
			"policy-denied",
			input.policyDecision.reasons.join("; ") || "routing denied by policy",
		);
	}
	if (
		input.policyDecision.audit.tenantId !== input.topology.tenantId ||
		input.policyDecision.audit.action !== "routing.plan" ||
		input.policyDecision.audit.resourceKind !== "service" ||
		input.policyDecision.audit.resourceId !== input.topology.service
	) {
		return deny(
			"policy-context-mismatch",
			"routing policy decision does not match the topology context",
		);
	}
	if ((input.policyDecision.obligations?.length ?? 0) > 0) {
		return deny(
			"policy-obligations-unsatisfied",
			"routing policy obligations require explicit satisfaction evidence",
		);
	}

	const candidates = input.topology.backends.filter(
		({ healthy }) => healthy !== false,
	);
	if (candidates.length === 0) {
		return deny(
			"availability-unsatisfied",
			"routing topology has no backend that is not confirmed unhealthy",
		);
	}
	const availability = evaluateAvailability(
		input.topology,
		candidates,
		input.availability,
	);
	if (availability.denials.length > 0) {
		return Object.freeze({
			kind: "denied",
			reasons: Object.freeze(availability.denials),
		});
	}
	const backends = candidates.map(toBackendRef);
	const notes = availability.notes;
	return Object.freeze({
		kind: "plan",
		plan: parseRoutingPlan(
			cloneAsJson({
				planId:
					input.planId ??
					`plan:${input.topology.service}:${input.topology.stationId}`,
				intent: {
					service: input.topology.service,
					tenantId: input.topology.tenantId,
					rules: [
						{
							backends,
							weightStrategy: input.weightStrategy ?? "prefer-healthy",
						},
					],
					...(input.availability !== undefined
						? { availability: input.availability }
						: undefined),
					...(input.resiliency !== undefined
						? { resiliency: input.resiliency }
						: undefined),
				},
				backends,
				stationId: input.topology.stationId,
				...(input.topology.railHash !== undefined
					? { railHash: input.topology.railHash }
					: undefined),
				createdAt: input.now ?? input.policyDecision.audit.decidedAt,
				...(notes.length > 0 ? { degraded: true, notes } : undefined),
			}),
		),
	});
}

function deny(
	code: RoutingSynthesisDenial["code"],
	message: string,
): RoutingSynthesisResult {
	return Object.freeze({
		kind: "denied",
		reasons: Object.freeze([Object.freeze({ code, message })]),
	});
}

function toBackendRef(backend: RoutingTopology["backends"][number]) {
	return {
		id: backend.id,
		service: backend.service,
		...(backend.locationHints !== undefined
			? { locationHints: backend.locationHints }
			: undefined),
		...(backend.endpoint !== undefined
			? { endpoint: backend.endpoint }
			: undefined),
		...(backend.weight !== undefined ? { weight: backend.weight } : undefined),
	};
}

function evaluateAvailability(
	topology: RoutingTopology,
	candidates: readonly RoutingTopology["backends"][number][],
	availability: MinAvailabilitySpec | undefined,
) {
	const notes: string[] = [];
	const denials: RoutingSynthesisDenial[] = [];
	const excluded = topology.backends.length - candidates.length;
	if (excluded > 0) {
		notes.push(`${excluded} confirmed unhealthy backend(s) excluded`);
	}
	const missingHealth = candidates.filter(
		({ healthy }) => healthy === undefined,
	).length;
	const locationKeys = candidates.map((backend) =>
		locationKey(backend.locationHints, availability?.locationLabels),
	);
	const missingLocations = locationKeys.filter((key) => key === null).length;
	if (missingHealth > 0) {
		notes.push(
			`${missingHealth} backend health signal(s) missing; using best effort`,
		);
	}
	if (missingLocations > 0) {
		notes.push(
			`${missingLocations} backend location signal(s) missing; using best effort`,
		);
	}

	const healthy = candidates.filter(({ healthy }) => healthy === true).length;
	if (
		availability?.minHealthyBackends !== undefined &&
		healthy < availability.minHealthyBackends
	) {
		notes.push(
			`availability has ${healthy} confirmed healthy backend(s); requires ${availability.minHealthyBackends}`,
		);
		if (healthy + missingHealth < availability.minHealthyBackends) {
			denials.push(
				Object.freeze({
					code: "availability-unsatisfied",
					message: `availability can provide at most ${healthy + missingHealth} healthy backend(s); requires ${availability.minHealthyBackends}`,
				}),
			);
		}
	}
	const locations = new Set(
		locationKeys.flatMap((key) => (key === null ? [] : key)),
	).size;
	if (
		availability?.minDistinctLocations !== undefined &&
		locations < availability.minDistinctLocations
	) {
		notes.push(
			`availability has ${locations} known location(s); requires ${availability.minDistinctLocations}`,
		);
		if (locations + missingLocations < availability.minDistinctLocations) {
			denials.push(
				Object.freeze({
					code: "availability-unsatisfied",
					message: `availability can provide at most ${locations + missingLocations} location(s); requires ${availability.minDistinctLocations}`,
				}),
			);
		}
	}
	return { notes, denials };
}

function locationKey(
	hints: readonly string[] | undefined,
	labels: readonly string[] | undefined,
): string | null {
	if (!hints || hints.length === 0) return null;
	if (!labels || labels.length === 0) return hints.join("|");
	const values = labels.map((label) =>
		hints.find((hint) => hint.startsWith(`${label}:`)),
	);
	return values.some((value) => value === undefined) ? null : values.join("|");
}
