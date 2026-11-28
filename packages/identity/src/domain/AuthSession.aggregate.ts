import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
	CurrentAuthActor,
	NotWorkspaceOwner,
	requireWorkspaceOwner,
} from "./CurrentActor.context.js";
import {
	AuthSessionId,
	BoxId,
	EpochMs,
	IssuerOrigin,
	NonEmptyReason,
	PrincipalId,
	SessionHandleDigest,
	SigningKeyFingerprint,
	TtlSeconds,
	UniqueBoxList,
	WorkspaceAuthId,
} from "./ids.js";
import { AuthSessionMiddleware } from "./Session.middleware.js";

export class AuthSessionAlreadyEstablished extends Domain.Rejection(
	"AuthSessionAlreadyEstablished",
	{
		handleDigest: SessionHandleDigest,
	},
) {}

export class AuthSessionNotFound extends Domain.Rejection(
	"AuthSessionNotFound",
	{
		phase: Schema.Literals(["empty"]),
	},
) {}

export class AuthSessionAlreadyRevoked extends Domain.Rejection(
	"AuthSessionAlreadyRevoked",
	{
		reason: NonEmptyReason,
	},
) {}

export class AuthSessionExpired extends Domain.Rejection("AuthSessionExpired", {
	expiredAtMs: EpochMs,
	observedAtMs: EpochMs,
}) {}

export class SigningKeyFingerprintMismatch extends Domain.Rejection(
	"SigningKeyFingerprintMismatch",
	{
		expected: SigningKeyFingerprint,
		provided: SigningKeyFingerprint,
	},
) {}

export class BoxNotAuthorizedForSession extends Domain.Rejection(
	"BoxNotAuthorizedForSession",
	{
		boxId: BoxId,
	},
) {}

export class AuthSessionEstablished extends Domain.Event(
	"AuthSessionEstablished",
	{
		workspaceId: WorkspaceAuthId,
		principalId: PrincipalId,
		issuerOrigin: IssuerOrigin,
		handleDigest: SessionHandleDigest,
		signingKeyFingerprint: SigningKeyFingerprint,
		boxId: BoxId,
		issuedAtMs: EpochMs,
		expiresAtMs: EpochMs,
		allowCrossBoxReuse: Schema.Boolean,
	},
) {}

export class AuthSessionResumed extends Domain.Event("AuthSessionResumed", {
	boxId: BoxId,
	resumedAtMs: EpochMs,
	crossBox: Schema.Boolean,
}) {}

export class AuthSessionRefreshed extends Domain.Event("AuthSessionRefreshed", {
	boxId: BoxId,
	handleDigest: SessionHandleDigest,
	refreshedAtMs: EpochMs,
	expiresAtMs: EpochMs,
}) {}

export class AuthSessionRevoked extends Domain.Event("AuthSessionRevoked", {
	workspaceId: WorkspaceAuthId,
	issuerOrigin: IssuerOrigin,
	handleDigest: SessionHandleDigest,
	revokedAtMs: EpochMs,
	reason: NonEmptyReason,
}) {}

export class EstablishAuthSession extends Domain.Command(
	"EstablishAuthSession",
	{
		target: AuthSessionId,
		input: {
			workspaceId: WorkspaceAuthId,
			issuerOrigin: IssuerOrigin,
			handleDigest: SessionHandleDigest,
			signingKeyFingerprint: SigningKeyFingerprint,
			boxId: BoxId,
			ttlSeconds: TtlSeconds,
			allowCrossBoxReuse: Schema.Boolean,
		},
		events: [AuthSessionEstablished],
		middleware: [AuthSessionMiddleware],
		rejects: [AuthSessionAlreadyEstablished, NotWorkspaceOwner],
	},
) {}

export class ResumeAuthSession extends Domain.Command("ResumeAuthSession", {
	target: AuthSessionId,
	input: {
		boxId: BoxId,
		signingKeyFingerprint: SigningKeyFingerprint,
		boxAuthorizedByWorkspace: Schema.Boolean,
	},
	events: [AuthSessionResumed],
	middleware: [AuthSessionMiddleware],
	rejects: [
		AuthSessionNotFound,
		AuthSessionAlreadyRevoked,
		AuthSessionExpired,
		SigningKeyFingerprintMismatch,
		BoxNotAuthorizedForSession,
		NotWorkspaceOwner,
	],
}) {}

export class RefreshAuthSession extends Domain.Command("RefreshAuthSession", {
	target: AuthSessionId,
	input: {
		boxId: BoxId,
		nextHandleDigest: SessionHandleDigest,
		signingKeyFingerprint: SigningKeyFingerprint,
		ttlSeconds: TtlSeconds,
	},
	events: [AuthSessionRefreshed],
	middleware: [AuthSessionMiddleware],
	rejects: [
		AuthSessionNotFound,
		AuthSessionAlreadyRevoked,
		AuthSessionExpired,
		SigningKeyFingerprintMismatch,
		BoxNotAuthorizedForSession,
		NotWorkspaceOwner,
	],
}) {}

export class RevokeAuthSession extends Domain.Command("RevokeAuthSession", {
	target: AuthSessionId,
	input: {
		reason: NonEmptyReason,
	},
	events: [AuthSessionRevoked],
	middleware: [AuthSessionMiddleware],
	rejects: [AuthSessionNotFound, AuthSessionAlreadyRevoked, NotWorkspaceOwner],
}) {}

export const AuthSessionState = Schema.Union([
	Schema.TaggedStruct("Empty", {}),
	Schema.TaggedStruct("Active", {
		workspaceId: WorkspaceAuthId,
		principalId: PrincipalId,
		issuerOrigin: IssuerOrigin,
		handleDigest: SessionHandleDigest,
		signingKeyFingerprint: SigningKeyFingerprint,
		originBoxId: BoxId,
		observedBoxes: UniqueBoxList,
		issuedAtMs: EpochMs,
		lastResumedAtMs: EpochMs,
		expiresAtMs: EpochMs,
		allowCrossBoxReuse: Schema.Boolean,
		resumeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	}),
	Schema.TaggedStruct("Revoked", {
		workspaceId: WorkspaceAuthId,
		principalId: PrincipalId,
		issuerOrigin: IssuerOrigin,
		handleDigest: SessionHandleDigest,
		revokedAtMs: EpochMs,
		reason: NonEmptyReason,
	}),
]);
export type AuthSessionState = typeof AuthSessionState.Type;

export class AuthSession extends Domain.Aggregate(
	"AuthSession",
	{
		id: AuthSessionId,
		state: AuthSessionState,
		initial: { _tag: "Empty" },
		commands: [
			EstablishAuthSession,
			ResumeAuthSession,
			RefreshAuthSession,
			RevokeAuthSession,
		],
		decide: {
			EstablishAuthSession: Effect.fn(function* (state, cmd, { now }) {
				if (state._tag !== "Empty") {
					return yield* new AuthSessionAlreadyEstablished({
						handleDigest: state.handleDigest,
					});
				}
				const actor = yield* CurrentAuthActor;
				if (actor._tag !== "Owner") {
					return yield* new NotWorkspaceOwner({
						expectedOwner: null,
						caller: actor._tag === "Agent" ? actor.principalId : null,
					});
				}
				const issuedAtMs = EpochMs.make(
					Math.trunc(DateTime.toEpochMillis(now)),
				);
				const expiresAtMs = EpochMs.make(issuedAtMs + cmd.ttlSeconds * 1000);
				return [
					new AuthSessionEstablished({
						workspaceId: cmd.workspaceId,
						principalId: actor.principalId,
						issuerOrigin: cmd.issuerOrigin,
						handleDigest: cmd.handleDigest,
						signingKeyFingerprint: cmd.signingKeyFingerprint,
						boxId: cmd.boxId,
						issuedAtMs,
						expiresAtMs,
						allowCrossBoxReuse: cmd.allowCrossBoxReuse,
					}),
				];
			}),
			ResumeAuthSession: Effect.fn(function* (state, cmd, { now }) {
				if (state._tag === "Empty") {
					return yield* new AuthSessionNotFound({ phase: "empty" });
				}
				if (state._tag === "Revoked") {
					return yield* new AuthSessionAlreadyRevoked({
						reason: state.reason,
					});
				}
				yield* requireWorkspaceOwner(state.principalId);
				const nowMs = EpochMs.make(Math.trunc(DateTime.toEpochMillis(now)));
				if (nowMs >= state.expiresAtMs) {
					return yield* new AuthSessionExpired({
						expiredAtMs: state.expiresAtMs,
						observedAtMs: nowMs,
					});
				}
				if (cmd.signingKeyFingerprint !== state.signingKeyFingerprint) {
					return yield* new SigningKeyFingerprintMismatch({
						expected: state.signingKeyFingerprint,
						provided: cmd.signingKeyFingerprint,
					});
				}
				const isKnownBox = state.observedBoxes.includes(cmd.boxId);
				if (
					!isKnownBox &&
					(!state.allowCrossBoxReuse || !cmd.boxAuthorizedByWorkspace)
				) {
					return yield* new BoxNotAuthorizedForSession({ boxId: cmd.boxId });
				}
				return [
					new AuthSessionResumed({
						boxId: cmd.boxId,
						resumedAtMs: nowMs,
						crossBox: cmd.boxId !== state.originBoxId,
					}),
				];
			}),
			RefreshAuthSession: Effect.fn(function* (state, cmd, { now }) {
				if (state._tag === "Empty") {
					return yield* new AuthSessionNotFound({ phase: "empty" });
				}
				if (state._tag === "Revoked") {
					return yield* new AuthSessionAlreadyRevoked({
						reason: state.reason,
					});
				}
				yield* requireWorkspaceOwner(state.principalId);
				const nowMs = EpochMs.make(Math.trunc(DateTime.toEpochMillis(now)));
				if (nowMs >= state.expiresAtMs) {
					return yield* new AuthSessionExpired({
						expiredAtMs: state.expiresAtMs,
						observedAtMs: nowMs,
					});
				}
				if (cmd.signingKeyFingerprint !== state.signingKeyFingerprint) {
					return yield* new SigningKeyFingerprintMismatch({
						expected: state.signingKeyFingerprint,
						provided: cmd.signingKeyFingerprint,
					});
				}
				if (!state.observedBoxes.includes(cmd.boxId)) {
					return yield* new BoxNotAuthorizedForSession({ boxId: cmd.boxId });
				}
				const expiresAtMs = EpochMs.make(nowMs + cmd.ttlSeconds * 1000);
				return [
					new AuthSessionRefreshed({
						boxId: cmd.boxId,
						handleDigest: cmd.nextHandleDigest,
						refreshedAtMs: nowMs,
						expiresAtMs,
					}),
				];
			}),
			RevokeAuthSession: Effect.fn(function* (state, cmd, { now }) {
				if (state._tag === "Empty") {
					return yield* new AuthSessionNotFound({ phase: "empty" });
				}
				if (state._tag === "Revoked") {
					return yield* new AuthSessionAlreadyRevoked({
						reason: state.reason,
					});
				}
				yield* requireWorkspaceOwner(state.principalId);
				const revokedAtMs = EpochMs.make(
					Math.trunc(DateTime.toEpochMillis(now)),
				);
				return [
					new AuthSessionRevoked({
						workspaceId: state.workspaceId,
						issuerOrigin: state.issuerOrigin,
						handleDigest: state.handleDigest,
						revokedAtMs,
						reason: cmd.reason,
					}),
				];
			}),
		},
		evolve: {
			AuthSessionEstablished: (_state, event) => ({
				_tag: "Active" as const,
				workspaceId: event.workspaceId,
				principalId: event.principalId,
				issuerOrigin: event.issuerOrigin,
				handleDigest: event.handleDigest,
				signingKeyFingerprint: event.signingKeyFingerprint,
				originBoxId: event.boxId,
				observedBoxes: UniqueBoxList.make([event.boxId]),
				issuedAtMs: event.issuedAtMs,
				lastResumedAtMs: event.issuedAtMs,
				expiresAtMs: event.expiresAtMs,
				allowCrossBoxReuse: event.allowCrossBoxReuse,
				resumeCount: 0,
			}),
			AuthSessionResumed: (state, event) => {
				if (state._tag !== "Active") return state;
				const nextBoxes = state.observedBoxes.includes(event.boxId)
					? state.observedBoxes
					: UniqueBoxList.make([...state.observedBoxes, event.boxId]);
				return {
					...state,
					observedBoxes: nextBoxes,
					lastResumedAtMs: event.resumedAtMs,
					resumeCount: state.resumeCount + 1,
				};
			},
			AuthSessionRefreshed: (state, event) => {
				if (state._tag !== "Active") return state;
				return {
					...state,
					handleDigest: event.handleDigest,
					lastResumedAtMs: event.refreshedAtMs,
					expiresAtMs: event.expiresAtMs,
				};
			},
			AuthSessionRevoked: (state, event) => {
				if (state._tag !== "Active") return state;
				return {
					_tag: "Revoked" as const,
					workspaceId: state.workspaceId,
					principalId: state.principalId,
					issuerOrigin: state.issuerOrigin,
					handleDigest: state.handleDigest,
					revokedAtMs: event.revokedAtMs,
					reason: event.reason,
				};
			},
		},
	},
	{
		description:
			"Reusable Better Auth session lifecycle supporting same-box restarts, cross-box authorization, deterministic expiry, key-rotation mismatch detection, and revocation.",
	},
) {}
