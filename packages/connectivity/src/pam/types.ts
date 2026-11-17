import type { IsolationClass } from "../env-isolation/types.js";

// public-contract:
export const PAM_GATEWAY_SCHEMA = "hobo.privileged-access-gateway/v1" as const;

// public-contract:
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
	id: string;
	kind: "ssh" | "k8s" | "db" | "web" | "generic";
	isolationClass: IsolationClass;
	address?: string;
}>;

export type SessionRequest = Readonly<{
	subject: string;
	target: string | SessionTarget;
	preferSecretless: true;
	elevatedToken?: string;
	ttlSeconds?: number;
	reason?: string;
	subjectTags?: readonly string[];
}>;

export type SessionHandle = Readonly<{
	sessionId: string;
	expiresAt: string;
	credentialRef: string;
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
	credentialRef?: string;
}>;

export type AuditSink = {
	readonly append: (event: PamAuditEvent) => void | Promise<void>;
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
	endpoint?: string;
	authToken?: string;
	fetchImpl?: typeof fetch;
}>;
