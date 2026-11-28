import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
	ActiveSessionView,
	type ActiveSessionViewState,
	AlchemyProfileName,
	AlchemyStageName,
	AuthBasePath,
	AuthOnboarding,
	AuthOnboardingHandlers,
	AuthorizeBox,
	AuthSession,
	AuthSessionAlreadyRevoked,
	AuthSessionEstablished,
	AuthSessionExpired,
	AuthSessionId,
	AuthSessionRefreshed,
	AuthSessionResumed,
	AuthSessionRevoked,
	AuthWorkspace,
	agentActor,
	BeginOnboarding,
	BetterAuthIssuerConfigured,
	BetterAuthIssuerPort,
	BoxAuthorized,
	BoxId,
	BoxNotAuthorizedForSession,
	ConfigureBetterAuthIssuer,
	CurrentAuthActor,
	EpochMs,
	EstablishAuthSession,
	IssuerBootstrapCompleted,
	IssuerBootstrapFailed,
	IssuerBootstrapFailedEvent,
	IssuerOrigin,
	NonEmptyReason,
	NotWorkspaceOwner,
	OnboardingStarted,
	OwnerKeyLocator,
	OwnerVaultPort,
	ownerActor,
	PrincipalId,
	RefreshAuthSession,
	ResumeAuthSession,
	RevokeAuthSession,
	RotateSigningKey,
	SessionHandleDigest,
	SigningKeyFingerprint,
	SigningKeyFingerprintMismatch,
	SigningKeyRotated,
	TtlSeconds,
	UniqueBoxList,
	VaultAccessDenied,
	WorkspaceAuthId,
	type WorkspaceOnboardingState,
	WorkspaceOnboardingView,
} from "../src/domain/index.js";

const story = Story.make(AuthOnboarding, {
	layer: AuthOnboardingHandlers,
	stub: [OwnerVaultPort, BetterAuthIssuerPort],
});

type OwnerVaultPortService = Layer.Success<
	ReturnType<typeof OwnerVaultPort.toLayer>
>;
type BetterAuthIssuerPortService = Layer.Success<
	ReturnType<typeof BetterAuthIssuerPort.toLayer>
>;

function runOwnerVaultPortConformance(
	adapterName: string,
	layer: Layer.Layer<OwnerVaultPortService>,
) {
	describe(`OwnerVaultPort adapter conformance: ${adapterName}`, () => {
		it("verifies owner key locators and invalidates cached access through the typed ExternalSystem contract", async () => {
			const workspaceId = WorkspaceAuthId.make("ws-conformance-1");
			const profileName = AlchemyProfileName.make("default");
			const stage = AlchemyStageName.make("dev");
			const signingKeyLocator = OwnerKeyLocator.make(
				"owner://HOBO_AUTH_SECRET",
			);

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const vault = yield* OwnerVaultPort;
					const verified = yield* vault.verifyKeyLocator({
						workspaceId,
						vaultProvider: "owner-store",
						profileName,
						stage,
						signingKeyLocator,
					});
					const invalidated = yield* vault.invalidateCachedAccess({
						workspaceId,
						vaultProvider: "owner-store",
						profileName,
						stage,
					});
					return { verified, invalidated };
				}).pipe(Effect.provide(layer)),
			);

			expect(result.verified.signingKeyFingerprint.startsWith("sha256:")).toBe(
				true,
			);
			expect(result.verified.reusableAcrossBoxes).toBe(true);
			expect(result.invalidated.invalidated).toBe(true);
		});
	});
}

function runBetterAuthIssuerPortConformance(
	adapterName: string,
	layer: Layer.Layer<BetterAuthIssuerPortService>,
) {
	describe(`BetterAuthIssuerPort adapter conformance: ${adapterName}`, () => {
		it("bootstraps issuer, verifies session handle, and revokes handle through the typed ExternalSystem contract", async () => {
			const workspaceId = WorkspaceAuthId.make("ws-issuer-conformance-1");
			const issuerOrigin = IssuerOrigin.make("https://auth.hobo.localhost");
			const basePath = AuthBasePath.make("/api/auth");
			const signingKeyLocator = OwnerKeyLocator.make(
				"owner://HOBO_AUTH_SECRET",
			);
			const signingKeyFingerprint = SigningKeyFingerprint.make(
				"sha256:0123456789abcdef0123456789abcdef",
			);
			const handleDigest = SessionHandleDigest.make(
				"sha256:abcdef0123456789abcdef0123456789",
			);
			const boxId = BoxId.make("box-laptop-1");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const issuer = yield* BetterAuthIssuerPort;
					const bootstrapped = yield* issuer.bootstrapIssuer({
						workspaceId,
						issuerOrigin,
						basePath,
						storageKind: "sqlite-shared",
						signingKeyLocator,
						signingKeyFingerprint,
					});
					const verified = yield* issuer.verifySessionHandle({
						workspaceId,
						issuerOrigin,
						handleDigest,
						boxId,
						expectedSigningKeyFingerprint: signingKeyFingerprint,
					});
					const revoked = yield* issuer.revokeSessionHandle({
						workspaceId,
						issuerOrigin,
						handleDigest,
						reason: NonEmptyReason.make("conformance-sign-out"),
					});
					return { bootstrapped, verified, revoked };
				}).pipe(Effect.provide(layer)),
			);

			expect(result.bootstrapped.migrationsApplied).toBe(true);
			expect(result.verified.active).toBe(true);
			expect(result.revoked.revoked).toBe(true);
		});
	});
}

describe("@hobo/identity/domain AuthOnboarding Alchemy Domain model", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(AuthOnboarding)).toEqual([]);
	});

	it("enforces branded domain types and discriminated views at compile time and schema decode boundaries", () => {
		const checkCompileTimeConstraints = (
			workspaceView: WorkspaceOnboardingState,
			sessionView: ActiveSessionViewState,
		) => {
			// @ts-expect-error raw string is not a branded WorkspaceAuthId
			const badWorkspaceId: WorkspaceAuthId = "ws-raw";
			// @ts-expect-error raw string is not a branded OwnerKeyLocator
			const badLocator: OwnerKeyLocator = "owner://HOBO_AUTH_SECRET";
			// @ts-expect-error raw string is not a branded SigningKeyFingerprint
			const badFingerprint: SigningKeyFingerprint = "sha256:raw";
			// @ts-expect-error raw string is not a branded SessionHandleDigest
			const badHandle: SessionHandleDigest = "sha256:raw";
			// @ts-expect-error signingKeyFingerprint does not exist on unnarrowed WorkspaceOnboardingState
			const unnarrowedFingerprint = workspaceView.signingKeyFingerprint;
			// @ts-expect-error observedBoxes does not exist on unnarrowed ActiveSessionViewState
			const unnarrowedBoxes = sessionView.observedBoxes;
			return [
				badWorkspaceId,
				badLocator,
				badFingerprint,
				badHandle,
				unnarrowedFingerprint,
				unnarrowedBoxes,
			];
		};
		expect(checkCompileTimeConstraints).toBeTypeOf("function");

		const decodeLocator = Schema.decodeUnknownExit(OwnerKeyLocator);
		const decodeBoxes = Schema.decodeUnknownExit(UniqueBoxList);
		const decodeTtl = Schema.decodeUnknownExit(TtlSeconds);
		const decodeDigest = Schema.decodeUnknownExit(SessionHandleDigest);
		const forbiddenEnvScheme = `${"env"}://HOBO_AUTH_SECRET`;

		expect(Exit.isFailure(decodeLocator(forbiddenEnvScheme))).toBe(true);
		expect(Exit.isFailure(decodeLocator("owner://lowercase"))).toBe(true);
		expect(Exit.isSuccess(decodeLocator("owner://HOBO_AUTH_SECRET"))).toBe(
			true,
		);
		expect(Exit.isFailure(decodeBoxes([]))).toBe(true);
		expect(Exit.isFailure(decodeBoxes(["box-1", "box-1"]))).toBe(true);
		expect(Exit.isSuccess(decodeBoxes(["box-1", "box-2"]))).toBe(true);
		expect(Exit.isFailure(decodeTtl(10))).toBe(true);
		expect(Exit.isSuccess(decodeTtl(3600))).toBe(true);
		expect(Exit.isFailure(decodeDigest("md5:not-sha256"))).toBe(true);
	});

	it("completes workspace onboarding through vault verification and Better Auth bootstrap while enforcing ownership", async () => {
		const workspaceId = WorkspaceAuthId.make("ws-prod-1");
		const owner = PrincipalId.make("user:owner-1");
		const otherOwner = PrincipalId.make("user:owner-2");
		const agent = PrincipalId.make("agent:bot-1");
		const profileName = AlchemyProfileName.make("default");
		const stage = AlchemyStageName.make("prod");
		const signingKeyLocator = OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET");
		const initialBoxId = BoxId.make("box-macbook-1");
		const issuerOrigin = IssuerOrigin.make("https://auth.hobo.example");
		const basePath = AuthBasePath.make("/api/auth");
		const signingKeyFingerprint = SigningKeyFingerprint.make(
			"sha256:11112222333344445555666677778888",
		);
		const ws = AuthWorkspace.ref(workspaceId);

		await Effect.runPromise(
			story(
				Story.provide(CurrentAuthActor, agentActor(agent)),
				Story.when(
					ws,
					new BeginOnboarding({
						profileName,
						stage,
						vaultProvider: "infisical",
						signingKeyLocator,
						initialBoxId,
					}),
				),
				Story.rejected(
					new NotWorkspaceOwner({ expectedOwner: null, caller: agent }),
				),
				Story.provide(CurrentAuthActor, ownerActor(owner)),
				Story.when(
					ws,
					new BeginOnboarding({
						profileName,
						stage,
						vaultProvider: "infisical",
						signingKeyLocator,
						initialBoxId,
					}),
				),
				Story.then(
					ws,
					new OnboardingStarted({
						ownerPrincipalId: owner,
						profileName,
						stage,
						vaultProvider: "infisical",
						signingKeyLocator,
						initialBoxId,
					}),
				),
				Story.provide(CurrentAuthActor, ownerActor(otherOwner)),
				Story.when(
					ws,
					new ConfigureBetterAuthIssuer({
						issuerOrigin,
						basePath,
						storageKind: "sqlite-shared",
					}),
				),
				Story.rejected(
					new NotWorkspaceOwner({
						expectedOwner: owner,
						caller: otherOwner,
					}),
				),
				Story.provide(CurrentAuthActor, ownerActor(owner)),
				Story.when(
					ws,
					new ConfigureBetterAuthIssuer({
						issuerOrigin,
						basePath,
						storageKind: "sqlite-shared",
					}),
				),
				Story.then(
					ws,
					new BetterAuthIssuerConfigured({
						ownerPrincipalId: owner,
						profileName,
						stage,
						vaultProvider: "infisical",
						signingKeyLocator,
						issuerOrigin,
						basePath,
						storageKind: "sqlite-shared",
					}),
				),
				Story.call(OwnerVaultPort.verifyKeyLocator, {
					workspaceId,
					vaultProvider: "infisical",
					profileName,
					stage,
					signingKeyLocator,
				}),
				Story.succeed(OwnerVaultPort.verifyKeyLocator, {
					signingKeyFingerprint,
					reusableAcrossBoxes: true,
				}),
				Story.call(BetterAuthIssuerPort.bootstrapIssuer, {
					workspaceId,
					issuerOrigin,
					basePath,
					storageKind: "sqlite-shared",
					signingKeyLocator,
					signingKeyFingerprint,
				}),
				Story.succeed(BetterAuthIssuerPort.bootstrapIssuer, {
					migrationsApplied: true,
					signingKeyFingerprint,
				}),
				Story.then(
					ws,
					new IssuerBootstrapCompleted({
						signingKeyFingerprint,
						reusableAcrossBoxes: true,
					}),
				),
				Story.view(WorkspaceOnboardingView, ws, {
					_tag: "Ready",
					ownerPrincipalId: owner,
					profileName,
					stage,
					vaultProvider: "infisical",
					signingKeyLocator,
					issuerOrigin,
					basePath,
					storageKind: "sqlite-shared",
					signingKeyFingerprint,
					reusableAcrossBoxes: true,
					authorizedBoxes: UniqueBoxList.make([initialBoxId]),
				}),
			),
		);
	});

	it("fails closed with vault cache invalidation compensation when Better Auth bootstrap fails", async () => {
		const workspaceId = WorkspaceAuthId.make("ws-fail-closed-1");
		const owner = PrincipalId.make("user:owner-fc");
		const profileName = AlchemyProfileName.make("prod-profile");
		const stage = AlchemyStageName.make("prod");
		const signingKeyLocator = OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET");
		const initialBoxId = BoxId.make("box-linux-1");
		const issuerOrigin = IssuerOrigin.make("https://auth.fail.example");
		const basePath = AuthBasePath.make("/api/auth");
		const signingKeyFingerprint = SigningKeyFingerprint.make(
			"sha256:aaaa1111bbbb2222cccc3333dddd4444",
		);
		const ws = AuthWorkspace.ref(workspaceId);

		await Effect.runPromise(
			story(
				Story.provide(CurrentAuthActor, ownerActor(owner)),
				Story.when(
					ws,
					new BeginOnboarding({
						profileName,
						stage,
						vaultProvider: "doppler",
						signingKeyLocator,
						initialBoxId,
					}),
				),
				Story.then(
					ws,
					new OnboardingStarted({
						ownerPrincipalId: owner,
						profileName,
						stage,
						vaultProvider: "doppler",
						signingKeyLocator,
						initialBoxId,
					}),
				),
				Story.when(
					ws,
					new ConfigureBetterAuthIssuer({
						issuerOrigin,
						basePath,
						storageKind: "secondary-sqlite",
					}),
				),
				Story.then(
					ws,
					new BetterAuthIssuerConfigured({
						ownerPrincipalId: owner,
						profileName,
						stage,
						vaultProvider: "doppler",
						signingKeyLocator,
						issuerOrigin,
						basePath,
						storageKind: "secondary-sqlite",
					}),
				),
				Story.call(OwnerVaultPort.verifyKeyLocator, { workspaceId }),
				Story.succeed(OwnerVaultPort.verifyKeyLocator, {
					signingKeyFingerprint,
					reusableAcrossBoxes: true,
				}),
				Story.call(BetterAuthIssuerPort.bootstrapIssuer, { workspaceId }),
				Story.fail(
					BetterAuthIssuerPort.bootstrapIssuer,
					new IssuerBootstrapFailed({
						issuerOrigin,
						reason: NonEmptyReason.make("migration-lock-timeout"),
					}),
				),
				Story.call(OwnerVaultPort.invalidateCachedAccess, {
					workspaceId,
					vaultProvider: "doppler",
					profileName,
					stage,
				}),
				Story.fail(
					OwnerVaultPort.invalidateCachedAccess,
					new VaultAccessDenied({
						vaultProvider: "doppler",
						signingKeyLocator,
						reason: NonEmptyReason.make("vault-unreachable"),
					}),
				),
				Story.then(
					ws,
					new IssuerBootstrapFailedEvent({
						reason: NonEmptyReason.make(
							"bootstrap-failed:migration-lock-timeout;cache-invalidation-failed:vault-unreachable",
						),
					}),
				),
				Story.view(WorkspaceOnboardingView, ws, {
					_tag: "Suspended",
					reason: NonEmptyReason.make(
						"bootstrap-failed:migration-lock-timeout;cache-invalidation-failed:vault-unreachable",
					),
				}),
			),
		);
	});

	it("supports same-box restart reuse, cross-box login reuse, expiry, key rotation mismatch, and revocation propagation", async () => {
		const workspaceId = WorkspaceAuthId.make("ws-reuse-1");
		const sessionId = AuthSessionId.make("sess-reuse-1");
		const owner = PrincipalId.make("user:tyler");
		const boxA = BoxId.make("box-macbook");
		const boxB = BoxId.make("box-devbox-2");
		const boxC = BoxId.make("box-untrusted-3");
		const issuerOrigin = IssuerOrigin.make("https://auth.hobo.localhost");
		const fingerprintV1 = SigningKeyFingerprint.make(
			"sha256:1234567890abcdef1234567890abcdef",
		);
		const fingerprintV2 = SigningKeyFingerprint.make(
			"sha256:fedcba0987654321fedcba0987654321",
		);
		const handleV1 = SessionHandleDigest.make(
			"sha256:00112233445566778899aabbccddeeff",
		);
		const handleV2 = SessionHandleDigest.make(
			"sha256:ffeeddccbbaa99887766554433221100",
		);
		const startMs = Date.parse("2026-06-01T10:00:00.000Z");
		const ws = AuthWorkspace.ref(workspaceId);
		const session = AuthSession.ref(sessionId);

		await Effect.runPromise(
			story(
				Story.clock(startMs),
				Story.given(
					ws,
					new OnboardingStarted({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("dev"),
						vaultProvider: "owner-store",
						signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
						initialBoxId: boxA,
					}),
					new BetterAuthIssuerConfigured({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("dev"),
						vaultProvider: "owner-store",
						signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
						issuerOrigin,
						basePath: AuthBasePath.make("/api/auth"),
						storageKind: "sqlite-shared",
					}),
					new IssuerBootstrapCompleted({
						signingKeyFingerprint: fingerprintV1,
						reusableAcrossBoxes: true,
					}),
				),
				Story.provide(CurrentAuthActor, ownerActor(owner)),
				Story.when(
					session,
					new EstablishAuthSession({
						workspaceId,
						issuerOrigin,
						handleDigest: handleV1,
						signingKeyFingerprint: fingerprintV1,
						boxId: boxA,
						ttlSeconds: TtlSeconds.make(3600),
						allowCrossBoxReuse: true,
					}),
				),
				Story.then(
					session,
					new AuthSessionEstablished({
						workspaceId,
						principalId: owner,
						issuerOrigin,
						handleDigest: handleV1,
						signingKeyFingerprint: fingerprintV1,
						boxId: boxA,
						issuedAtMs: EpochMs.make(startMs),
						expiresAtMs: EpochMs.make(startMs + 3_600_000),
						allowCrossBoxReuse: true,
					}),
				),
				Story.advance("10 minutes"),
				Story.when(
					session,
					new ResumeAuthSession({
						boxId: boxA,
						signingKeyFingerprint: fingerprintV1,
						boxAuthorizedByWorkspace: true,
					}),
				),
				Story.then(
					session,
					new AuthSessionResumed({
						boxId: boxA,
						resumedAtMs: EpochMs.make(startMs + 600_000),
						crossBox: false,
					}),
				),
				Story.when(
					session,
					new ResumeAuthSession({
						boxId: boxC,
						signingKeyFingerprint: fingerprintV1,
						boxAuthorizedByWorkspace: false,
					}),
				),
				Story.rejected(new BoxNotAuthorizedForSession({ boxId: boxC })),
				Story.when(ws, new AuthorizeBox({ boxId: boxB })),
				Story.then(ws, new BoxAuthorized({ boxId: boxB })),
				Story.when(
					session,
					new ResumeAuthSession({
						boxId: boxB,
						signingKeyFingerprint: fingerprintV1,
						boxAuthorizedByWorkspace: true,
					}),
				),
				Story.then(
					session,
					new AuthSessionResumed({
						boxId: boxB,
						resumedAtMs: EpochMs.make(startMs + 600_000),
						crossBox: true,
					}),
				),
				Story.when(
					session,
					new ResumeAuthSession({
						boxId: boxB,
						signingKeyFingerprint: fingerprintV2,
						boxAuthorizedByWorkspace: true,
					}),
				),
				Story.rejected(
					new SigningKeyFingerprintMismatch({
						expected: fingerprintV1,
						provided: fingerprintV2,
					}),
				),
				Story.when(
					session,
					new RefreshAuthSession({
						boxId: boxB,
						nextHandleDigest: handleV2,
						signingKeyFingerprint: fingerprintV1,
						ttlSeconds: TtlSeconds.make(3600),
					}),
				),
				Story.then(
					session,
					new AuthSessionRefreshed({
						boxId: boxB,
						handleDigest: handleV2,
						refreshedAtMs: EpochMs.make(startMs + 600_000),
						expiresAtMs: EpochMs.make(startMs + 4_200_000),
					}),
				),
				Story.view(ActiveSessionView, session, {
					_tag: "Active",
					handleDigest: handleV2,
					observedBoxes: UniqueBoxList.make([boxA, boxB]),
					resumeCount: 2,
				}),
				Story.when(
					session,
					new RevokeAuthSession({
						reason: NonEmptyReason.make("owner-signed-out-on-box-b"),
					}),
				),
				Story.then(
					session,
					new AuthSessionRevoked({
						workspaceId,
						issuerOrigin,
						handleDigest: handleV2,
						revokedAtMs: EpochMs.make(startMs + 600_000),
						reason: NonEmptyReason.make("owner-signed-out-on-box-b"),
					}),
				),
				Story.call(BetterAuthIssuerPort.revokeSessionHandle, {
					workspaceId,
					issuerOrigin,
					handleDigest: handleV2,
					reason: NonEmptyReason.make("owner-signed-out-on-box-b"),
				}),
				Story.succeed(BetterAuthIssuerPort.revokeSessionHandle, {
					revoked: true,
				}),
				Story.when(
					session,
					new ResumeAuthSession({
						boxId: boxA,
						signingKeyFingerprint: fingerprintV1,
						boxAuthorizedByWorkspace: true,
					}),
				),
				Story.rejected(
					new AuthSessionAlreadyRevoked({
						reason: NonEmptyReason.make("owner-signed-out-on-box-b"),
					}),
				),
			),
		);
	});

	it("rejects session resume after TTL elapses and re-bootstraps on signing-key rotation", async () => {
		const workspaceId = WorkspaceAuthId.make("ws-rotate-1");
		const sessionId = AuthSessionId.make("sess-expire-1");
		const owner = PrincipalId.make("user:owner-exp");
		const boxId = BoxId.make("box-1");
		const issuerOrigin = IssuerOrigin.make("https://auth.rotate.example");
		const fingerprintV1 = SigningKeyFingerprint.make(
			"sha256:11111111111111111111111111111111",
		);
		const fingerprintV2 = SigningKeyFingerprint.make(
			"sha256:22222222222222222222222222222222",
		);
		const handleDigest = SessionHandleDigest.make(
			"sha256:33333333333333333333333333333333",
		);
		const startMs = Date.parse("2026-07-01T00:00:00.000Z");
		const ws = AuthWorkspace.ref(workspaceId);
		const session = AuthSession.ref(sessionId);

		await Effect.runPromise(
			story(
				Story.clock(startMs),
				Story.given(
					ws,
					new OnboardingStarted({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("prod"),
						vaultProvider: "owner-store",
						signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
						initialBoxId: boxId,
					}),
					new BetterAuthIssuerConfigured({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("prod"),
						vaultProvider: "owner-store",
						signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
						issuerOrigin,
						basePath: AuthBasePath.make("/api/auth"),
						storageKind: "sqlite-shared",
					}),
					new IssuerBootstrapCompleted({
						signingKeyFingerprint: fingerprintV1,
						reusableAcrossBoxes: true,
					}),
				),
				Story.provide(CurrentAuthActor, ownerActor(owner)),
				Story.when(
					session,
					new EstablishAuthSession({
						workspaceId,
						issuerOrigin,
						handleDigest,
						signingKeyFingerprint: fingerprintV1,
						boxId,
						ttlSeconds: TtlSeconds.make(600),
						allowCrossBoxReuse: true,
					}),
				),
				Story.then(
					session,
					new AuthSessionEstablished({
						workspaceId,
						principalId: owner,
						issuerOrigin,
						handleDigest,
						signingKeyFingerprint: fingerprintV1,
						boxId,
						issuedAtMs: EpochMs.make(startMs),
						expiresAtMs: EpochMs.make(startMs + 600_000),
						allowCrossBoxReuse: true,
					}),
				),
				Story.advance("11 minutes"),
				Story.when(
					session,
					new ResumeAuthSession({
						boxId,
						signingKeyFingerprint: fingerprintV1,
						boxAuthorizedByWorkspace: true,
					}),
				),
				Story.rejected(
					new AuthSessionExpired({
						expiredAtMs: EpochMs.make(startMs + 600_000),
						observedAtMs: EpochMs.make(startMs + 660_000),
					}),
				),
				Story.when(
					ws,
					new RotateSigningKey({
						nextSigningKeyLocator: OwnerKeyLocator.make(
							"owner://HOBO_AUTH_SECRET_V2",
						),
					}),
				),
				Story.then(
					ws,
					new SigningKeyRotated({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("prod"),
						vaultProvider: "owner-store",
						previousSigningKeyLocator: OwnerKeyLocator.make(
							"owner://HOBO_AUTH_SECRET",
						),
						signingKeyLocator: OwnerKeyLocator.make(
							"owner://HOBO_AUTH_SECRET_V2",
						),
						issuerOrigin,
						basePath: AuthBasePath.make("/api/auth"),
						storageKind: "sqlite-shared",
					}),
				),
				Story.call(OwnerVaultPort.verifyKeyLocator, {
					workspaceId,
					signingKeyLocator: OwnerKeyLocator.make(
						"owner://HOBO_AUTH_SECRET_V2",
					),
				}),
				Story.succeed(OwnerVaultPort.verifyKeyLocator, {
					signingKeyFingerprint: fingerprintV2,
					reusableAcrossBoxes: true,
				}),
				Story.call(BetterAuthIssuerPort.bootstrapIssuer, {
					workspaceId,
					signingKeyFingerprint: fingerprintV2,
				}),
				Story.succeed(BetterAuthIssuerPort.bootstrapIssuer, {
					migrationsApplied: true,
					signingKeyFingerprint: fingerprintV2,
				}),
				Story.then(
					ws,
					new IssuerBootstrapCompleted({
						signingKeyFingerprint: fingerprintV2,
						reusableAcrossBoxes: true,
					}),
				),
			),
		);
	});

	it("asserts real ExternalSystem adapter calls via Story.returned and detects schema drift with ExternalSystemSchemaError", async () => {
		const fingerprint = SigningKeyFingerprint.make(
			"sha256:99998888777766665555444433332222",
		);
		const RealVaultAdapter = OwnerVaultPort.toLayer(
			Effect.succeed({
				verifyKeyLocator: () =>
					Effect.succeed({
						signingKeyFingerprint: fingerprint,
						reusableAcrossBoxes: true,
					}),
				invalidateCachedAccess: () => Effect.succeed({ invalidated: true }),
			}),
		);
		const realVaultStory = Story.make(AuthOnboarding, {
			layer: AuthOnboardingHandlers,
			stub: [BetterAuthIssuerPort],
		});

		const workspaceId = WorkspaceAuthId.make("ws-real-call-1");
		const owner = PrincipalId.make("user:owner-real");
		const ws = AuthWorkspace.ref(workspaceId);
		const issuerOrigin = IssuerOrigin.make("https://auth.real.example");
		const basePath = AuthBasePath.make("/api/auth");
		const signingKeyLocator = OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET");

		await Effect.runPromise(
			realVaultStory(
				Story.provide(CurrentAuthActor, ownerActor(owner)),
				Story.when(
					ws,
					new BeginOnboarding({
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("dev"),
						vaultProvider: "owner-store",
						signingKeyLocator,
						initialBoxId: BoxId.make("box-real-1"),
					}),
				),
				Story.then(
					ws,
					new OnboardingStarted({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("dev"),
						vaultProvider: "owner-store",
						signingKeyLocator,
						initialBoxId: BoxId.make("box-real-1"),
					}),
				),
				Story.when(
					ws,
					new ConfigureBetterAuthIssuer({
						issuerOrigin,
						basePath,
						storageKind: "sqlite-local",
					}),
				),
				Story.then(
					ws,
					new BetterAuthIssuerConfigured({
						ownerPrincipalId: owner,
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("dev"),
						vaultProvider: "owner-store",
						signingKeyLocator,
						issuerOrigin,
						basePath,
						storageKind: "sqlite-local",
					}),
				),
				Story.call(OwnerVaultPort.verifyKeyLocator, { workspaceId }),
				Story.returned(OwnerVaultPort.verifyKeyLocator, {
					signingKeyFingerprint: fingerprint,
					reusableAcrossBoxes: true,
				}),
				Story.call(BetterAuthIssuerPort.bootstrapIssuer, { workspaceId }),
				Story.succeed(BetterAuthIssuerPort.bootstrapIssuer, {
					migrationsApplied: true,
					signingKeyFingerprint: fingerprint,
				}),
				Story.then(
					ws,
					new IssuerBootstrapCompleted({
						signingKeyFingerprint: fingerprint,
						reusableAcrossBoxes: true,
					}),
				),
			).pipe(Effect.provide(RealVaultAdapter)),
		);

		const DriftingVaultAdapter = OwnerVaultPort.toLayer(
			Effect.succeed({
				verifyKeyLocator: () =>
					Effect.succeed({
						// SAFETY: intentionally malformed fingerprint to verify ExternalSystemSchemaError drift detection.
						signingKeyFingerprint: "not-a-sha256" as SigningKeyFingerprint,
						reusableAcrossBoxes: true,
					}),
				invalidateCachedAccess: () => Effect.succeed({ invalidated: true }),
			}),
		);

		const driftExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const vault = yield* OwnerVaultPort;
				return yield* vault.verifyKeyLocator({
					workspaceId,
					vaultProvider: "owner-store",
					profileName: AlchemyProfileName.make("default"),
					stage: AlchemyStageName.make("dev"),
					signingKeyLocator,
				});
			}).pipe(Effect.provide(DriftingVaultAdapter)),
		);

		expect(Exit.isFailure(driftExit)).toBe(true);
		expect(String(driftExit)).toContain("ExternalSystemSchemaError");
	});

	runOwnerVaultPortConformance(
		"in-memory-owner-store",
		OwnerVaultPort.toLayer(
			Effect.succeed({
				verifyKeyLocator: () =>
					Effect.succeed({
						signingKeyFingerprint: SigningKeyFingerprint.make(
							"sha256:0123456789abcdef0123456789abcdef",
						),
						reusableAcrossBoxes: true,
					}),
				invalidateCachedAccess: () => Effect.succeed({ invalidated: true }),
			}),
		),
	);

	runBetterAuthIssuerPortConformance(
		"in-memory-better-auth-issuer",
		BetterAuthIssuerPort.toLayer(
			Effect.succeed({
				bootstrapIssuer: ({ signingKeyFingerprint }) =>
					Effect.succeed({
						migrationsApplied: true,
						signingKeyFingerprint,
					}),
				verifySessionHandle: () =>
					Effect.succeed({
						active: true,
						principalId: PrincipalId.make("user:conformance"),
					}),
				revokeSessionHandle: () => Effect.succeed({ revoked: true }),
			}),
		),
	);
});
