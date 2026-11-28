import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
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
	SessionHandleDigest,
	SigningKeyFingerprint,
	VaultProviderKind,
	WorkspaceAuthId,
} from "./ids.js";

export class VaultAccessDenied extends Domain.Rejection("VaultAccessDenied", {
	vaultProvider: VaultProviderKind,
	signingKeyLocator: OwnerKeyLocator,
	reason: NonEmptyReason,
}) {}

export class IssuerBootstrapFailed extends Domain.Rejection(
	"IssuerBootstrapFailed",
	{
		issuerOrigin: IssuerOrigin,
		reason: NonEmptyReason,
	},
) {}

export class IssuerSessionInvalid extends Domain.Rejection(
	"IssuerSessionInvalid",
	{
		handleDigest: SessionHandleDigest,
		reason: NonEmptyReason,
	},
) {}

export class OwnerVaultPort extends Domain.ExternalSystem("OwnerVaultPort", {
	verifyKeyLocator: {
		args: {
			workspaceId: WorkspaceAuthId,
			vaultProvider: VaultProviderKind,
			profileName: AlchemyProfileName,
			stage: AlchemyStageName,
			signingKeyLocator: OwnerKeyLocator,
		},
		success: {
			signingKeyFingerprint: SigningKeyFingerprint,
			reusableAcrossBoxes: Schema.Boolean,
		},
		error: [VaultAccessDenied],
	},
	invalidateCachedAccess: {
		args: {
			workspaceId: WorkspaceAuthId,
			vaultProvider: VaultProviderKind,
			profileName: AlchemyProfileName,
			stage: AlchemyStageName,
		},
		success: {
			invalidated: Schema.Boolean,
		},
		error: [VaultAccessDenied],
	},
}) {}

export class BetterAuthIssuerPort extends Domain.ExternalSystem(
	"BetterAuthIssuerPort",
	{
		bootstrapIssuer: {
			args: {
				workspaceId: WorkspaceAuthId,
				issuerOrigin: IssuerOrigin,
				basePath: AuthBasePath,
				storageKind: BetterAuthStorageKind,
				signingKeyLocator: OwnerKeyLocator,
				signingKeyFingerprint: SigningKeyFingerprint,
			},
			success: {
				migrationsApplied: Schema.Boolean,
				signingKeyFingerprint: SigningKeyFingerprint,
			},
			error: [IssuerBootstrapFailed],
		},
		verifySessionHandle: {
			args: {
				workspaceId: WorkspaceAuthId,
				issuerOrigin: IssuerOrigin,
				handleDigest: SessionHandleDigest,
				boxId: BoxId,
				expectedSigningKeyFingerprint: SigningKeyFingerprint,
			},
			success: {
				active: Schema.Boolean,
				principalId: PrincipalId,
			},
			error: [IssuerSessionInvalid],
		},
		revokeSessionHandle: {
			args: {
				workspaceId: WorkspaceAuthId,
				issuerOrigin: IssuerOrigin,
				handleDigest: SessionHandleDigest,
				reason: NonEmptyReason,
			},
			success: {
				revoked: Schema.Boolean,
			},
			error: [IssuerSessionInvalid],
		},
	},
) {}
