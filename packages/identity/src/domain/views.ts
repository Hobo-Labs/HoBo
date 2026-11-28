import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AuthSession } from "./AuthSession.aggregate.js";
import { AuthWorkspace } from "./AuthWorkspace.aggregate.js";
import {
	CurrentAuthActor,
	NotWorkspaceOwner,
	requireWorkspaceOwner,
} from "./CurrentActor.context.js";
import {
	AlchemyProfileName,
	AlchemyStageName,
	AuthBasePath,
	BetterAuthStorageKind,
	BoxId,
	EpochMs,
	IssuerOrigin,
	NonEmptyReason,
	OwnerKeyLocator,
	PrincipalId,
	SessionHandleDigest,
	SigningKeyFingerprint,
	UniqueBoxList,
	VaultProviderKind,
	WorkspaceAuthId,
} from "./ids.js";
import { AuthSessionMiddleware } from "./Session.middleware.js";

export const WorkspaceOnboardingState = Schema.Union([
	Schema.TaggedStruct("Uninitialized", {}),
	Schema.TaggedStruct("VaultConfigured", {
		ownerPrincipalId: PrincipalId,
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
		vaultProvider: VaultProviderKind,
		signingKeyLocator: OwnerKeyLocator,
		authorizedBoxes: UniqueBoxList,
	}),
	Schema.TaggedStruct("ProvisioningIssuer", {
		ownerPrincipalId: PrincipalId,
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
		vaultProvider: VaultProviderKind,
		signingKeyLocator: OwnerKeyLocator,
		issuerOrigin: IssuerOrigin,
		basePath: AuthBasePath,
		storageKind: BetterAuthStorageKind,
		authorizedBoxes: UniqueBoxList,
	}),
	Schema.TaggedStruct("Ready", {
		ownerPrincipalId: PrincipalId,
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
		vaultProvider: VaultProviderKind,
		signingKeyLocator: OwnerKeyLocator,
		issuerOrigin: IssuerOrigin,
		basePath: AuthBasePath,
		storageKind: BetterAuthStorageKind,
		signingKeyFingerprint: SigningKeyFingerprint,
		reusableAcrossBoxes: Schema.Boolean,
		authorizedBoxes: UniqueBoxList,
	}),
	Schema.TaggedStruct("Suspended", {
		ownerPrincipalId: PrincipalId,
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
		vaultProvider: VaultProviderKind,
		signingKeyLocator: OwnerKeyLocator,
		issuerOrigin: IssuerOrigin,
		basePath: AuthBasePath,
		storageKind: BetterAuthStorageKind,
		authorizedBoxes: UniqueBoxList,
		reason: NonEmptyReason,
	}),
]);
export type WorkspaceOnboardingState = typeof WorkspaceOnboardingState.Type;

export class WorkspaceOnboardingView extends Domain.View(
	"WorkspaceOnboardingView",
	{
		from: [AuthWorkspace],
		key: AuthWorkspace,
		middleware: [AuthSessionMiddleware],
		rejects: [NotWorkspaceOwner],
		state: WorkspaceOnboardingState,
		initial: { _tag: "Uninitialized" },
		evolve: {
			OnboardingStarted: (_state, event) => ({
				_tag: "VaultConfigured" as const,
				ownerPrincipalId: event.ownerPrincipalId,
				profileName: event.profileName,
				stage: event.stage,
				vaultProvider: event.vaultProvider,
				signingKeyLocator: event.signingKeyLocator,
				authorizedBoxes: UniqueBoxList.make([event.initialBoxId]),
			}),
			BetterAuthIssuerConfigured: (state, event) => {
				if (state._tag === "Uninitialized") return state;
				return {
					_tag: "ProvisioningIssuer" as const,
					ownerPrincipalId: state.ownerPrincipalId,
					profileName: event.profileName,
					stage: event.stage,
					vaultProvider: event.vaultProvider,
					signingKeyLocator: event.signingKeyLocator,
					issuerOrigin: event.issuerOrigin,
					basePath: event.basePath,
					storageKind: event.storageKind,
					authorizedBoxes: state.authorizedBoxes,
				};
			},
			IssuerBootstrapCompleted: (state, event) => {
				if (state._tag !== "ProvisioningIssuer") return state;
				return {
					_tag: "Ready" as const,
					ownerPrincipalId: state.ownerPrincipalId,
					profileName: state.profileName,
					stage: state.stage,
					vaultProvider: state.vaultProvider,
					signingKeyLocator: state.signingKeyLocator,
					issuerOrigin: state.issuerOrigin,
					basePath: state.basePath,
					storageKind: state.storageKind,
					signingKeyFingerprint: event.signingKeyFingerprint,
					reusableAcrossBoxes: event.reusableAcrossBoxes,
					authorizedBoxes: state.authorizedBoxes,
				};
			},
			IssuerBootstrapFailedEvent: (state, event) => {
				if (state._tag !== "ProvisioningIssuer") return state;
				return {
					_tag: "Suspended" as const,
					ownerPrincipalId: state.ownerPrincipalId,
					profileName: state.profileName,
					stage: state.stage,
					vaultProvider: state.vaultProvider,
					signingKeyLocator: state.signingKeyLocator,
					issuerOrigin: state.issuerOrigin,
					basePath: state.basePath,
					storageKind: state.storageKind,
					authorizedBoxes: state.authorizedBoxes,
					reason: event.reason,
				};
			},
			BoxAuthorized: (state, event) => {
				if (state._tag !== "Ready") return state;
				if (state.authorizedBoxes.includes(event.boxId)) return state;
				return {
					...state,
					authorizedBoxes: UniqueBoxList.make([
						...state.authorizedBoxes,
						event.boxId,
					]),
				};
			},
			SigningKeyRotated: (state, event) => {
				if (state._tag !== "Ready") return state;
				return {
					_tag: "ProvisioningIssuer" as const,
					ownerPrincipalId: state.ownerPrincipalId,
					profileName: state.profileName,
					stage: state.stage,
					vaultProvider: state.vaultProvider,
					signingKeyLocator: event.signingKeyLocator,
					issuerOrigin: state.issuerOrigin,
					basePath: state.basePath,
					storageKind: state.storageKind,
					authorizedBoxes: state.authorizedBoxes,
				};
			},
		},
	},
) {}

export const WorkspaceOnboardingViewLive = WorkspaceOnboardingView.toLayer(
	Effect.succeed(
		Effect.fn(function* (_request, view) {
			if (
				view === null ||
				view === undefined ||
				view._tag === "Uninitialized"
			) {
				const actor = yield* CurrentAuthActor;
				if (actor._tag === "System" || actor._tag === "Owner") {
					return;
				}
				return yield* new NotWorkspaceOwner({
					expectedOwner: null,
					caller: actor.principalId,
				});
			}
			yield* requireWorkspaceOwner(view.ownerPrincipalId);
		}),
	),
);

export const ActiveSessionViewState = Schema.Union([
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
export type ActiveSessionViewState = typeof ActiveSessionViewState.Type;

export class ActiveSessionView extends Domain.View("ActiveSessionView", {
	from: [AuthSession],
	key: AuthSession,
	middleware: [AuthSessionMiddleware],
	rejects: [NotWorkspaceOwner],
	state: ActiveSessionViewState,
	initial: { _tag: "Empty" },
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
			const observedBoxes = state.observedBoxes.includes(event.boxId)
				? state.observedBoxes
				: UniqueBoxList.make([...state.observedBoxes, event.boxId]);
			return {
				...state,
				observedBoxes,
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
}) {}

export const ActiveSessionViewLive = ActiveSessionView.toLayer(
	Effect.succeed(
		Effect.fn(function* (_request, view) {
			if (view === null || view === undefined || view._tag === "Empty") {
				const actor = yield* CurrentAuthActor;
				if (actor._tag === "System" || actor._tag === "Owner") {
					return;
				}
				return yield* new NotWorkspaceOwner({
					expectedOwner: null,
					caller: actor.principalId,
				});
			}
			yield* requireWorkspaceOwner(view.principalId);
		}),
	),
);
