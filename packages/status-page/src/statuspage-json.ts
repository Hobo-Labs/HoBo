/**
 * Statuspage-v2-compatible JSON emitter.
 *
 * githubstatus.com and status.claude.com are Atlassian Statuspage instances
 * exposing `/api/v2/summary.json`; emitting the same shape makes HoBo status
 * pages consumable by the existing ecosystem of status widgets and clients.
 *
 * Honest mapping caveat: statuspage has no `unknown` component status. HoBo
 * `unknown` maps to `degraded_performance` with a "status delayed / unknown"
 * description so a delayed component can never read as green downstream.
 */
import type {
	IncidentRecord,
	MaintenanceRecord,
	StatusPageModel,
} from "./types.js";

export type StatuspageComponentStatus =
	| "operational"
	| "degraded_performance"
	| "partial_outage"
	| "major_outage"
	| "under_maintenance";

export type StatuspageIndicator =
	| "none"
	| "minor"
	| "major"
	| "critical"
	| "maintenance";

export interface StatuspageComponent {
	readonly id: string;
	readonly name: string;
	readonly status: StatuspageComponentStatus;
	readonly description: string | null;
	readonly position: number;
	readonly group_id: null;
	readonly showcase: boolean;
	readonly only_show_if_degraded: boolean;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface StatuspageIncidentUpdate {
	readonly id: string;
	readonly status: string;
	readonly body: string;
	readonly incident_id: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly display_at: string;
}

export interface StatuspageIncident {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly impact: "none" | "minor" | "major" | "critical";
	readonly created_at: string;
	readonly updated_at: string;
	readonly started_at: string;
	readonly monitoring_at: string | null;
	readonly resolved_at: string | null;
	readonly shortlink: string;
	readonly page_id: string;
	readonly incident_updates: readonly StatuspageIncidentUpdate[];
}

export interface StatuspageMaintenance extends StatuspageIncident {
	readonly scheduled_for: string;
	readonly scheduled_until: string;
}

export interface StatuspageSummary {
	readonly page: {
		readonly id: string;
		readonly name: string;
		readonly url: string;
		readonly time_zone: string;
		readonly updated_at: string;
	};
	readonly status: {
		readonly indicator: StatuspageIndicator;
		readonly description: string;
	};
	readonly components: readonly StatuspageComponent[];
	readonly incidents: readonly StatuspageIncident[];
	readonly scheduled_maintenances: readonly StatuspageMaintenance[];
}

const COMPONENT_STATUS_MAP = {
	operational: "operational",
	maintenance: "under_maintenance",
	// No `unknown` in statuspage-v2 — degraded is the conservative,
	// never-stale-operational mapping (ADR-0077 §4).
	unknown: "degraded_performance",
	degraded: "degraded_performance",
	partial_outage: "partial_outage",
	major_outage: "major_outage",
} as const;

const INDICATOR_MAP = {
	none: "none",
	minor: "minor",
	major: "major",
	critical: "critical",
	maintenance: "maintenance",
	unknown: "minor",
} as const;

const MAINTENANCE_STATUS_MAP = {
	scheduled: "scheduled",
	"in-progress": "in_progress",
	completed: "completed",
	canceled: "completed",
} as const;

export interface StatuspageSummaryOptions {
	readonly pageUrl?: string;
}

function toIncident(
	incident: IncidentRecord,
	pageId: string,
): StatuspageIncident {
	const monitoring = incident.updates.find(
		(update) => update.state === "monitoring",
	);
	return {
		id: incident.id,
		name: incident.title,
		status: incident.state,
		impact: incident.impact,
		created_at: incident.openedAt,
		updated_at: incident.updatedAt,
		started_at: incident.openedAt,
		monitoring_at: monitoring?.at ?? null,
		resolved_at: incident.resolvedAt ?? null,
		shortlink: "",
		page_id: pageId,
		incident_updates: incident.updates.map((update, index) => ({
			id: `${incident.id}-update-${index + 1}`,
			status: update.state,
			body: update.body,
			incident_id: incident.id,
			created_at: update.at,
			updated_at: update.at,
			display_at: update.at,
		})),
	};
}

function toMaintenance(
	maintenance: MaintenanceRecord,
	pageId: string,
	updatedAt: string,
): StatuspageMaintenance {
	return {
		id: maintenance.id,
		name: maintenance.title,
		status: MAINTENANCE_STATUS_MAP[maintenance.state] ?? "scheduled",
		impact: "none",
		created_at: maintenance.windowStart,
		updated_at: updatedAt,
		started_at: maintenance.windowStart,
		monitoring_at: null,
		resolved_at:
			maintenance.state === "completed" ? maintenance.windowEnd : null,
		shortlink: "",
		page_id: pageId,
		incident_updates: [],
		scheduled_for: maintenance.windowStart,
		scheduled_until: maintenance.windowEnd,
	};
}

/** Emit the `/api/v2/summary.json` document for a status-page model. */
export function toStatuspageSummary(
	model: StatusPageModel,
	options: StatuspageSummaryOptions = {},
): StatuspageSummary {
	const pageId = `${model.scope.kind}-${model.scope.id}`;
	return {
		page: {
			id: pageId,
			name: model.scope.label,
			url: options.pageUrl ?? "",
			time_zone: "Etc/UTC",
			updated_at: model.generatedAt,
		},
		status: {
			indicator: INDICATOR_MAP[model.overall.indicator],
			description: model.overall.description,
		},
		components: model.components.map((component, index) => ({
			id: component.spec.id,
			name: component.spec.label,
			status: COMPONENT_STATUS_MAP[component.status],
			description: component.delayed
				? "Status delayed / unknown"
				: (component.spec.description ?? null),
			position: index + 1,
			group_id: null,
			showcase: true,
			only_show_if_degraded: false,
			created_at: model.generatedAt,
			updated_at: component.lastSignalAt ?? model.generatedAt,
		})),
		incidents: [...model.activeIncidents, ...model.recentIncidents].map(
			(incident) => toIncident(incident, pageId),
		),
		scheduled_maintenances: model.maintenances
			.filter((maintenance) => maintenance.state !== "canceled")
			.map((maintenance) =>
				toMaintenance(maintenance, pageId, model.generatedAt),
			),
	};
}

/** Emit the minimal `/api/v2/status.json` document. */
export function toStatuspageStatus(
	model: StatusPageModel,
	options: StatuspageSummaryOptions = {},
): Pick<StatuspageSummary, "page" | "status"> {
	const summary = toStatuspageSummary(model, options);
	return { page: summary.page, status: summary.status };
}
