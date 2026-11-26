/**
 * Environment isolation / elevated access / break-glass event factories.
 * Never embed secrets; membership and grant refs only.
 */

// public-contract: access event family schema.
import type { JsonObject } from "../json.js";

export const ACCESS_EVENT_SCHEMA_VERSION = "hobo.access-events/v1" as const;

export const ACCESS_EVENTS = Object.freeze({
	MembershipAssigned: "access.MembershipAssigned",
	MembershipRevoked: "access.MembershipRevoked",
	CrossEnvGranted: "access.CrossEnvGranted",
	CrossEnvExpired: "access.CrossEnvExpired",
	ElevatedMinted: "access.ElevatedMinted",
	ElevatedDenied: "access.ElevatedDenied",
	BreakGlassRequested: "access.BreakGlassRequested",
	BreakGlassGranted: "access.BreakGlassGranted",
	BreakGlassExpired: "access.BreakGlassExpired",
	BreakGlassReviewed: "access.BreakGlassReviewed",
	OverlayJoinDenied: "access.OverlayJoinDenied",
	PolicyPackActivated: "access.PolicyPackActivated",
} as const);

export type AccessEventType =
	(typeof ACCESS_EVENTS)[keyof typeof ACCESS_EVENTS];

export type AccessEvent = Readonly<{
	id: string;
	type: AccessEventType;
	schemaVersion: typeof ACCESS_EVENT_SCHEMA_VERSION;
	tenant: string;
	time: string;
	actor: string;
	data: JsonObject;
}>;

let seq = 0;

export function createAccessEvent(input: {
	readonly type: AccessEventType;
	readonly tenant: string;
	readonly actor: string;
	readonly data: JsonObject;
	readonly time?: string;
}): AccessEvent {
	seq += 1;
	return Object.freeze({
		id: `evt-access-${seq}`,
		type: input.type,
		schemaVersion: ACCESS_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		time: input.time ?? new Date().toISOString(),
		actor: input.actor,
		data: Object.freeze({ ...input.data }),
	});
}
