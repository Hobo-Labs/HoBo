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
	return Object.freeze(
		out.sort((a, b) => a.resource.localeCompare(b.resource)),
	);
}

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

export function combineRoutes(routes: readonly DriftRoute[]): DriftRoute {
	let out: DriftRoute = "ignore";
	for (const route of routes) if (SEVERITY[route] > SEVERITY[out]) out = route;
	return out;
}

export const DEFAULT_DRIFT_ROUTES: Readonly<Record<DriftClass, DriftRoute>> =
	Object.freeze({
		modified: "reconcile",
		deleted: "reconcile",
		orphan: "reconcile",
		external: "propose",
		unknown: "escalate",
	});

export const DEFAULT_DRIFT_BLAST_RADIUS = 10 as const;

export type DriftPolicyOptions = Readonly<{
	routes?: Partial<Record<DriftClass, DriftRoute>>;
	blastRadius?: number;
	deletedDataRoute?: DriftRoute;
}>;

export type DriftDecision = Readonly<{
	route: DriftRoute;
	findings: readonly DriftFinding[];
	why: string;
}>;

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

export function createDriftPolicy(
	options: DriftPolicyOptions = {},
): DriftPolicy {
	return Object.freeze({
		async route(
			observation: ReconcileObservationRecord,
			_ctx: CdContext,
		): Promise<DriftRoute> {
			return decideDrift(driftFindings(observation), options).route;
		},
	});
}
