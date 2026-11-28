import { timingSafeEqual } from "node:crypto";
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import type { JsonValue } from "@hobo/core";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import {
	AuthOnboarding,
	AuthOnboardingHandlers,
	AuthSessionId,
	type AuthSessionMiddleware,
	type BetterAuthIssuerPort,
	BoxId,
	type NonEmptyReason,
	NonEmptyReason as NonEmptyReasonSchema,
	type OwnerVaultPort,
	PrincipalId,
	SessionHandleDigest,
	SigningKeyFingerprint,
	WorkspaceAuthId,
} from "../domain/index.js";

export type OwnerVaultPortService = Layer.Success<
	ReturnType<typeof OwnerVaultPort.toLayer>
>;

export type BetterAuthIssuerPortService = Layer.Success<
	ReturnType<typeof BetterAuthIssuerPort.toLayer>
>;

export interface AuthOnboardingRivetHostOptions<
	PoolReq,
	VaultErr,
	VaultReq,
	IssuerErr,
	IssuerReq,
	MiddlewareErr,
	MiddlewareReq,
> {
	readonly name?: string;
	readonly main: string;
	readonly handler?: string;
	readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
	readonly vaultPort: Layer.Layer<OwnerVaultPortService, VaultErr, VaultReq>;
	readonly issuerPort: Layer.Layer<
		BetterAuthIssuerPortService,
		IssuerErr,
		IssuerReq
	>;
	readonly sessionMiddleware: Layer.Layer<
		AuthSessionMiddleware,
		MiddlewareErr,
		MiddlewareReq
	>;
}

export function createAuthOnboardingRivetLayer<
	PoolReq,
	VaultErr,
	VaultReq,
	IssuerErr,
	IssuerReq,
	MiddlewareErr,
	MiddlewareReq,
>(
	options: AuthOnboardingRivetHostOptions<
		PoolReq,
		VaultErr,
		VaultReq,
		IssuerErr,
		IssuerReq,
		MiddlewareErr,
		MiddlewareReq
	>,
) {
	const rivetPlatform = DomainRivet.layerDurableObjects<PoolReq>({
		name: options.name ?? "AuthOnboarding",
		main: options.main,
		handler: options.handler ?? "default",
		pool: options.pool,
	});
	const modelLayer = AuthOnboarding.layer(AuthOnboardingHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(rivetPlatform, options.vaultPort, options.issuerPort),
		),
	);
	return Layer.mergeAll(modelLayer, options.sessionMiddleware);
}

const CoordinatorStatusSchema = Schema.Literals([
	"active",
	"revoked",
	"expired",
]);
export type CoordinatedSessionStatus = typeof CoordinatorStatusSchema.Type;

const SessionRowSchema = Schema.Struct({
	session_id: Schema.NonEmptyString,
	workspace_id: Schema.NonEmptyString,
	principal_id: Schema.NonEmptyString,
	handle_digest: Schema.NonEmptyString,
	signing_key_fingerprint: Schema.NonEmptyString,
	observed_boxes_json: Schema.NonEmptyString,
	allow_cross_box: Schema.Int,
	status: CoordinatorStatusSchema,
	reason: Schema.NullOr(Schema.String),
	issued_at_ms: Schema.Int,
	last_resumed_at_ms: Schema.Int,
	expires_at_ms: Schema.Int,
});

const decodeSessionRows = Schema.decodeUnknownSync(
	Schema.Array(SessionRowSchema),
);
const decodeBoxArray = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
);

export interface CoordinatedSessionRecord {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly principalId: string;
	readonly handleDigest: string;
	readonly signingKeyFingerprint: string;
	readonly observedBoxes: readonly string[];
	readonly allowCrossBox: boolean;
	readonly status: CoordinatedSessionStatus;
	readonly reason: string | null;
	readonly issuedAtMs: number;
	readonly lastResumedAtMs: number;
	readonly expiresAtMs: number;
}

export interface CoordinatedSessionEvent {
	readonly action: "registered" | "resumed" | "revoked" | "expired";
	readonly session: CoordinatedSessionRecord;
}

const RegisterSessionInputSchema = Schema.Struct({
	sessionId: AuthSessionId,
	workspaceId: WorkspaceAuthId,
	principalId: PrincipalId,
	handleDigest: SessionHandleDigest,
	signingKeyFingerprint: SigningKeyFingerprint,
	boxId: BoxId,
	allowCrossBox: Schema.Boolean,
	ttlMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)),
});
const decodeRegisterSessionInput = Schema.decodeUnknownSync(
	RegisterSessionInputSchema,
);

const ResumeSessionInputSchema = Schema.Struct({
	sessionId: AuthSessionId,
	boxId: BoxId,
	signingKeyFingerprint: SigningKeyFingerprint,
});
const decodeResumeSessionInput = Schema.decodeUnknownSync(
	ResumeSessionInputSchema,
);

const RevokeSessionInputSchema = Schema.Struct({
	sessionId: AuthSessionId,
	reason: NonEmptyReasonSchema,
});
const decodeRevokeSessionInput = Schema.decodeUnknownSync(
	RevokeSessionInputSchema,
);

export interface RegisterCoordinatedSessionInput {
	readonly sessionId: AuthSessionId;
	readonly workspaceId: WorkspaceAuthId;
	readonly principalId: PrincipalId;
	readonly handleDigest: SessionHandleDigest;
	readonly signingKeyFingerprint: SigningKeyFingerprint;
	readonly boxId: BoxId;
	readonly allowCrossBox: boolean;
	readonly ttlMs: number;
}

export interface ResumeCoordinatedSessionInput {
	readonly sessionId: AuthSessionId;
	readonly boxId: BoxId;
	readonly signingKeyFingerprint: SigningKeyFingerprint;
}

export interface RevokeCoordinatedSessionInput {
	readonly sessionId: AuthSessionId;
	readonly reason: NonEmptyReason;
}

export interface ResumeCoordinatedSessionResult {
	readonly resumed: boolean;
	readonly reason?: string;
	readonly session: CoordinatedSessionRecord | null;
}

export interface ExpireCoordinatedSessionResult {
	readonly expired: boolean;
	readonly sessionId: string;
}

function toSessionRecord(
	row: typeof SessionRowSchema.Type,
): CoordinatedSessionRecord {
	return {
		sessionId: row.session_id,
		workspaceId: row.workspace_id,
		principalId: row.principal_id,
		handleDigest: row.handle_digest,
		signingKeyFingerprint: row.signing_key_fingerprint,
		observedBoxes: decodeBoxArray(row.observed_boxes_json),
		allowCrossBox: row.allow_cross_box === 1,
		status: row.status,
		reason: row.reason,
		issuedAtMs: row.issued_at_ms,
		lastResumedAtMs: row.last_resumed_at_ms,
		expiresAtMs: row.expires_at_ms,
	};
}

export interface AuthSessionCoordinatorRegistryOptions {
	readonly endpoint?: string;
	readonly token?: string;
	readonly httpHost?: string;
	readonly httpPort?: number;
	readonly startEngine?: boolean;
	readonly noWelcome?: boolean;
	readonly shutdown?: {
		readonly gracePeriodMs?: number;
		readonly disableSignalHandlers?: boolean;
	};
}

export function createAuthSessionCoordinatorRegistry(
	options: AuthSessionCoordinatorRegistryOptions = {},
) {
	const authSessionCoordinator = actor({
		db: db({
			onMigrate: async (client) => {
				await client.execute(`
					CREATE TABLE IF NOT EXISTS hobo_auth_sessions (
						session_id TEXT PRIMARY KEY,
						workspace_id TEXT NOT NULL,
						principal_id TEXT NOT NULL,
						handle_digest TEXT NOT NULL,
						signing_key_fingerprint TEXT NOT NULL,
						observed_boxes_json TEXT NOT NULL,
						allow_cross_box INTEGER NOT NULL,
						status TEXT NOT NULL,
						reason TEXT,
						issued_at_ms INTEGER NOT NULL,
						last_resumed_at_ms INTEGER NOT NULL,
						expires_at_ms INTEGER NOT NULL
					)
				`);
			},
		}),
		actions: {
			registerSession: async (
				c,
				raw: JsonValue,
			): Promise<CoordinatedSessionRecord> => {
				const input = decodeRegisterSessionInput(raw);
				const existingRows = decodeSessionRows(
					await c.db.execute(
						"SELECT session_id, workspace_id, principal_id, handle_digest, signing_key_fingerprint, observed_boxes_json, allow_cross_box, status, reason, issued_at_ms, last_resumed_at_ms, expires_at_ms FROM hobo_auth_sessions WHERE session_id = ?",
						input.sessionId,
					),
				);
				const existing = existingRows[0];
				if (existing !== undefined) {
					if (
						existing.workspace_id !== input.workspaceId ||
						existing.principal_id !== input.principalId ||
						existing.handle_digest !== input.handleDigest ||
						existing.signing_key_fingerprint !== input.signingKeyFingerprint
					) {
						throw new Error(
							`session ${input.sessionId} already registered with conflicting identity`,
						);
					}
					return toSessionRecord(existing);
				}

				const nowMs = Date.now();
				const ttlMs = Math.max(20, Math.trunc(input.ttlMs));
				const expiresAtMs = nowMs + ttlMs;
				const boxes = [input.boxId];
				await c.db.execute(
					`INSERT INTO hobo_auth_sessions
						(session_id, workspace_id, principal_id, handle_digest, signing_key_fingerprint, observed_boxes_json, allow_cross_box, status, reason, issued_at_ms, last_resumed_at_ms, expires_at_ms)
					VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
					input.sessionId,
					input.workspaceId,
					input.principalId,
					input.handleDigest,
					input.signingKeyFingerprint,
					JSON.stringify(boxes),
					input.allowCrossBox ? 1 : 0,
					nowMs,
					nowMs,
					expiresAtMs,
				);
				const record: CoordinatedSessionRecord = {
					sessionId: input.sessionId,
					workspaceId: input.workspaceId,
					principalId: input.principalId,
					handleDigest: input.handleDigest,
					signingKeyFingerprint: input.signingKeyFingerprint,
					observedBoxes: boxes,
					allowCrossBox: input.allowCrossBox,
					status: "active",
					reason: null,
					issuedAtMs: nowMs,
					lastResumedAtMs: nowMs,
					expiresAtMs,
				};
				await c.schedule.after(ttlMs, "expireSession", input.sessionId);
				c.broadcast("sessionUpdated", {
					action: "registered",
					session: record,
				});
				return record;
			},
			resumeSession: async (
				c,
				raw: JsonValue,
			): Promise<ResumeCoordinatedSessionResult> => {
				const input = decodeResumeSessionInput(raw);
				const rows = decodeSessionRows(
					await c.db.execute(
						"SELECT session_id, workspace_id, principal_id, handle_digest, signing_key_fingerprint, observed_boxes_json, allow_cross_box, status, reason, issued_at_ms, last_resumed_at_ms, expires_at_ms FROM hobo_auth_sessions WHERE session_id = ?",
						input.sessionId,
					),
				);
				const existing = rows[0];
				if (existing === undefined) {
					return { resumed: false, reason: "not-found", session: null };
				}
				const record = toSessionRecord(existing);
				if (record.status !== "active") {
					return {
						resumed: false,
						reason: `session-${record.status}`,
						session: null,
					};
				}
				const nowMs = Date.now();
				if (nowMs >= record.expiresAtMs) {
					await c.db.execute(
						"UPDATE hobo_auth_sessions SET status = 'expired', reason = 'session-ttl-elapsed' WHERE session_id = ? AND status = 'active'",
						input.sessionId,
					);
					const expired: CoordinatedSessionRecord = {
						...record,
						status: "expired",
						reason: "session-ttl-elapsed",
					};
					c.broadcast("sessionUpdated", {
						action: "expired",
						session: expired,
					});
					return {
						resumed: false,
						reason: "session-expired",
						session: null,
					};
				}
				const expectedFp = Buffer.from(record.signingKeyFingerprint, "utf8");
				const providedFp = Buffer.from(input.signingKeyFingerprint, "utf8");
				if (
					expectedFp.length !== providedFp.length ||
					!timingSafeEqual(expectedFp, providedFp)
				) {
					return {
						resumed: false,
						reason: "signing-key-fingerprint-mismatch",
						session: null,
					};
				}
				const knownBox = record.observedBoxes.includes(input.boxId);
				if (!knownBox && !record.allowCrossBox) {
					return {
						resumed: false,
						reason: "cross-box-disallowed",
						session: null,
					};
				}
				const nextBoxes = knownBox
					? record.observedBoxes
					: [...record.observedBoxes, input.boxId];
				await c.db.execute(
					"UPDATE hobo_auth_sessions SET observed_boxes_json = ?, last_resumed_at_ms = ? WHERE session_id = ? AND status = 'active'",
					JSON.stringify(nextBoxes),
					nowMs,
					input.sessionId,
				);
				const updated: CoordinatedSessionRecord = {
					...record,
					observedBoxes: nextBoxes,
					lastResumedAtMs: nowMs,
				};
				c.broadcast("sessionUpdated", {
					action: "resumed",
					session: updated,
				});
				return { resumed: true, session: updated };
			},
			revokeSession: async (
				c,
				raw: JsonValue,
			): Promise<CoordinatedSessionRecord | null> => {
				const input = decodeRevokeSessionInput(raw);
				const rows = decodeSessionRows(
					await c.db.execute(
						"SELECT session_id, workspace_id, principal_id, handle_digest, signing_key_fingerprint, observed_boxes_json, allow_cross_box, status, reason, issued_at_ms, last_resumed_at_ms, expires_at_ms FROM hobo_auth_sessions WHERE session_id = ?",
						input.sessionId,
					),
				);
				const existing = rows[0];
				if (existing === undefined) return null;
				const record = toSessionRecord(existing);
				if (record.status !== "active") return record;
				await c.db.execute(
					"UPDATE hobo_auth_sessions SET status = 'revoked', reason = ? WHERE session_id = ? AND status = 'active'",
					input.reason,
					input.sessionId,
				);
				const revoked: CoordinatedSessionRecord = {
					...record,
					status: "revoked",
					reason: input.reason,
				};
				c.broadcast("sessionUpdated", {
					action: "revoked",
					session: revoked,
				});
				return revoked;
			},
			expireSession: async (
				c,
				sessionId: string,
			): Promise<ExpireCoordinatedSessionResult> => {
				const rows = decodeSessionRows(
					await c.db.execute(
						"SELECT session_id, workspace_id, principal_id, handle_digest, signing_key_fingerprint, observed_boxes_json, allow_cross_box, status, reason, issued_at_ms, last_resumed_at_ms, expires_at_ms FROM hobo_auth_sessions WHERE session_id = ?",
						sessionId,
					),
				);
				const existing = rows[0];
				if (existing === undefined || existing.status !== "active") {
					return { expired: false, sessionId };
				}
				if (Date.now() < existing.expires_at_ms) {
					return { expired: false, sessionId };
				}
				await c.db.execute(
					"UPDATE hobo_auth_sessions SET status = 'expired', reason = 'session-ttl-elapsed' WHERE session_id = ? AND status = 'active'",
					sessionId,
				);
				const expiredRecord: CoordinatedSessionRecord = {
					...toSessionRecord(existing),
					status: "expired",
					reason: "session-ttl-elapsed",
				};
				c.broadcast("sessionUpdated", {
					action: "expired",
					session: expiredRecord,
				});
				return { expired: true, sessionId };
			},
			listSessions: async (c): Promise<readonly CoordinatedSessionRecord[]> => {
				const rows = decodeSessionRows(
					await c.db.execute(
						"SELECT session_id, workspace_id, principal_id, handle_digest, signing_key_fingerprint, observed_boxes_json, allow_cross_box, status, reason, issued_at_ms, last_resumed_at_ms, expires_at_ms FROM hobo_auth_sessions ORDER BY issued_at_ms ASC, session_id ASC",
					),
				);
				return rows.map(toSessionRecord);
			},
		},
	});

	return setup({
		use: {
			authSessionCoordinator,
		},
		...(options.endpoint !== undefined
			? { endpoint: options.endpoint }
			: undefined),
		...(options.token !== undefined ? { token: options.token } : undefined),
		...(options.httpHost !== undefined
			? { httpHost: options.httpHost }
			: undefined),
		...(options.httpPort !== undefined
			? { httpPort: options.httpPort }
			: undefined),
		...(options.startEngine !== undefined
			? { startEngine: options.startEngine }
			: undefined),
		...(options.noWelcome !== undefined
			? { noWelcome: options.noWelcome }
			: undefined),
		...(options.shutdown !== undefined
			? { shutdown: options.shutdown }
			: undefined),
	});
}
