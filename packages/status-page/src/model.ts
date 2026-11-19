import type { ComponentRow, StatusPageRow } from "./projection.js";
import type { Mutable } from "./types.js";
import {
	type ComponentSpec,
	type ComponentStatus,
	type ComponentStatusRecord,
	type DailyStatusRecord,
	type IncidentRecord,
	type MaintenanceRecord,
	type OverallIndicator,
	STATUS_PAGE_SCHEMA,
	type StatusPageModel,
	type StatusScope,
	worstComponentStatus,
} from "./types.js";

export const DEFAULT_FRESHNESS_BUDGET_MS = 15 * 60 * 1000;

export const DEFAULT_RECENT_INCIDENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface EvaluateOptions {
	readonly scope: StatusScope;
	readonly evaluatedAt: string;
	readonly declaredComponents?: readonly ComponentSpec[];
	readonly freshnessBudgetMs?: number;
	readonly recentIncidentWindowMs?: number;
}

const IMPACT_TO_STATUS = {
	minor: "degraded",
	major: "partial_outage",
	critical: "major_outage",
} as const;

export const INDICATOR_DESCRIPTIONS = {
	none: "All systems operational",
	minor: "Degraded performance",
	major: "Partial system outage",
	critical: "Major system outage",
	maintenance: "Scheduled maintenance in progress",
	unknown: "Status delayed / unknown",
} as const;

function activeIncidentsFor(row: StatusPageRow): readonly IncidentRecord[] {
	return Object.values(row.incidents)
		.filter((incident) => incident.state !== "resolved")
		.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

function maintenanceActiveAt(
	maintenance: MaintenanceRecord,
	evaluatedAtMs: number,
): boolean {
	if (maintenance.state === "canceled" || maintenance.state === "completed") {
		return false;
	}
	return (
		Date.parse(maintenance.windowStart) <= evaluatedAtMs &&
		evaluatedAtMs <= Date.parse(maintenance.windowEnd)
	);
}

function historyOf(
	component: ComponentRow | undefined,
): readonly DailyStatusRecord[] {
	if (!component) return Object.freeze([]);
	return Object.freeze(
		Object.entries(component.history)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, entry]) =>
				Object.freeze({ date, worst: entry.worst, samples: entry.samples }),
			),
	);
}

function specFor(
	id: string,
	declared: ReadonlyMap<string, ComponentSpec>,
	observed: ComponentRow | undefined,
): ComponentSpec {
	const spec = declared.get(id);
	if (spec) return spec;
	const result = {
		id,
		label: observed?.label ?? id,
		kind: "capability" as const,
	};
	return Object.freeze(result);
}

export function describeIndicator(indicator: OverallIndicator): string {
	return INDICATOR_DESCRIPTIONS[indicator];
}

export function overallIndicatorFor(
	statuses: readonly ComponentStatus[],
): OverallIndicator {
	if (statuses.length === 0) return "unknown";
	switch (worstComponentStatus(statuses)) {
		case "operational":
			return "none";
		case "maintenance":
			return "maintenance";
		case "unknown":
			return "unknown";
		case "degraded":
			return "minor";
		case "partial_outage":
			return "major";
		case "major_outage":
			return "critical";
	}
}

export function toStatusPageModel(
	row: StatusPageRow | undefined,
	options: EvaluateOptions,
): StatusPageModel {
	const evaluatedAtMs = Date.parse(options.evaluatedAt);
	if (Number.isNaN(evaluatedAtMs)) {
		throw new TypeError(
			"toStatusPageModel requires an ISO evaluatedAt timestamp",
		);
	}
	const budgetMs = options.freshnessBudgetMs ?? DEFAULT_FRESHNESS_BUDGET_MS;
	const recentWindowMs =
		options.recentIncidentWindowMs ?? DEFAULT_RECENT_INCIDENT_WINDOW_MS;
	const declared = new Map<string, ComponentSpec>(
		(options.declaredComponents ?? []).map((spec) => [spec.id, spec]),
	);
	const observed = row?.components ?? {};

	const activeIncidents = row ? activeIncidentsFor(row) : Object.freeze([]);
	const incidentOverlay = new Map<string, ComponentStatus>();
	for (const incident of activeIncidents) {
		const impactStatus = IMPACT_TO_STATUS[incident.impact];
		for (const componentId of incident.affectedComponents) {
			const current = incidentOverlay.get(componentId);
			incidentOverlay.set(
				componentId,
				current ? worstComponentStatus([current, impactStatus]) : impactStatus,
			);
		}
	}

	const maintenances = Object.values(row?.maintenances ?? {}).sort((a, b) =>
		a.windowStart.localeCompare(b.windowStart),
	);
	const maintenanceOverlay = new Set<string>();
	for (const maintenance of maintenances) {
		if (maintenanceActiveAt(maintenance, evaluatedAtMs)) {
			for (const componentId of maintenance.affectedComponents) {
				maintenanceOverlay.add(componentId);
			}
		}
	}

	const componentIds = [
		...new Set([
			...declared.keys(),
			...Object.keys(observed),
			...incidentOverlay.keys(),
			...maintenanceOverlay,
		]),
	].sort();

	const staleComponentIds: string[] = [];
	const components: ComponentStatusRecord[] = componentIds.map((id) => {
		const component = observed[id];
		const lastSignalMs =
			component?.lastSignalAt !== undefined
				? Date.parse(component.lastSignalAt)
				: Number.NaN;
		const fresh =
			!Number.isNaN(lastSignalMs) && evaluatedAtMs - lastSignalMs <= budgetMs;
		const delayed = !fresh;
		if (delayed) staleComponentIds.push(id);
		let status: ComponentStatus = fresh
			? (component?.status ?? "unknown")
			: "unknown";
		const overlay = incidentOverlay.get(id);
		if (overlay !== undefined) {
			status =
				status === "unknown"
					? overlay
					: worstComponentStatus([status, overlay]);
		}
		if (maintenanceOverlay.has(id) && status === "operational") {
			status = "maintenance";
		}
		const result: Mutable<ComponentStatusRecord> = {
			spec: specFor(id, declared, component),
			status,
			history: historyOf(component),
			delayed,
		};
		if (component?.lastSignalAt !== undefined) {
			result.lastSignalAt = component.lastSignalAt;
		}
		if (fresh && component?.attainment !== undefined) {
			result.attainment = component.attainment;
		}
		if (fresh && component?.target !== undefined) {
			result.target = component.target;
		}
		return Object.freeze(result);
	});

	const recentIncidents = Object.values(row?.incidents ?? {})
		.filter(
			(incident) =>
				incident.state === "resolved" &&
				incident.resolvedAt !== undefined &&
				evaluatedAtMs - Date.parse(incident.resolvedAt) <= recentWindowMs,
		)
		.sort((a, b) =>
			(b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt),
		);

	const indicator = overallIndicatorFor(
		components.map((component) => component.status),
	);

	return Object.freeze({
		schema: STATUS_PAGE_SCHEMA,
		scope: options.scope,
		generatedAt: options.evaluatedAt,
		overall: Object.freeze({
			indicator,
			description: INDICATOR_DESCRIPTIONS[indicator],
		}),
		components: Object.freeze(components),
		activeIncidents,
		recentIncidents: Object.freeze(recentIncidents),
		maintenances: Object.freeze(maintenances),
		freshness: Object.freeze({
			budgetMs,
			staleComponentIds: Object.freeze(staleComponentIds),
		}),
	});
}
