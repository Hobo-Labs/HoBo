import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
	IssuerOrigin,
	NonEmptyReason,
	OwnerKeyLocator,
	PrincipalId,
	SigningKeyFingerprint,
	UniqueBoxList,
	VaultProviderKind,
	WorkspaceAuthId,
} from "./ids.js";
import { AuthSessionMiddleware } from "./Session.middleware.js";

export class WorkspaceAlreadyInitialized extends Domain.Rejection(
	"WorkspaceAlreadyInitialized",
	{
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
	},
) {}

export class WorkspaceNotInitialized extends Domain.Rejection(
	"WorkspaceNotInitialized",
	{
		phase: Schema.Literals(["uninitialized"]),
	},
) {}

export class WorkspaceNotProvisioning extends Domain.Rejection(
	"WorkspaceNotProvisioning",
	{
		phase: Schema.Literals([
			"uninitialized",
			"vault-configured",
			"ready",
			"suspended",
		]),
	},
) {}

export class WorkspaceNotReady extends Domain.Rejection("WorkspaceNotReady", {
	phase: Schema.Literals([
		"uninitialized",
		"vault-configured",
		"provisioning",
		"suspended",
	]),
}) {}

export class BoxAlreadyAuthorized extends Domain.Rejection(
	"BoxAlreadyAuthorized",
	{
		boxId: BoxId,
	},
) {}

export class OnboardingStarted extends Domain.Event("OnboardingStarted", {
	ownerPrincipalId: PrincipalId,
	profileName: AlchemyProfileName,
	stage: AlchemyStageName,
	vaultProvider: VaultProviderKind,
	signingKeyLocator: OwnerKeyLocator,
	initialBoxId: BoxId,
}) {}

export class BetterAuthIssuerConfigured extends Domain.Event(
	"BetterAuthIssuerConfigured",
	{
		ownerPrincipalId: PrincipalId,
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
		vaultProvider: VaultProviderKind,
		signingKeyLocator: OwnerKeyLocator,
		issuerOrigin: IssuerOrigin,
		basePath: AuthBasePath,
		storageKind: BetterAuthStorageKind,
	},
) {}

export class IssuerBootstrapCompleted extends Domain.Event(
	"IssuerBootstrapCompleted",
	{
		signingKeyFingerprint: SigningKeyFingerprint,
		reusableAcrossBoxes: Schema.Boolean,
	},
) {}

export class IssuerBootstrapFailedEvent extends Domain.Event(
	"IssuerBootstrapFailedEvent",
	{
		reason: NonEmptyReason,
	},
) {}

export class BoxAuthorized extends Domain.Event("BoxAuthorized", {
	boxId: BoxId,
}) {}

export class SigningKeyRotated extends Domain.Event("SigningKeyRotated", {
	ownerPrincipalId: PrincipalId,
	profileName: AlchemyProfileName,
	stage: AlchemyStageName,
	vaultProvider: VaultProviderKind,
	previousSigningKeyLocator: OwnerKeyLocator,
	signingKeyLocator: OwnerKeyLocator,
	issuerOrigin: IssuerOrigin,
	basePath: AuthBasePath,
	storageKind: BetterAuthStorageKind,
}) {}

export class BeginOnboarding extends Domain.Command("BeginOnboarding", {
	target: WorkspaceAuthId,
	input: {
		profileName: AlchemyProfileName,
		stage: AlchemyStageName,
		vaultProvider: VaultProviderKind,
		signingKeyLocator: OwnerKeyLocator,
		initialBoxId: BoxId,
	},
	events: [OnboardingStarted],
	middleware: [AuthSessionMiddleware],
	rejects: [WorkspaceAlreadyInitialized, NotWorkspaceOwner],
}) {}

export class ConfigureBetterAuthIssuer extends Domain.Command(
	"ConfigureBetterAuthIssuer",
	{
		target: WorkspaceAuthId,
		input: {
			issuerOrigin: IssuerOrigin,
			basePath: AuthBasePath,
			storageKind: BetterAuthStorageKind,
		},
		events: [BetterAuthIssuerConfigured],
		middleware: [AuthSessionMiddleware],
		rejects: [WorkspaceNotInitialized, NotWorkspaceOwner],
	},
) {}

export class CompleteIssuerBootstrap extends Domain.Command(
	"CompleteIssuerBootstrap",
	{
		target: WorkspaceAuthId,
		input: {
			signingKeyFingerprint: SigningKeyFingerprint,
			reusableAcrossBoxes: Schema.Boolean,
		},
		events: [IssuerBootstrapCompleted],
		rejects: [WorkspaceNotProvisioning],
	},
) {}

export class FailIssuerBootstrap extends Domain.Command("FailIssuerBootstrap", {
	target: WorkspaceAuthId,
	input: {
		reason: NonEmptyReason,
	},
	events: [IssuerBootstrapFailedEvent],
	rejects: [WorkspaceNotProvisioning],
}) {}

export class AuthorizeBox extends Domain.Command("AuthorizeBox", {
	target: WorkspaceAuthId,
	input: {
		boxId: BoxId,
	},
	events: [BoxAuthorized],
	middleware: [AuthSessionMiddleware],
	rejects: [WorkspaceNotReady, BoxAlreadyAuthorized, NotWorkspaceOwner],
}) {}

export class RotateSigningKey extends Domain.Command("RotateSigningKey", {
	target: WorkspaceAuthId,
	input: {
		nextSigningKeyLocator: OwnerKeyLocator,
	},
	events: [SigningKeyRotated],
	middleware: [AuthSessionMiddleware],
	rejects: [WorkspaceNotReady, NotWorkspaceOwner],
}) {}

export const AuthWorkspaceState = Schema.Union([
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
export type AuthWorkspaceState = typeof AuthWorkspaceState.Type;

export class AuthWorkspace extends Domain.Aggregate(
	"AuthWorkspace",
	{
		id: WorkspaceAuthId,
		state: AuthWorkspaceState,
		initial: { _tag: "Uninitialized" },
		commands: [
			BeginOnboarding,
			ConfigureBetterAuthIssuer,
			CompleteIssuerBootstrap,
			FailIssuerBootstrap,
			AuthorizeBox,
			RotateSigningKey,
		],
		decide: {
			BeginOnboarding: Effect.fn(function* (state, cmd) {
				if (state._tag !== "Uninitialized") {
					return yield* new WorkspaceAlreadyInitialized({
						profileName: state.profileName,
						stage: state.stage,
					});
				}
				const actor = yield* CurrentAuthActor;
				if (actor._tag !== "Owner") {
					return yield* new NotWorkspaceOwner({
						expectedOwner: null,
						caller: actor._tag === "Agent" ? actor.principalId : null,
					});
				}
				return [
					new OnboardingStarted({
						ownerPrincipalId: actor.principalId,
						profileName: cmd.profileName,
						stage: cmd.stage,
						vaultProvider: cmd.vaultProvider,
						signingKeyLocator: cmd.signingKeyLocator,
						initialBoxId: cmd.initialBoxId,
					}),
				];
			}),
			ConfigureBetterAuthIssuer: Effect.fn(function* (state, cmd) {
				if (state._tag === "Uninitialized") {
					return yield* new WorkspaceNotInitialized({ phase: "uninitialized" });
				}
				yield* requireWorkspaceOwner(state.ownerPrincipalId);
				return [
					new BetterAuthIssuerConfigured({
						ownerPrincipalId: state.ownerPrincipalId,
						profileName: state.profileName,
						stage: state.stage,
						vaultProvider: state.vaultProvider,
						signingKeyLocator: state.signingKeyLocator,
						issuerOrigin: cmd.issuerOrigin,
						basePath: cmd.basePath,
						storageKind: cmd.storageKind,
					}),
				];
			}),
			CompleteIssuerBootstrap: (state, cmd) => {
				if (state._tag !== "ProvisioningIssuer") {
					return new WorkspaceNotProvisioning({
						phase:
							state._tag === "Uninitialized"
								? "uninitialized"
								: state._tag === "VaultConfigured"
									? "vault-configured"
									: state._tag === "Ready"
										? "ready"
										: "suspended",
					});
				}
				return [
					new IssuerBootstrapCompleted({
						signingKeyFingerprint: cmd.signingKeyFingerprint,
						reusableAcrossBoxes: cmd.reusableAcrossBoxes,
					}),
				];
			},
			FailIssuerBootstrap: (state, cmd) => {
				if (state._tag !== "ProvisioningIssuer") {
					return new WorkspaceNotProvisioning({
						phase:
							state._tag === "Uninitialized"
								? "uninitialized"
								: state._tag === "VaultConfigured"
									? "vault-configured"
									: state._tag === "Ready"
										? "ready"
										: "suspended",
					});
				}
				return [new IssuerBootstrapFailedEvent({ reason: cmd.reason })];
			},
			AuthorizeBox: Effect.fn(function* (state, cmd) {
				if (state._tag !== "Ready") {
					return yield* new WorkspaceNotReady({
						phase:
							state._tag === "Uninitialized"
								? "uninitialized"
								: state._tag === "VaultConfigured"
									? "vault-configured"
									: state._tag === "ProvisioningIssuer"
										? "provisioning"
										: "suspended",
					});
				}
				yield* requireWorkspaceOwner(state.ownerPrincipalId);
				if (state.authorizedBoxes.includes(cmd.boxId)) {
					return yield* new BoxAlreadyAuthorized({ boxId: cmd.boxId });
				}
				return [new BoxAuthorized({ boxId: cmd.boxId })];
			}),
			RotateSigningKey: Effect.fn(function* (state, cmd) {
				if (state._tag !== "Ready") {
					return yield* new WorkspaceNotReady({
						phase:
							state._tag === "Uninitialized"
								? "uninitialized"
								: state._tag === "VaultConfigured"
									? "vault-configured"
									: state._tag === "ProvisioningIssuer"
										? "provisioning"
										: "suspended",
					});
				}
				yield* requireWorkspaceOwner(state.ownerPrincipalId);
				return [
					new SigningKeyRotated({
						ownerPrincipalId: state.ownerPrincipalId,
						profileName: state.profileName,
						stage: state.stage,
						vaultProvider: state.vaultProvider,
						previousSigningKeyLocator: state.signingKeyLocator,
						signingKeyLocator: cmd.nextSigningKeyLocator,
						issuerOrigin: state.issuerOrigin,
						basePath: state.basePath,
						storageKind: state.storageKind,
					}),
				];
			}),
		},
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
	{
		description:
			"Auth workspace onboarding lifecycle binding an Alchemy profile, owner vault provider, Better Auth issuer, and authorized boxes without persisting raw secrets.",
	},
) {}
