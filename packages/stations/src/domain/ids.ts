import * as Schema from "effect/Schema";

export const TrafficRouteId = Schema.String.pipe(Schema.brand("TrafficRouteId"));
export type TrafficRouteId = typeof TrafficRouteId.Type;

export const CloudBackendId = Schema.String.pipe(Schema.brand("CloudBackendId"));
export type CloudBackendId = typeof CloudBackendId.Type;

export const CloudProviderKind = Schema.Literals([
	"vercel",
	"cloudflare",
	"hostinger",
	"local",
]);
export type CloudProviderKind = typeof CloudProviderKind.Type;

export const CutoverPhase = Schema.Literals([
	"unregistered",
	"steady",
	"ttl-lowering",
	"ramping",
	"reconciliation-required",
	"rolled-back",
]);
export type CutoverPhase = typeof CutoverPhase.Type;
