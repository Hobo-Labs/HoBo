import type { EventEnvelope, PrincipalRef } from "@hobo/core";

import type {
	IncidentImpact,
	IncidentState,
	MaintenanceState,
} from "./types.js";

export const STATUS_PAGE_EVENTS = {
	Published: "statuspage.Published",
	Unpublished: "statuspage.Unpublished",
	IncidentPosted: "statuspage.IncidentPosted",
} as const;

export const STATUS_SIGNAL_EVENTS = {
	SloMeasured: "slo.Measured",
	IncidentOpened: "incident.Opened",
	IncidentUpdated: "incident.Updated",
	IncidentResolved: "incident.Resolved",
	MaintenanceScheduled: "maintenance.Scheduled",
	MaintenanceUpdated: "maintenance.Updated",
} as const;

export interface SloMeasuredData {
	readonly componentId: string;
	readonly componentLabel?: string;
	readonly sloName: string;
	readonly attainment: number;
	readonly target: number;
	readonly measuredAt: string;
}

export interface IncidentOpenedData {
	readonly incidentId: string;
	readonly title: string;
	readonly impact: IncidentImpact;
	readonly affectedComponents: readonly string[];
	readonly currentStatus: IncidentState;
}

export interface IncidentUpdatedData {
	readonly incidentId: string;
	readonly currentStatus: IncidentState;
	readonly body: string;
}

export interface IncidentResolvedData {
	readonly incidentId: string;
	readonly resolutionSummary: string;
}

export interface MaintenanceScheduledData {
	readonly maintenanceId: string;
	readonly title: string;
	readonly windowStart: string;
	readonly windowEnd: string;
	readonly affectedComponents: readonly string[];
	readonly expectedImpact: string;
}

export interface MaintenanceUpdatedData {
	readonly maintenanceId: string;
	readonly state: MaintenanceState;
}

export interface StatusPagePublishedData {
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly contentHash: `sha256:${string}`;
	readonly components: readonly string[];
}

export interface StatusPageUnpublishedData {
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly reason: string;
}

export interface StatusPageIncidentPostedData {
	readonly incidentId: string;
	readonly currentStatus: IncidentState;
	readonly body: string;
}

const SYSTEM_ACTOR: PrincipalRef = Object.freeze({
	kind: "system",
	id: "status-page",
});

export interface StatusEnvelopeOptions {
	readonly streamId: string;
	readonly seq: number;
	readonly ts: string;
	readonly tenant?: string;
	readonly project?: string;
	readonly actor?: PrincipalRef;
	readonly id?: string;
}

export function statusEnvelope<T>(
	type: string,
	data: T,
	options: StatusEnvelopeOptions,
): EventEnvelope<T> {
	const envelope: EventEnvelope<T> = {
		id: options.id ?? `${options.streamId}#${options.seq}`,
		type,
		v: 1,
		streamId: options.streamId,
		seq: options.seq,
		ts: options.ts,
		actor: options.actor ?? SYSTEM_ACTOR,
		tenant: options.tenant ?? "local",
		data,
	};
	if (options.project === undefined) return Object.freeze(envelope);
	return Object.freeze({ ...envelope, project: options.project });
}
