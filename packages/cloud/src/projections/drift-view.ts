import type {
	DeploymentViewRow,
	ResourceLifecycle,
} from "./deployment-view.js";

export type DriftKind = "absent" | "destroyed" | "failed" | "unplanned";

export interface DriftFinding {
	readonly kind: DriftKind;
	readonly resource: string;
	readonly lifecycle?: ResourceLifecycle;
	readonly detail: string;
}

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

const IN_FLIGHT: ReadonlySet<ResourceLifecycle> = new Set([
	"provisioning",
	"destroying",
]);

const NOT_MEASURED: ReadonlySet<DeploymentViewRow["status"]> = new Set([
	"rejected",
	"rolled-back",
	"rolling-back",
	"pruning",
	"needs-human",
]);

const EMPTY_SUMMARY = { planned: 0, realized: 0, findings: 0 } as const;

export function computeDrift(row: DeploymentViewRow): DriftReport {
	const unknown: DriftReport = {
		deploymentId: row.deploymentId,
		status: "unknown",
		findings: [],
		summary: EMPTY_SUMMARY,
	};

	if (
		NOT_MEASURED.has(row.status) ||
		Object.values(row.resources).includes("reconciliation-required")
	)
		return unknown;
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

	if (row.imported !== true) {
		for (const [name, lifecycle] of Object.entries(row.resources)) {
			if (plannedNames.has(name)) continue;
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
