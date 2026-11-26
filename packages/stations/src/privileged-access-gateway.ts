/**
 * Privileged Access Gateway Station attachment surface (ADR-0131 / ADR-0133).
 * Re-exports full implementations from @hobo/connectivity — no stubs.
 */
export {
	type AuditSink,
	type CreatePrivilegedAccessGatewayOptions,
	createBoundaryPamGateway,
	createJumpServerPamGateway,
	createNativePamGateway,
	createPamAuditSink,
	createPrivilegedAccessGateway,
	createTeleportPamGateway,
	PAM_GATEWAY_SCHEMA,
	PAM_RAIL_CAPABILITY,
	type PamAuditEvent,
	type PamKind,
	type PrivilegedAccessGateway,
	type PrivilegedAccessGatewayHandle,
	railEnablesPam,
	type SessionHandle,
	type SessionRequest,
	type SessionTarget,
	type StationContext,
} from "@hobo/connectivity";

/** @deprecated use PamKind from connectivity */
export type PamIsolationClass = import("@hobo/connectivity").IsolationClass;
