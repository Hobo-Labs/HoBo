// Drift detection and routing (D5; promoted from drift-detection-loop,
// autonomous-drift-remediation, drift-orphan-sweep and version-pinning-drift-
// guard). A re-observation whose resources carry a drift_kind (after retained
// fields are removed) is drift. DriftPolicy routes it per drift class:
// reconcile (re-apply the Camp's current Set), propose (drift.DiffProposed),
// ignore (record only) or escalate (blocked, needs a human). Routing is pure
// over the observation: no clock, RNG, network or model (I8).
import { createHash } from "node:crypto";
import type {
	ReconcileObservationRecord,
	ResourceObservation,
} from "../_generated/cd_pb.js";
import type { CdContext, DriftPolicy, DriftRoute } from "../ports.js";
import { type DriftClass, parseDriftKind } from "./retained.js";

export type DriftFinding = Readonly<{
	resource: string;
	driftClass: DriftClass;
	fields: readonly string[];
	kind: string;
	classification: string;
	outputsHash: string;
}>;

/** Drifted resources of an observation, sorted by resource name. */
export function driftFindings(
	observation: ReconcileObservationRecord,
): readonly DriftFinding[] {
	const out: DriftFinding[] = [];
	for (const resource of observation.resources) {
		const kind = parseDriftKind(resource.driftKind);
		if (!kind) continue;
		out.push(
			Object.freeze({
				resource: resource.resource,
				driftClass: kind.driftClass,
				fields: kind.fields,
				kind: resource.kind,
				classification: resource.classification,
				outputsHash: resource.outputsHash,
			}),
		);
	}
	return Object.freeze(out.sort((a, b) => a.resource.localeCompare(b.resource)));
}

/** Stable identity of one drift: the same desired + observed refs, same print. */
export function driftFingerprint(
	setId: string,
	findings: readonly DriftFinding[],
): string {
	const body = findings
		.map(
			(f) =>
				`${f.resource}|${f.driftClass}|${f.fields.join(",")}|${f.outputsHash}`,
		)
		.join("\n");
	return `sha256:${createHash("sha256").update(`${setId}\n${body}`).digest("hex")}`;
}

const DATA_KIND =
	/(database|^db$|kv|queue|object|storage|bucket|blob|volume|data|cache|stream|search|vector|postgres|mysql|redis)/iu;

/**
 * A data resource holds state that a re-create would lose. Conservative: a
 * classified resource, or one whose kind names a data store, counts as data.
 */
export function isDataResource(
	resource: Pick<ResourceObservation, "kind" | "classification">,
): boolean {
	if (resource.classification !== "") return true;
	const last = resource.kind.split(/[:.]/u).at(-1) ?? resource.kind;
	return DATA_KIND.test(last) || DATA_KIND.test(resource.kind);
}

const SEVERITY: Readonly<Record<DriftRoute, number>> = Object.freeze({
	ignore: 0,
	reconcile: 1,
	propose: 2,
	escalate: 3,
});

/** The most severe route wins. */
export function combineRoutes(routes: readonly DriftRoute[]): DriftRoute {
	let out: DriftRoute = "ignore";
	for (const route of routes) if (SEVERITY[route] > SEVERITY[out]) out = route;
	return out;
}

// public-contract: default drift routes per class.
export const DEFAULT_DRIFT_ROUTES: Readonly<Record<DriftClass, DriftRoute>> =
	Object.freeze({
		modified: "reconcile",
		deleted: "reconcile",
		orphan: "reconcile",
		external: "propose",
		unknown: "escalate",
	});

// public-contract: default blast-radius budget (drifted resources per pass).
export const DEFAULT_DRIFT_BLAST_RADIUS = 10 as const;

export type DriftPolicyOptions = Readonly<{
	routes?: Partial<Record<DriftClass, DriftRoute>>;
	/** More drifted resources than this in one pass escalates. */
	blastRadius?: number;
	/** Route for a deleted data resource; re-creating it would lose data. */
	deletedDataRoute?: DriftRoute;
}>;

export type DriftDecision = Readonly<{
	route: DriftRoute;
	findings: readonly DriftFinding[];
	why: string;
}>;

/** Pure routing decision over one observation's findings. */
export function decideDrift(
	findings: readonly DriftFinding[],
	options: DriftPolicyOptions = {},
): DriftDecision {
	if (findings.length === 0)
		return Object.freeze({ route: "ignore", findings, why: "no drift" });
	const budget = options.blastRadius ?? DEFAULT_DRIFT_BLAST_RADIUS;
	if (findings.length > budget)
		return Object.freeze({
			route: "escalate",
			findings,
			why: `${findings.length} drifted resources exceed the blast-radius budget of ${budget}`,
		});
	const routes = { ...DEFAULT_DRIFT_ROUTES, ...options.routes };
	const per: DriftRoute[] = [];
	const notes: string[] = [];
	for (const finding of findings) {
		let route = routes[finding.driftClass];
		if (finding.driftClass === "deleted" && isDataResource(finding)) {
			route = options.deletedDataRoute ?? "escalate";
			notes.push(`${finding.resource}: deleted data resource`);
		}
		// External/echo resources are detect-only: never re-applied.
		if (finding.driftClass === "external" && route === "reconcile") {
			route = "propose";
			notes.push(`${finding.resource}: external resources are detect-only`);
		}
		per.push(route);
	}
	const route = combineRoutes(per);
	return Object.freeze({
		route,
		findings,
		why:
			notes.length > 0
				? notes.join("; ")
				: `routed ${findings.map((f) => `${f.resource}:${f.driftClass}`).join(", ")}`,
	});
}

/** The default DriftPolicy: per-class routes with the safety overrides above. */
export function createDriftPolicy(options: DriftPolicyOptions = {}): DriftPolicy {
	return Object.freeze({
		async route(
			observation: ReconcileObservationRecord,
			_ctx: CdContext,
		): Promise<DriftRoute> {
			return decideDrift(driftFindings(observation), options).route;
		},
	});
}
