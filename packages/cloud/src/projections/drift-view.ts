/**
 * Drift: the difference between recorded intent and materialized reality.
 *
 * HoBo already holds both halves. A `DeploymentViewRow` carries the plan — what
 * was decided — and the per-resource lifecycle facts folded from `resource.*`
 * events — what actually happened. Nothing derived the difference, so a
 * divergence was only ever discovered by someone going to look. This module is
 * that derivation, and deliberately nothing more: a pure function over a row
 * that already exists. No new event, no new state, no reconciler.
 *
 * Deriving rather than storing is the point. A stored drift flag is a fourth
 * thing that can itself be stale; a derived one is correct by construction
 * whenever the view is, and it rebuilds from zero with the log (ADR-0135).
 *
 * ## Why it classifies by lifecycle rather than by diffing fields
 *
 * The known failure mode of this whole category is *false* drift. Field-level
 * comparison reports every defaulted value, every server-side mutation and
 * every controller that writes back to spec, so teams add ignore rules, and the
 * ignore rules accumulate until the surface is blind to the real thing. That
 * ending is reliable enough to design against.
 *
 * So the classification keys on typed lifecycle states, which mean something
 * definite, instead of on arbitrary payload equality. This is the same argument
 * ADR-0136 makes for typed contracts: what matters is whether the contract is
 * met, not whether two JSON blobs happen to match.
 *
 * ## Three states, not two
 *
 * `converging` exists because "is it different?" is the wrong question while
 * work is in flight. A resource mid-provision is the plan being carried out. A
 * two-state model has to call that either drift (false alarm on every deploy)
 * or in-sync (a lie until it settles). Naming the third state costs one word
 * and removes both.
 *
 * `unknown` exists for the same reason in the other direction: a deployment
 * with no plan, or one deliberately rolled back, has nothing to compare
 * against. Reporting "no drift" there would be a clean bill of health for
 * something nobody described — the most dangerous of the available answers.
 */
import type {
	DeploymentViewRow,
	ResourceLifecycle,
} from "./deployment-view.js";

/**
 * Why a resource diverges.
 *
 * - `absent` — planned, but no lifecycle fact was ever recorded for it.
 * - `destroyed` — planned, but the estate reports it gone.
 * - `failed` — planned, and provisioning failed.
 * - `unplanned` — present in the estate, absent from the plan.
 */
export type DriftKind = "absent" | "destroyed" | "failed" | "unplanned";

export interface DriftFinding {
	readonly kind: DriftKind;
	readonly resource: string;
	/** The recorded lifecycle, when one exists. Absent findings have none. */
	readonly lifecycle?: ResourceLifecycle;
	/** One sentence a human can act on without opening the event log. */
	readonly detail: string;
}

/**
 * - `in-sync` — every planned resource is realized and nothing extra is live.
 * - `converging` — no divergence, but work is still in flight.
 * - `out-of-sync` — at least one finding.
 * - `unknown` — nothing meaningful to compare.
 */
export type DriftStatus = "in-sync" | "converging" | "out-of-sync" | "unknown";

export interface DriftReport {
	readonly deploymentId: string;
	readonly status: DriftStatus;
	readonly findings: readonly DriftFinding[];
	readonly summary: {
		readonly planned: number;
		readonly realized: number;
		readonly findings: number;
	};
}

/** Lifecycles that mean work is under way rather than settled. */
const IN_FLIGHT: ReadonlySet<ResourceLifecycle> = new Set([
	"provisioning",
	"destroying",
]);

/**
 * Deployment statuses whose resources are not meant to match the plan.
 *
 * A rolled-back deployment is *supposed* to have lost its resources, and a
 * rejected one never had any: measuring either against the plan reports the
 * intended end state as a divergence.
 */
const NOT_MEASURED: ReadonlySet<DeploymentViewRow["status"]> = new Set([
	"rejected",
	"rolled-back",
]);

const EMPTY_SUMMARY = { planned: 0, realized: 0, findings: 0 } as const;

export function computeDrift(row: DeploymentViewRow): DriftReport {
	const unknown: DriftReport = {
		deploymentId: row.deploymentId,
		status: "unknown",
		findings: [],
		summary: EMPTY_SUMMARY,
	};

	if (NOT_MEASURED.has(row.status)) return unknown;
	const planned = row.plan?.resources;
	if (planned === undefined || planned.length === 0) return unknown;

	const plannedNames = new Set(planned.map((resource) => resource.name));
	const findings: DriftFinding[] = [];
	let realized = 0;
	let inFlight = false;

	for (const name of plannedNames) {
		const lifecycle = row.resources[name];
		if (lifecycle === undefined) {
			findings.push({
				kind: "absent",
				resource: name,
				detail: `${name} is planned but no resource fact was ever recorded for it`,
			});
			continue;
		}
		if (lifecycle === "provisioned") {
			realized += 1;
			continue;
		}
		if (IN_FLIGHT.has(lifecycle)) {
			inFlight = true;
			continue;
		}
		findings.push({
			kind: lifecycle === "failed" ? "failed" : "destroyed",
			resource: name,
			lifecycle,
			detail:
				lifecycle === "failed"
					? `${name} is planned but its provisioning failed`
					: `${name} is planned but the estate reports it destroyed`,
		});
	}

	// Extra resources only count against a deployment HoBo provisioned. An
	// imported estate is full of things HoBo did not create, and flagging all of
	// them on the first run would make the report useless exactly where adoption
	// needs it most (ADR-0041).
	if (row.imported !== true) {
		for (const [name, lifecycle] of Object.entries(row.resources)) {
			if (plannedNames.has(name)) continue;
			// Gone is gone: a destroyed resource nobody planned is not a live
			// divergence, and flagging it forever is the noise that trains people
			// to stop reading.
			if (lifecycle === "destroyed") continue;
			findings.push({
				kind: "unplanned",
				resource: name,
				lifecycle,
				detail: `${name} exists in the estate but the plan does not declare it`,
			});
		}
	}

	findings.sort((a, b) => a.resource.localeCompare(b.resource));

	// A real divergence outranks in-flight work. Reporting `converging` while a
	// resource has already failed would bury the actionable half until the rest
	// settles.
	const status: DriftStatus =
		findings.length > 0 ? "out-of-sync" : inFlight ? "converging" : "in-sync";

	return {
		deploymentId: row.deploymentId,
		status,
		findings,
		summary: {
			planned: plannedNames.size,
			realized,
			findings: findings.length,
		},
	};
}
