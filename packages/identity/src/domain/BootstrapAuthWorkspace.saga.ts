import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import {
	AuthWorkspace,
	CompleteIssuerBootstrap,
	FailIssuerBootstrap,
	WorkspaceNotProvisioning,
} from "./AuthWorkspace.aggregate.js";
import {
	BetterAuthIssuerPort,
	IssuerBootstrapFailed,
	OwnerVaultPort,
	VaultAccessDenied,
} from "./ExternalSystems.js";
import {
	AlchemyProfileName,
	AlchemyStageName,
	AuthBasePath,
	BetterAuthStorageKind,
	IssuerOrigin,
	NonEmptyReason,
	OwnerKeyLocator,
	SigningKeyFingerprint,
	VaultProviderKind,
	WorkspaceAuthId,
} from "./ids.js";

const VaultVerificationResultSchema = Schema.Struct({
	signingKeyFingerprint: SigningKeyFingerprint,
	reusableAcrossBoxes: Schema.Boolean,
});

const IssuerBootstrapResultSchema = Schema.Struct({
	migrationsApplied: Schema.Boolean,
	signingKeyFingerprint: SigningKeyFingerprint,
});

const VaultInvalidationResultSchema = Schema.Struct({
	invalidated: Schema.Boolean,
});

export class BootstrapAuthWorkspace extends Domain.Saga(
	"BootstrapAuthWorkspace",
	{
		key: WorkspaceAuthId,
		input: {
			profileName: AlchemyProfileName,
			stage: AlchemyStageName,
			vaultProvider: VaultProviderKind,
			signingKeyLocator: OwnerKeyLocator,
			issuerOrigin: IssuerOrigin,
			basePath: AuthBasePath,
			storageKind: BetterAuthStorageKind,
		},
		rejects: [WorkspaceNotProvisioning],
	},
	{
		description:
			"Verify the owner vault signing-key locator, bootstrap Better Auth migrations, and fail closed with vault cache invalidation when bootstrap fails.",
	},
) {}

export const BootstrapAuthWorkspaceLive = BootstrapAuthWorkspace.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* AuthWorkspace;
		const vault = yield* OwnerVaultPort;
		const issuer = yield* BetterAuthIssuerPort;

		return Effect.fn(function* ({
			key,
			profileName,
			stage,
			vaultProvider,
			signingKeyLocator,
			issuerOrigin,
			basePath,
			storageKind,
		}) {
			const verified = yield* Activity.make({
				name: "verify-vault-key-locator",
				success: VaultVerificationResultSchema,
				error: VaultAccessDenied,
				execute: vault.verifyKeyLocator({
					workspaceId: key,
					vaultProvider,
					profileName,
					stage,
					signingKeyLocator,
				}),
			}).pipe(Effect.result);

			if (verified._tag === "Failure") {
				yield* Activity.make({
					name: "record-vault-verification-failure",
					error: WorkspaceNotProvisioning,
					execute: workspaces
						.send(
							key,
							new FailIssuerBootstrap({
								reason: NonEmptyReason.make(
									`vault-denied:${verified.failure.reason}`,
								),
							}),
						)
						.pipe(Effect.asVoid),
				});
				return undefined;
			}

			const bootstrapped = yield* Activity.make({
				name: "bootstrap-better-auth-issuer",
				success: IssuerBootstrapResultSchema,
				error: IssuerBootstrapFailed,
				execute: issuer.bootstrapIssuer({
					workspaceId: key,
					issuerOrigin,
					basePath,
					storageKind,
					signingKeyLocator,
					signingKeyFingerprint: verified.success.signingKeyFingerprint,
				}),
			}).pipe(Effect.result);

			if (
				bootstrapped._tag === "Failure" ||
				!bootstrapped.success.migrationsApplied ||
				bootstrapped.success.signingKeyFingerprint !==
					verified.success.signingKeyFingerprint
			) {
				const failureDetail =
					bootstrapped._tag === "Failure"
						? bootstrapped.failure.reason
						: !bootstrapped.success.migrationsApplied
							? NonEmptyReason.make("issuer-migrations-unconfirmed")
							: NonEmptyReason.make("issuer-fingerprint-mismatch");

				const invalidated = yield* Activity.make({
					name: "compensate-invalidate-vault-cache",
					success: VaultInvalidationResultSchema,
					error: VaultAccessDenied,
					execute: vault.invalidateCachedAccess({
						workspaceId: key,
						vaultProvider,
						profileName,
						stage,
					}),
				}).pipe(Effect.result);

				const reason =
					invalidated._tag === "Failure"
						? NonEmptyReason.make(
								`bootstrap-failed:${failureDetail};cache-invalidation-failed:${invalidated.failure.reason}`,
							)
						: !invalidated.success.invalidated
							? NonEmptyReason.make(
									`bootstrap-failed:${failureDetail};cache-invalidation-unconfirmed`,
								)
							: NonEmptyReason.make(`bootstrap-failed:${failureDetail}`);

				yield* Activity.make({
					name: "record-issuer-bootstrap-failure",
					error: WorkspaceNotProvisioning,
					execute: workspaces
						.send(key, new FailIssuerBootstrap({ reason }))
						.pipe(Effect.asVoid),
				});
				return undefined;
			}

			yield* Activity.make({
				name: "complete-issuer-bootstrap",
				error: WorkspaceNotProvisioning,
				execute: workspaces
					.send(
						key,
						new CompleteIssuerBootstrap({
							signingKeyFingerprint: bootstrapped.success.signingKeyFingerprint,
							reusableAcrossBoxes: verified.success.reusableAcrossBoxes,
						}),
					)
					.pipe(Effect.asVoid),
			});
			return undefined;
		});
	}),
);
