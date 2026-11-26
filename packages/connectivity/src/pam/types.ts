/**
 * Privileged Access Gateway types — optional Station capability (ADR-0133).
 * Full secretless session brokering; no stub paths.
 */
import type { IsolationClass } from "../env-isolation/types.js";

// public-contract: privileged access gateway schema.
export const PAM_GATEWAY_SCHEMA = "hobo.privileged-access-gateway/v1" as const;

// public-contract: PAM Rail capability id.
export const PAM_RAIL_CAPABILITY =
	"capability:privileged-access-gateway" as const;

export type PamKind = "native" | "teleport" | "boundary" | "jumpserver";

export type StationContext = Readonly<{
	stationId: string;
	tenant: string;
	isolationClass: IsolationClass;
	railId?: string;
	trustDomain: string;
}>;

export type SessionTarget = Readonly<{
	/** Logical target id (ssh:host, k8s:cluster, db:name). */
	id: string;
	kind: "ssh" | "k8s" | "db" | "web" | "generic";
	/** Isolation class of the target host/resource. */
	isolationClass: IsolationClass;
	/** Optional remote address for transport (never a long-lived secret). */
	address?: string;
}>;

export type SessionRequest = Readonly<{
	subject: string;
	target: string | SessionTarget;
	/** Secretless-first: always prefer short-lived brokered material. */
	preferSecretless: true;
	/** Required for production (and capabilityRequiredClasses). */
	elevatedToken?: string;
	ttlSeconds?: number;
	reason?: string;
	/** Optional principal tags for policy evaluation. */
	subjectTags?: readonly string[];
}>;

export type SessionHandle = Readonly<{
	sessionId: string;
	expiresAt: string;
	credentialRef: string;
	/** Short-lived session material — caller must not log. */
	sessionToken: string;
	auditStreamId: string;
	isolationClass: IsolationClass;
	kind: PamKind;
	targetId: string;
	protocol: "ssh-cert" | "boundary-authz" | "jumpserver-token" | "hobo-svid";
}>;

export type PamAuditEvent = Readonly<{
	type:
		| "pam.SessionStarted"
		| "pam.CredentialRedeemed"
		| "pam.SessionEnded"
		| "pam.SessionDenied"
		| "pam.SessionRenewed"
		| "pam.GatewayStarted"
		| "pam.GatewayStopped";
	time: string;
	stationId: string;
	tenant: string;
	sessionId?: string;
	subject: string;
	target?: string;
	isolationClass: IsolationClass;
	kind: PamKind;
	reason?: string;
	/** Credential refs only — never raw secrets. */
	credentialRef?: string;
}>;

export type AuditSink = {
	readonly append: (event: PamAuditEvent) => void | Promise<void>;
	/** Drain/copy audit events for Yard event log projection. */
	readonly list?: () => readonly PamAuditEvent[];
};

export interface PrivilegedAccessGateway {
	readonly kind: PamKind;
	readonly schemaVersion: typeof PAM_GATEWAY_SCHEMA;
	readonly isolationClass: IsolationClass;
	readonly running: boolean;
	start(ctx: StationContext): Promise<void>;
	stop(): Promise<void>;
	brokerSession(req: SessionRequest): Promise<SessionHandle>;
	renewSession(sessionId: string, ttlSeconds?: number): Promise<SessionHandle>;
	endSession(sessionId: string, reason?: string): Promise<void>;
	listSessions(): readonly SessionHandle[];
	registerTarget(target: SessionTarget): void;
	readonly auditSink: AuditSink;
}

export type PamTransportConfig = Readonly<{
	/**
	 * Optional remote control-plane base URL.
	 * When set, adapters issue real HTTP API calls (Teleport/Boundary/JumpServer).
	 * When omitted, full local secretless brokering is used (production-capable native path).
	 */
	endpoint?: string;
	/** Bearer / auth token for remote control plane (never logged). */
	authToken?: string;
	fetchImpl?: typeof fetch;
}>;
