/**
 * Trail event family. Identity-sensitive progress reuses credential-audit posture.
 */
// public-contract: trail event schema version.
export const TRAIL_EVENT_SCHEMA = "hobo.trail-events/v1" as const;

export const TRAIL_EVENTS = Object.freeze({
	Started: "trail.Started",
	Planned: "trail.Planned",
	DualActive: "trail.DualActive",
	Progressed: "trail.Progressed",
	Validated: "trail.Validated",
	Cutover: "trail.Cutover",
	Compensated: "trail.Compensated",
	Aborted: "trail.Aborted",
	Failed: "trail.Failed",
	HistoryRecorded: "trail.HistoryRecorded",
} as const);

export type TrailEventType = (typeof TRAIL_EVENTS)[keyof typeof TRAIL_EVENTS];

export type TrailEvent = Readonly<{
	id: string;
	type: TrailEventType;
	schemaVersion: typeof TRAIL_EVENT_SCHEMA;
	tenant: string;
	seq: number;
	time: string;
	correlationId: string;
	causationId: string;
	/** Never-compact when identity-linked. */
	retention: "standard" | "credential-audit-never-compact";
	data: JsonObject;
}>;

export function createTrailEvent(
	type: TrailEventType,
	input: {
		readonly tenant: string;
		readonly trailRunId: string;
		readonly seq: number;
		readonly time?: string;
		readonly causationId?: string;
		readonly identityLinked?: boolean;
		readonly data: JsonObject;
	},
): TrailEvent {
	// Redaction-at-capture: refuse secret-looking leaves in data.
	const blob = JSON.stringify(input.data);
	if (
		/(password|api[_-]?key|private[_-]?key|BEGIN (RSA |EC )?PRIVATE KEY)/i.test(
			blob,
		)
	) {
		throw Object.assign(
			new Error("trail event must not contain plaintext secrets"),
			{ code: "trail-event-secret-forbidden" },
		);
	}
	return Object.freeze({
		id: `evt-${type}-${input.trailRunId}-${input.seq}`,
		type,
		schemaVersion: TRAIL_EVENT_SCHEMA,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time ?? new Date().toISOString(),
		correlationId: `corr-trail-${input.trailRunId}`,
		causationId: input.causationId ?? `cause-trail-${input.trailRunId}`,
		retention: input.identityLinked
			? "credential-audit-never-compact"
			: "standard",
		data: Object.freeze({ ...input.data }),
	});
}

import type { JsonObject } from "./json.js";
