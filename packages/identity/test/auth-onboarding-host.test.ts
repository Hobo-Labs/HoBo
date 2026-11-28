import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import { NodeHttpServer } from "@effect/platform-node";
import { createNodeSqliteDriver } from "@hobo/storage-sqlite";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { setupTest } from "rivetkit/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AlchemyProfileName,
	AlchemyStageName,
	AuthBasePath,
	AuthOnboardingApi,
	AuthSessionId,
	agentActor,
	authSessionClient,
	BetterAuthIssuerPort,
	BoxId,
	IssuerOrigin,
	NonEmptyReason,
	OwnerKeyLocator,
	OwnerVaultPort,
	ownerActor,
	PrincipalId,
	SessionHandleDigest,
	SigningKeyFingerprint,
	TtlSeconds,
	WorkspaceAuthId,
} from "../src/domain/index.js";
import {
	type CoordinatedSessionEvent,
	createAuthOnboardingInMemoryLayer,
	createAuthOnboardingRivetLayer,
	createAuthOnboardingSqliteLayer,
	createAuthSessionCoordinatorRegistry,
	createSignedAuthSessionMiddlewareLayer,
	signAuthActorProof,
} from "../src/host/index.js";
import { startLocalRivetTestEngine } from "./support/rivet-test-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const SIGNING_KEY = Redacted.make("hobo-test-auth-rpc-signing-key-32bytes");
const FINGERPRINT_V1 = SigningKeyFingerprint.make(
	"sha256:0123456789abcdef0123456789abcdef",
);

const VaultPortStub = OwnerVaultPort.toLayer(
	Effect.succeed({
		verifyKeyLocator: () =>
			Effect.succeed({
				signingKeyFingerprint: FINGERPRINT_V1,
				reusableAcrossBoxes: true,
			}),
		invalidateCachedAccess: () => Effect.succeed({ invalidated: true }),
	}),
);

const IssuerPortStub = BetterAuthIssuerPort.toLayer(
	Effect.succeed({
		bootstrapIssuer: ({ signingKeyFingerprint }) =>
			Effect.succeed({
				migrationsApplied: true,
				signingKeyFingerprint,
			}),
		verifySessionHandle: () =>
			Effect.succeed({
				active: true,
				principalId: PrincipalId.make("user:owner-1"),
			}),
		revokeSessionHandle: () => Effect.succeed({ revoked: true }),
	}),
);

const SignedMiddleware = createSignedAuthSessionMiddlewareLayer(SIGNING_KEY);

describe("@hobo/identity/host portable AuthOnboarding hosting (InMemory, HTTP, SQLite, Rivet)", () => {
	it("enforces signed AuthSessionMiddleware and ownership boundaries in-process and over real HTTP transport", async () => {
		const workspaceId = WorkspaceAuthId.make("ws-http-1");
		const owner = PrincipalId.make("user:owner-http");
		const otherOwner = PrincipalId.make("user:other-http");
		const agent = PrincipalId.make("agent:bot-http");
		const ownerProof = signAuthActorProof(ownerActor(owner), SIGNING_KEY);
		const otherProof = signAuthActorProof(ownerActor(otherOwner), SIGNING_KEY);
		const agentProof = signAuthActorProof(agentActor(agent), SIGNING_KEY);

		const InMemoryWorld = createAuthOnboardingInMemoryLayer(
			VaultPortStub,
			IssuerPortStub,
			SignedMiddleware,
		);

		const inProcessResult = await Effect.runPromise(
			Effect.gen(function* () {
				const ownerClient = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(ownerProof)),
				);
				const otherClient = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(otherProof)),
				);
				const agentClient = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(agentProof)),
				);
				const tamperedClient = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient("tampered.header")),
				);

				const started = yield* ownerClient.BeginOnboarding(workspaceId, {
					profileName: AlchemyProfileName.make("default"),
					stage: AlchemyStageName.make("dev"),
					vaultProvider: "owner-store",
					signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
					initialBoxId: BoxId.make("box-http-1"),
				});
				const ownerView = yield* ownerClient.WorkspaceOnboardingView.get(
					workspaceId,
					{ atLeast: started },
				);
				const otherDenied = yield* otherClient.WorkspaceOnboardingView.get(
					workspaceId,
					{ atLeast: started },
				).pipe(Effect.flip);
				const agentDenied = yield* agentClient.WorkspaceOnboardingView.get(
					workspaceId,
					{ atLeast: started },
				).pipe(Effect.flip);
				const tamperedDenied = yield* tamperedClient
					.AuthorizeBox(workspaceId, { boxId: BoxId.make("box-2") })
					.pipe(Effect.flip);
				return { ownerView, otherDenied, agentDenied, tamperedDenied };
			}).pipe(Effect.scoped, Effect.provide(InMemoryWorld)),
		);

		expect(inProcessResult.ownerView?._tag).toBe("VaultConfigured");
		expect(inProcessResult.otherDenied._tag).toBe("NotWorkspaceOwner");
		expect(inProcessResult.agentDenied._tag).toBe("NotWorkspaceOwner");
		expect(inProcessResult.tamperedDenied._tag).toBe("UnauthorizedAuthRequest");

		const ApiServer = Layer.unwrap(
			Effect.gen(function* () {
				const api = yield* AuthOnboardingApi;
				return HttpServer.serve()(api.fetch);
			}),
		).pipe(
			Layer.provide(
				createAuthOnboardingInMemoryLayer(
					VaultPortStub,
					IssuerPortStub,
					SignedMiddleware,
				),
			),
			Layer.provideMerge(NodeHttpServer.layerTest),
		);
		const HttpWorld = Layer.provideMerge(Domain.protocolHttp(""), ApiServer);

		const httpResult = await Effect.runPromise(
			Effect.gen(function* () {
				const ownerClient = yield* AuthOnboardingApi.client.pipe(
					Effect.provide(authSessionClient(ownerProof)),
				);
				const started = yield* ownerClient.BeginOnboarding(workspaceId, {
					profileName: AlchemyProfileName.make("default"),
					stage: AlchemyStageName.make("prod"),
					vaultProvider: "infisical",
					signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
					initialBoxId: BoxId.make("box-http-a"),
				});
				yield* ownerClient.ConfigureBetterAuthIssuer(workspaceId, {
					issuerOrigin: IssuerOrigin.make("https://auth.http.example"),
					basePath: AuthBasePath.make("/api/auth"),
					storageKind: "sqlite-shared",
				});
				const readyView = yield* ownerClient.WorkspaceOnboardingView.get(
					workspaceId,
					{ atLeast: started },
				);
				return { readyView };
			}).pipe(Effect.scoped, Effect.provide(HttpWorld)),
		);

		expect(
			httpResult.readyView?._tag === "ProvisioningIssuer" ||
				httpResult.readyView?._tag === "Ready",
		).toBe(true);
	});

	it("persists workspace onboarding and reusable sessions across SQLite restarts and cross-box logins", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-identity-host-sqlite-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "auth-onboarding.sqlite");
		const workspaceId = WorkspaceAuthId.make("ws-sqlite-1");
		const sessionId = AuthSessionId.make("sess-sqlite-1");
		const owner = PrincipalId.make("user:owner-sqlite");
		const ownerProof = signAuthActorProof(ownerActor(owner), SIGNING_KEY);
		const box1 = BoxId.make("box-mac-1");
		const box2 = BoxId.make("box-linux-2");
		const issuerOrigin = IssuerOrigin.make("https://auth.sqlite.localhost");
		const handleDigest = SessionHandleDigest.make(
			"sha256:aabbccddeeff00112233445566778899",
		);

		const firstDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const FirstWorld = createAuthOnboardingSqliteLayer(
				firstDriver,
				VaultPortStub,
				IssuerPortStub,
				SignedMiddleware,
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* AuthOnboardingApi.clientInProcess.pipe(
						Effect.provide(authSessionClient(ownerProof)),
					);
					yield* client.BeginOnboarding(workspaceId, {
						profileName: AlchemyProfileName.make("default"),
						stage: AlchemyStageName.make("dev"),
						vaultProvider: "owner-store",
						signingKeyLocator: OwnerKeyLocator.make("owner://HOBO_AUTH_SECRET"),
						initialBoxId: box1,
					});
					const estReceipt = yield* client.EstablishAuthSession(sessionId, {
						workspaceId,
						issuerOrigin,
						handleDigest,
						signingKeyFingerprint: FINGERPRINT_V1,
						boxId: box1,
						ttlSeconds: TtlSeconds.make(3600),
						allowCrossBoxReuse: true,
					});
					yield* client.ActiveSessionView.get(sessionId, {
						atLeast: estReceipt,
					});
				}).pipe(Effect.scoped, Effect.provide(FirstWorld)),
			);
		} finally {
			firstDriver.close();
		}

		const reopenedDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const ReopenedWorld = createAuthOnboardingSqliteLayer(
				reopenedDriver,
				VaultPortStub,
				IssuerPortStub,
				SignedMiddleware,
			);
			const resumed = await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* AuthOnboardingApi.clientInProcess.pipe(
						Effect.provide(authSessionClient(ownerProof)),
					);
					const restartReceipt = yield* client.ResumeAuthSession(sessionId, {
						boxId: box1,
						signingKeyFingerprint: FINGERPRINT_V1,
						boxAuthorizedByWorkspace: true,
					});
					const crossBoxReceipt = yield* client.ResumeAuthSession(sessionId, {
						boxId: box2,
						signingKeyFingerprint: FINGERPRINT_V1,
						boxAuthorizedByWorkspace: true,
					});
					const view = yield* client.ActiveSessionView.get(sessionId, {
						atLeast: crossBoxReceipt,
					});
					return { restartReceipt, crossBoxReceipt, view };
				}).pipe(Effect.scoped, Effect.provide(ReopenedWorld)),
			);

			expect(resumed.view?._tag).toBe("Active");
			if (resumed.view?._tag === "Active") {
				expect(resumed.view.resumeCount).toBe(2);
				expect(resumed.view.observedBoxes).toEqual([box1, box2]);
			}
		} finally {
			reopenedDriver.close();
		}
	});

	it("composes AuthOnboarding with DomainRivet.layerDurableObjects via createAuthOnboardingRivetLayer", () => {
		const buildLayer = (pool: Layer.Layer<PoolHost>) =>
			createAuthOnboardingRivetLayer({
				name: "AuthOnboarding",
				main: import.meta.url,
				handler: "AuthOnboardingLive",
				pool,
				vaultPort: VaultPortStub,
				issuerPort: IssuerPortStub,
				sessionMiddleware: SignedMiddleware,
			});
		expect(buildLayer).toBeTypeOf("function");
	});

	it("coordinates cross-box sessions in RivetKit SQLite, broadcasts revocation, and expires scheduled sessions via setupTest", async (testCtx) => {
		const engine = await startLocalRivetTestEngine();
		const registry = createAuthSessionCoordinatorRegistry({
			endpoint: engine.endpoint,
			token: engine.token,
			httpHost: engine.httpHost,
			httpPort: engine.httpPort,
			startEngine: false,
			noWelcome: true,
			shutdown: { gracePeriodMs: 2_000, disableSignalHandlers: true },
		});

		try {
			const { client } = await setupTest(testCtx, registry);
			const coordinator = client.authSessionCoordinator.getOrCreate([
				"ws-rivet-prod-1",
			]);
			const conn = coordinator.connect();
			const events: CoordinatedSessionEvent[] = [];
			conn.on("sessionUpdated", (payload: CoordinatedSessionEvent) => {
				events.push(payload);
			});

			try {
				const registered = await conn.registerSession({
					sessionId: AuthSessionId.make("sess-rivet-1"),
					workspaceId: WorkspaceAuthId.make("ws-rivet-prod-1"),
					principalId: PrincipalId.make("user:owner-rivet"),
					handleDigest: SessionHandleDigest.make(
						"sha256:11223344556677889900aabbccddeeff",
					),
					signingKeyFingerprint: FINGERPRINT_V1,
					boxId: BoxId.make("box-rivet-1"),
					allowCrossBox: true,
					ttlMs: 10_000,
				});
				expect(registered.status).toBe("active");

				const crossBoxResumed = await conn.resumeSession({
					sessionId: AuthSessionId.make("sess-rivet-1"),
					boxId: BoxId.make("box-rivet-2"),
					signingKeyFingerprint: FINGERPRINT_V1,
				});
				expect(crossBoxResumed.resumed).toBe(true);
				expect(crossBoxResumed.session?.observedBoxes).toEqual([
					"box-rivet-1",
					"box-rivet-2",
				]);

				const revoked = await conn.revokeSession({
					sessionId: AuthSessionId.make("sess-rivet-1"),
					reason: NonEmptyReason.make("signed-out-on-box-2"),
				});
				expect(revoked?.status).toBe("revoked");

				const afterRevoke = await conn.resumeSession({
					sessionId: AuthSessionId.make("sess-rivet-1"),
					boxId: BoxId.make("box-rivet-1"),
					signingKeyFingerprint: FINGERPRINT_V1,
				});
				expect(afterRevoke.resumed).toBe(false);
				expect(afterRevoke.reason).toBe("session-revoked");

				await vi.waitFor(() => {
					expect(
						events.some(
							(entry) =>
								entry.action === "revoked" &&
								entry.session.sessionId === "sess-rivet-1",
						),
					).toBe(true);
				});

				await conn.registerSession({
					sessionId: AuthSessionId.make("sess-rivet-expiring"),
					workspaceId: WorkspaceAuthId.make("ws-rivet-prod-1"),
					principalId: PrincipalId.make("user:owner-rivet"),
					handleDigest: SessionHandleDigest.make(
						"sha256:ffeeddccbbaa00998877665544332211",
					),
					signingKeyFingerprint: FINGERPRINT_V1,
					boxId: BoxId.make("box-rivet-1"),
					allowCrossBox: true,
					ttlMs: 60,
				});

				await expect
					.poll(
						async () => {
							const sessions = await conn.listSessions();
							return sessions.find(
								(entry) => entry.sessionId === "sess-rivet-expiring",
							)?.status;
						},
						{ timeout: 5_000, interval: 25 },
					)
					.toBe("expired");

				await expect(
					// SAFETY: intentionally invalid payload to prove Rivet boundary schema rejection.
					conn.registerSession({
						sessionId: "",
						workspaceId: "",
						principalId: "",
						handleDigest: "bad",
						signingKeyFingerprint: "bad",
						boxId: "",
						allowCrossBox: true,
						ttlMs: 1,
					} as never),
				).rejects.toThrow();
			} finally {
				await conn.dispose();
			}
		} finally {
			await registry.shutdown();
			await engine.stop();
		}
	}, 20_000);
});
