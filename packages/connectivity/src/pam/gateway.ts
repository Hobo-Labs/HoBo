/**
 * Full Privileged Access Gateway implementation.
 * Secretless session brokering + optional remote control-plane transport.
 * Production requires elevated capability verification (not network membership).
 */

import { randomBytes } from "node:crypto";
import {
	type ElevatedCapabilityTrust,
	verifyElevatedAccessCapability,
} from "../env-isolation/elevated-capability.js";
import { DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK } from "../env-isolation/policy-pack.js";
import type { IsolationClass } from "../env-isolation/types.js";
import { isJsonNumber, isJsonString } from "../json.js";
import { createPamAuditSink } from "./audit.js";
import {
	createRemoteTransport,
	mergeRemoteIntoHandle,
	type RemoteTransport,
} from "./remote-transport.js";
import {
	createSessionBrokerKeys,
	frameSessionProtocol,
	mintSessionToken,
	type SessionBrokerKeys,
	verifySessionToken,
} from "./session-broker.js";
import {
	type AuditSink,
	PAM_GATEWAY_SCHEMA,
	type PamKind,
	type PamTransportConfig,
	type PrivilegedAccessGateway,
	type SessionHandle,
	type SessionRequest,
	type SessionTarget,
	type StationContext,
} from "./types.js";

export type CreatePrivilegedAccessGatewayOptions = Readonly<{
	kind: PamKind;
	isolationClass: IsolationClass;
	auditSink?: AuditSink;
	now?: () => string;
	/** Session signing keys (generated if omitted). */
	keys?: SessionBrokerKeys;
	/** Optional remote PAM control plane. */
	transport?: PamTransportConfig;
	/**
	 * Whose elevated access capabilities this gateway accepts and how they are
	 * verified (`@hobo/identity` `verifyJwtWithJwks` over the issuer's key set).
	 * Without it every session that needs an elevated capability is refused.
	 */
	elevatedTrust?: ElevatedCapabilityTrust;
	/** Classes that always require elevated capability (default from pack). */
	capabilityRequiredClasses?: readonly IsolationClass[];
}>;

export type PrivilegedAccessGatewayHandle = PrivilegedAccessGateway & {
	readonly auditEvents: readonly import("./types.js").PamAuditEvent[];
	readonly yardDrainCount: number;
	verifyLocalSession(token: string): ReturnType<typeof verifySessionToken>;
	/** Transfer a live local authorization to a resident protocol adapter. */
	handoffSession(sessionId: string): SessionHandle;
};

function parseTarget(
	target: string | SessionTarget,
	gatewayClass: IsolationClass,
): SessionTarget {
	if (!isJsonString(target)) {
		return target;
	}
	const kind = target.startsWith("ssh:")
		? "ssh"
		: target.startsWith("k8s:")
			? "k8s"
			: target.startsWith("db:")
				? "db"
				: target.startsWith("web:")
					? "web"
					: "generic";
	return Object.freeze({
		id: target,
		kind,
		isolationClass: gatewayClass,
	});
}

/**
 * Create a production-capable Privileged Access Gateway.
 * Local secretless path is complete; remote transports are full HTTP clients.
 */
export function createPrivilegedAccessGateway(
	options: CreatePrivilegedAccessGatewayOptions,
): PrivilegedAccessGatewayHandle {
	const pack = DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK;
	const capabilityRequired = new Set<IsolationClass>(
		// SAFETY: assertion required at this I/O or test boundary.
		(options.capabilityRequiredClasses ??
			// SAFETY: assertion required at this I/O or test boundary.
			(pack.capabilityRequiredClasses as readonly IsolationClass[])) as IsolationClass[],
	);
	const sinkBase = options.auditSink;
	const yardEvents: import("./types.js").PamAuditEvent[] = [];
	const sink =
		sinkBase ??
		createPamAuditSink({
			yardAppend: (e) => {
				yardEvents.push(e);
			},
		});
	const auditList = (): readonly import("./types.js").PamAuditEvent[] => {
		if (
			"events" in sink &&
			// SAFETY: assertion required at this I/O or test boundary.
			Array.isArray((sink as { events: unknown }).events)
		) {
			// SAFETY: assertion required at this I/O or test boundary.
			return (sink as { events: import("./types.js").PamAuditEvent[] }).events;
		}
		return yardEvents;
	};

	const keys = options.keys ?? createSessionBrokerKeys({ useEs256: false });
	const now = options.now ?? (() => new Date().toISOString());
	const sessions = new Map<string, SessionHandle & { remoteId?: string }>();
	const targets = new Map<string, SessionTarget>();
	let running = false;
	let ctx: StationContext | null = null;
	let remote: RemoteTransport | null = null;

	if (options.transport?.endpoint && options.transport.authToken) {
		remote = createRemoteTransport({
			kind: options.kind,
			endpoint: options.transport.endpoint,
			authToken: options.transport.authToken,
			...(options.transport.fetchImpl
				? { fetchImpl: options.transport.fetchImpl }
				: undefined),
		});
	}

	async function requireElevated(req: SessionRequest): Promise<void> {
		const needs =
			capabilityRequired.has(options.isolationClass) ||
			options.isolationClass === "production";
		if (!needs) return;
		if (!req.elevatedToken) {
			throw Object.assign(
				new Error(
					`${options.isolationClass} PAM session requires elevated capability token`,
				),
				{ code: "elevated-required" },
			);
		}
		const verified = await verifyElevatedAccessCapability({
			token: req.elevatedToken,
			expectedAudience: `${options.isolationClass}-access`,
			expectedIsolationClass: options.isolationClass,
			trust: options.elevatedTrust,
			now: now(),
		});
		if (!verified.ok) {
			throw Object.assign(
				new Error(`elevated capability invalid: ${verified.reason}`),
				{ code: verified.code },
			);
		}
	}

	return {
		kind: options.kind,
		schemaVersion: PAM_GATEWAY_SCHEMA,
		isolationClass: options.isolationClass,
		get running() {
			return running;
		},
		get auditEvents() {
			return auditList();
		},
		get yardDrainCount() {
			if ("drainedToYard" in sink && isJsonNumber(sink.drainedToYard)) {
				return sink.drainedToYard;
			}
			return yardEvents.length;
		},
		auditSink: sink,
		verifyLocalSession(token) {
			return verifySessionToken({
				token,
				keys,
				expectedEnv: options.isolationClass,
			});
		},
		handoffSession(sessionId) {
			const session = sessions.get(sessionId);
			if (!session) {
				throw Object.assign(new Error(`PAM session ${sessionId} is not live`), {
					code: "pam-session-not-found",
				});
			}
			if (session.remoteId) {
				throw Object.assign(
					new Error("remote PAM sessions cannot be handed to a local adapter"),
					{ code: "pam-session-remote" },
				);
			}
			sessions.delete(sessionId);
			return session;
		},
		registerTarget(target) {
			if (target.isolationClass !== options.isolationClass) {
				throw Object.assign(
					new Error(
						`target ${target.id} isolation ${target.isolationClass} must match gateway ${options.isolationClass}`,
					),
					{ code: "pam-target-env-mismatch" },
				);
			}
			targets.set(target.id, Object.freeze({ ...target }));
		},
		async start(stationCtx) {
			if (stationCtx.isolationClass !== options.isolationClass) {
				throw Object.assign(
					new Error(
						`PAM gateway isolation class ${options.isolationClass} must match Station ${stationCtx.isolationClass}`,
					),
					{ code: "pam-env-mismatch" },
				);
			}
			ctx = stationCtx;
			running = true;
			await sink.append({
				type: "pam.GatewayStarted",
				time: now(),
				stationId: stationCtx.stationId,
				tenant: stationCtx.tenant,
				subject: "gateway",
				isolationClass: options.isolationClass,
				kind: options.kind,
			});
		},
		async stop() {
			// End all live sessions.
			for (const [id, session] of sessions) {
				if (remote && session.remoteId) {
					await remote.revokeSession(session.remoteId).catch(() => {});
				}
				await sink.append({
					type: "pam.SessionEnded",
					time: now(),
					stationId: ctx?.stationId ?? "unknown",
					tenant: ctx?.tenant ?? "unknown",
					sessionId: id,
					subject: session.sessionId,
					target: session.targetId,
					isolationClass: options.isolationClass,
					kind: options.kind,
					reason: "gateway-stop",
					credentialRef: session.credentialRef,
				});
			}
			sessions.clear();
			if (ctx) {
				await sink.append({
					type: "pam.GatewayStopped",
					time: now(),
					stationId: ctx.stationId,
					tenant: ctx.tenant,
					subject: "gateway",
					isolationClass: options.isolationClass,
					kind: options.kind,
				});
			}
			running = false;
			ctx = null;
		},
		async brokerSession(req) {
			if (!running || !ctx) {
				throw Object.assign(new Error("PAM gateway not started"), {
					code: "pam-not-running",
				});
			}
			if (req.preferSecretless !== true) {
				throw Object.assign(
					new Error("PAM requires preferSecretless: true (ADR-0027)"),
					{ code: "secretless-required" },
				);
			}

			const target = parseTarget(req.target, options.isolationClass);
			if (target.isolationClass !== options.isolationClass) {
				await sink.append({
					type: "pam.SessionDenied",
					time: now(),
					stationId: ctx.stationId,
					tenant: ctx.tenant,
					subject: req.subject,
					target: target.id,
					isolationClass: options.isolationClass,
					kind: options.kind,
					reason:
						"target isolation class mismatch — gateway cannot bridge envs",
				});
				throw Object.assign(
					new Error(
						"PAM cannot bridge isolation classes without CrossEnvGrant",
					),
					{ code: "cross-env-pam-denied" },
				);
			}
			// Known catalog targets optional but if registered must match.
			const catalog = targets.get(target.id);
			if (catalog && catalog.isolationClass !== options.isolationClass) {
				throw Object.assign(new Error("catalog target env mismatch"), {
					code: "pam-target-env-mismatch",
				});
			}

			try {
				await requireElevated(req);
			} catch (err) {
				await sink.append({
					type: "pam.SessionDenied",
					time: now(),
					stationId: ctx.stationId,
					tenant: ctx.tenant,
					subject: req.subject,
					target: target.id,
					isolationClass: options.isolationClass,
					kind: options.kind,
					reason: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}

			const ttl = req.ttlSeconds ?? 900;
			const sessionId = `pam_${options.kind}_${randomBytes(8).toString("hex")}`;
			const minted = mintSessionToken({
				keys,
				claims: {
					sid: sessionId,
					sub: req.subject,
					tgt: target.id,
					env: options.isolationClass,
					kind: options.kind,
					station: ctx.stationId,
					ttlSeconds: ttl,
					now: Math.floor(Date.parse(now()) / 1000),
				},
			});

			let handle: SessionHandle & { remoteId?: string } = Object.freeze({
				sessionId,
				expiresAt: new Date(Date.parse(now()) + ttl * 1000).toISOString(),
				credentialRef: minted.credentialRef,
				sessionToken: minted.token,
				auditStreamId: `audit:pam:${ctx.stationId}:${sessionId}`,
				isolationClass: options.isolationClass,
				kind: options.kind,
				targetId: target.id,
				protocol: frameSessionProtocol(options.kind),
			});

			// Optional remote control-plane authorization (full HTTP client).
			if (remote) {
				const remoteResult = await remote.authorizeSession({
					subject: req.subject,
					target: target.id,
					isolationClass: options.isolationClass,
					ttlSeconds: ttl,
					...(req.elevatedToken !== undefined
						? { elevatedToken: req.elevatedToken }
						: undefined),
					...(req.reason !== undefined ? { reason: req.reason } : undefined),
				});
				handle = Object.freeze({
					...mergeRemoteIntoHandle({
						local: handle,
						remote: remoteResult,
					}),
					remoteId: remoteResult.remoteSessionId,
					// Bind remote authorization into session token envelope without storing password.
					sessionToken: `${minted.token}~remote:${remoteResult.authorization.slice(0, 64)}`,
				});
			}

			sessions.set(sessionId, handle);
			await sink.append({
				type: "pam.SessionStarted",
				time: now(),
				stationId: ctx.stationId,
				tenant: ctx.tenant,
				sessionId,
				subject: req.subject,
				target: target.id,
				isolationClass: options.isolationClass,
				kind: options.kind,
				credentialRef: handle.credentialRef,
				...(req.reason !== undefined ? { reason: req.reason } : undefined),
			});
			return handle;
		},
		async renewSession(sessionId, ttlSeconds = 900) {
			if (!running || !ctx) {
				throw Object.assign(new Error("PAM gateway not started"), {
					code: "pam-not-running",
				});
			}
			const prev = sessions.get(sessionId);
			if (!prev) {
				throw Object.assign(new Error("session not found"), {
					code: "session-missing",
				});
			}
			const verified = verifySessionToken({
				token: prev.sessionToken.split("~")[0] ?? prev.sessionToken,
				keys,
			});
			if (!verified.ok) {
				throw Object.assign(new Error(verified.reason), {
					code: verified.code,
				});
			}
			const renewedMint = mintSessionToken({
				keys,
				claims: {
					sid: sessionId,
					sub: verified.claims.sub,
					tgt: verified.claims.tgt,
					env: options.isolationClass,
					kind: options.kind,
					station: ctx.stationId,
					ttlSeconds,
					now: Math.floor(Date.parse(now()) / 1000),
				},
			});
			const handle: SessionHandle = Object.freeze({
				...prev,
				expiresAt: new Date(
					Date.parse(now()) + ttlSeconds * 1000,
				).toISOString(),
				sessionToken: renewedMint.token,
				credentialRef: renewedMint.credentialRef,
			});
			sessions.set(sessionId, handle);
			await sink.append({
				type: "pam.SessionRenewed",
				time: now(),
				stationId: ctx.stationId,
				tenant: ctx.tenant,
				sessionId,
				subject: verified.claims.sub,
				target: prev.targetId,
				isolationClass: options.isolationClass,
				kind: options.kind,
				credentialRef: handle.credentialRef,
			});
			return handle;
		},
		async endSession(sessionId, reason) {
			const prev = sessions.get(sessionId);
			if (!prev) return;
			if (remote && prev.remoteId) {
				await remote.revokeSession(prev.remoteId).catch(() => {});
			}
			sessions.delete(sessionId);
			const verified = verifySessionToken({
				token: prev.sessionToken.split("~")[0] ?? prev.sessionToken,
				keys,
			});
			await sink.append({
				type: "pam.SessionEnded",
				time: now(),
				stationId: ctx?.stationId ?? "unknown",
				tenant: ctx?.tenant ?? "unknown",
				sessionId,
				subject: verified.ok ? verified.claims.sub : "unknown",
				target: prev.targetId,
				isolationClass: options.isolationClass,
				kind: options.kind,
				credentialRef: prev.credentialRef,
				...(reason !== undefined ? { reason } : undefined),
			});
		},
		listSessions() {
			return Object.freeze([...sessions.values()]);
		},
	};
}

export function createNativePamGateway(
	options: Omit<CreatePrivilegedAccessGatewayOptions, "kind">,
): PrivilegedAccessGatewayHandle {
	return createPrivilegedAccessGateway({ ...options, kind: "native" });
}

export function createTeleportPamGateway(
	options: Omit<CreatePrivilegedAccessGatewayOptions, "kind">,
): PrivilegedAccessGatewayHandle {
	return createPrivilegedAccessGateway({ ...options, kind: "teleport" });
}

export function createBoundaryPamGateway(
	options: Omit<CreatePrivilegedAccessGatewayOptions, "kind">,
): PrivilegedAccessGatewayHandle {
	return createPrivilegedAccessGateway({ ...options, kind: "boundary" });
}

export function createJumpServerPamGateway(
	options: Omit<CreatePrivilegedAccessGatewayOptions, "kind">,
): PrivilegedAccessGatewayHandle {
	return createPrivilegedAccessGateway({ ...options, kind: "jumpserver" });
}

export function railEnablesPam(
	policyPacks: readonly string[],
	metadata?: Readonly<Record<string, string>>,
): boolean {
	if (metadata?.privilegedAccessGateway === "true") return true;
	if (policyPacks.includes("capability:privileged-access-gateway")) return true;
	if (policyPacks.some((p) => p.includes("privileged-access"))) return true;
	return false;
}
