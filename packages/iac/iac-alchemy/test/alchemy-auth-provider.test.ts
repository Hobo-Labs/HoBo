import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
	AuthProvidersLive,
	getAuthProvider,
	ProfileStore,
	ProfileStoreLive,
} from "alchemy/Auth";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuthError,
	createHoboDopplerSecrets,
	createHoboSecretProviders,
	createOwnerStoreConfigLayer,
	describeHoboAuthProfile,
	HOBO_AUTH_PROVIDER_NAME,
	HoboAuthCredentialBroker,
	HoboAuthCredentials,
	HoboAuthCredentialsFromProviderLayer,
	type HoboAuthProfileConfig,
	HoboAuthProviderLayer,
	type HoboAuthResolvedCredentials,
	mapStageToDopplerConfig,
	NeedsReauth,
	readHoboBetterAuthConfig,
	renderHoboAuthProfileDetails,
} from "../src/environments/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Alchemy AuthProvider, Profiles, and Secret Providers for HoBo Auth", () => {
	it("constructs stage-aware Doppler and unified Hobo secret providers with ProcessEnv disabled", () => {
		expect(mapStageToDopplerConfig("prod")).toBe("prd");
		expect(mapStageToDopplerConfig("staging")).toBe("stg");
		expect(mapStageToDopplerConfig("pr-12")).toBe("dev");
		expect(mapStageToDopplerConfig("pr-12", { "pr-12": "preview" })).toBe(
			"preview",
		);

		const dopplerEntries = createHoboDopplerSecrets({ project: "hobo-auth" });
		expect(dopplerEntries).toHaveLength(2);
		expect(dopplerEntries[0]).toMatchObject({
			_tag: "alchemy/SecretProvider::ProcessEnv",
		});
		expect(dopplerEntries[1]).toMatchObject({
			_tag: "alchemy/SecretProvider::Doppler",
		});

		const unifiedInfisical = createHoboSecretProviders({
			kind: "infisical",
			options: { project: "hobo-auth", path: "/auth" },
		});
		expect(unifiedInfisical).toHaveLength(2);
		expect(unifiedInfisical[1]).toMatchObject({
			_tag: "alchemy/SecretProvider::Infisical",
		});

		const unifiedDoppler = createHoboSecretProviders({
			kind: "doppler",
			options: { project: "hobo-auth" },
		});
		expect(unifiedDoppler).toHaveLength(2);
		expect(unifiedDoppler[1]).toMatchObject({
			_tag: "alchemy/SecretProvider::Doppler",
		});

		const unifiedOwner = createHoboSecretProviders({
			kind: "owner-store",
			options: {
				keys: { HOBO_AUTH_SECRET: "owner://HOBO_AUTH_SECRET" },
				resolveCredential: async () =>
					"synthetic-signing-secret-material-32chars",
			},
		});
		expect(unifiedOwner).toHaveLength(2);
		expect(unifiedOwner[1]).toMatchObject({
			_tag: "hobo/SecretProvider::OwnerStore",
		});

		const dopplerProfileDetails = describeHoboAuthProfile({
			profile: "work",
			stage: "prod",
			store: "Doppler",
			project: "hobo-auth",
			path: "/auth",
			credentialKeys: ["HOBO_AUTH_SECRET"],
		});
		expect(dopplerProfileDetails.lines).toContainEqual({
			key: "environment",
			value: "prd",
		});
	});

	it("reads Better Auth Effect Config values with Redacted signing secret and optional GitHub App OAuth", async () => {
		const provider = ConfigProvider.fromUnknown({
			HOBO_AUTH_SECRET: "synthetic-signing-secret-32-bytes-min!",
			HOBO_AUTH_BASE_URL: "https://auth.hobo.test",
			HOBO_AUTH_BASE_PATH: "/api/auth",
			HOBO_AUTH_TRUSTED_ORIGINS:
				"https://auth.hobo.test, https://box2.hobo.test",
			HOBO_AUTH_GITHUB_APP_CLIENT_ID: "Iv23liTestClientId",
			HOBO_AUTH_GITHUB_APP_CLIENT_SECRET: "synthetic-github-app-client-secret",
		});

		const resolved = await Effect.runPromise(
			readHoboBetterAuthConfig.pipe(
				Effect.provideService(ConfigProvider.ConfigProvider, provider),
			),
		);

		expect(String(resolved.signingSecret)).toBe("<redacted>");
		expect(Redacted.value(resolved.signingSecret)).toBe(
			"synthetic-signing-secret-32-bytes-min!",
		);
		expect(resolved.baseUrl).toBe("https://auth.hobo.test");
		expect(resolved.basePath).toBe("/api/auth");
		expect(resolved.trustedOrigins).toEqual([
			"https://auth.hobo.test",
			"https://box2.hobo.test",
		]);
		expect(Option.isSome(resolved.githubAppOAuth)).toBe(true);
		if (Option.isSome(resolved.githubAppOAuth)) {
			expect(resolved.githubAppOAuth.value.clientId).toBe("Iv23liTestClientId");
			expect(String(resolved.githubAppOAuth.value.clientSecret)).toBe(
				"<redacted>",
			);
		}
	});

	it("registers HoboAuth in Alchemy AuthProviders, persists non-secret profiles, resolves lazily, and fails closed with NeedsReauth", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "hobo-alchemy-profile-"));
		tempDirs.push(tempHome);

		const previousAlchemyHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = tempHome;
		let resolveCount = 0;
		let expired = false;
		let loggedOut = false;

		const brokerLayer = Layer.succeed(HoboAuthCredentialBroker, {
			resolveForProfile: ({ profileName, config }) =>
				Effect.gen(function* () {
					resolveCount += 1;
					if (expired) {
						return yield* NeedsReauth.make({
							provider: HOBO_AUTH_PROVIDER_NAME,
							profile: profileName,
							message: "Better Auth session expired; run hobo login --resume",
						});
					}
					const credentials: HoboAuthResolvedCredentials = {
						profileName,
						method: config.method,
						stage: config.stage,
						boxId: config.boxId,
						signingSecret: Redacted.make(
							"brokered-owner-signing-secret-material-32!",
						),
						sessionToken: Redacted.make("brokered-session-token-material"),
						...(config.method === "better-auth-session"
							? {
									issuerOrigin: config.issuerOrigin,
									basePath: config.basePath,
									expiresAtMs: Date.now() + 3_600_000,
								}
							: undefined),
					};
					return { credentials };
				}),
			refreshForProfile: ({ config }) =>
				config.method === "better-auth-session"
					? Effect.succeed({
							...config,
							expiresAtMs: Date.now() + 7_200_000,
						})
					: Effect.succeed(config),
			logoutForProfile: () =>
				Effect.sync(() => {
					loggedOut = true;
				}),
		});

		const nonCiConfigLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({ CI: "false" }),
		);
		const platformLayer = Layer.mergeAll(
			NodeServices.layer,
			SecureRandom.layerWebCrypto,
			nonCiConfigLayer,
		);
		const baseLayer = Layer.mergeAll(
			platformLayer,
			AuthProvidersLive,
			ProfileStoreLive.pipe(Layer.provide(platformLayer)),
			brokerLayer,
		);
		const providerRegistrationLayer = HoboAuthProviderLayer.pipe(
			Layer.provideMerge(baseLayer),
		);
		const credentialsLayer = HoboAuthCredentialsFromProviderLayer.pipe(
			Layer.provideMerge(providerRegistrationLayer),
		);

		try {
			const outcome = await Effect.runPromise(
				Effect.gen(function* () {
					const authProvider = yield* getAuthProvider<
						HoboAuthProfileConfig,
						HoboAuthResolvedCredentials
					>(HOBO_AUTH_PROVIDER_NAME);
					const profiles = yield* ProfileStore;

					const configureWith = authProvider.configureWith;
					if (configureWith === undefined) {
						return yield* AuthError.make({
							message: "HoboAuth configureWith missing",
						});
					}

					const rejectedEnvLocator = yield* Effect.exit(
						configureWith("default", {
							method: "better-auth-session",
							values: {
								issuerOrigin: "https://auth.hobo.test",
								basePath: "/api/auth",
								stage: "prod",
								boxId: "box-alpha-1",
								secretStore: "infisical",
								project: "hobo-prod",
								path: "/hobo-auth",
								signingSecretLocator: `${"env"}://FORBIDDEN_SECRET`,
								databaseTarget: "sqlite",
							},
						}),
					);

					const configured = yield* configureWith("default", {
						method: "better-auth-session",
						values: {
							issuerOrigin: "https://auth.hobo.test",
							basePath: "/api/auth",
							stage: "prod",
							boxId: "box-alpha-1",
							secretStore: "infisical",
							project: "hobo-prod",
							path: "/hobo-auth",
							signingSecretLocator: "owner://HOBO_AUTH_SECRET",
							databaseTarget: "sqlite",
							sessionHandleDigest: "sha256:0123456789abcdef0123456789abcdef",
						},
					});

					yield* profiles.setProviderConfig(
						"default",
						HOBO_AUTH_PROVIDER_NAME,
						configured,
					);
					const reloaded = yield* profiles.loadProviderConfig(
						authProvider,
						"default",
					);
					const details = renderHoboAuthProfileDetails("default", reloaded);

					const credentialAccessor = yield* HoboAuthCredentials;
					const firstRead = yield* credentialAccessor;
					const secondRead = yield* credentialAccessor;
					const resolveCountAfterCache = resolveCount;

					expired = true;
					const reauthExit = yield* Effect.exit(
						authProvider.read("default", Effect.succeed(reloaded)),
					);

					expired = false;
					const refreshed = yield* authProvider.login("default", reloaded);
					yield* authProvider.logout("default", reloaded);

					return {
						rejectedEnvLocator,
						reloaded,
						details,
						firstRead,
						secondRead,
						resolveCountAfterCache,
						reauthExit,
						refreshed,
					};
				}).pipe(Effect.provide(credentialsLayer)),
			);

			expect(Exit.isFailure(outcome.rejectedEnvLocator)).toBe(true);
			expect(outcome.reloaded.method).toBe("better-auth-session");
			expect(outcome.details.lines).toContainEqual({
				key: "signingSecretLocator",
				value: "owner://HOBO_AUTH_SECRET",
			});
			expect(outcome.details.lines).toContainEqual({
				key: "sessionHandle",
				value: "sha256:01234567****",
			});
			expect(JSON.stringify(outcome.details)).not.toContain(
				"brokered-owner-signing-secret",
			);
			expect(String(outcome.firstRead.signingSecret)).toBe("<redacted>");
			expect(outcome.firstRead.profileName).toBe("default");
			expect(outcome.secondRead.boxId).toBe("box-alpha-1");
			expect(outcome.resolveCountAfterCache).toBe(1);
			expect(resolveCount).toBe(2);
			expect(Exit.isFailure(outcome.reauthExit)).toBe(true);
			if (Exit.isFailure(outcome.reauthExit)) {
				const reason = outcome.reauthExit.cause.reasons[0];
				expect(reason?._tag).toBe("Fail");
				if (reason?._tag === "Fail") {
					expect(reason.error).toBeInstanceOf(NeedsReauth);
				}
			}
			expect(outcome.refreshed?.method).toBe("better-auth-session");
			expect(loggedOut).toBe(true);
		} finally {
			if (previousAlchemyHome === undefined) {
				delete process.env.ALCHEMY_HOME;
			} else {
				process.env.ALCHEMY_HOME = previousAlchemyHome;
			}
		}
	});

	it("returns AuthError when configure is called interactively with no currentConfig", async () => {
		const brokerLayer = Layer.succeed(HoboAuthCredentialBroker, {
			resolveForProfile: () =>
				Effect.fail(AuthError.make({ message: "unused" })),
			refreshForProfile: ({ config }) => Effect.succeed(config),
			logoutForProfile: () => Effect.void,
		});
		const baseLayer = Layer.mergeAll(
			NodeServices.layer,
			SecureRandom.layerWebCrypto,
			AuthProvidersLive,
			brokerLayer,
		);
		const regLayer = HoboAuthProviderLayer.pipe(Layer.provideMerge(baseLayer));

		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const authProvider = yield* getAuthProvider<
					HoboAuthProfileConfig,
					HoboAuthResolvedCredentials
				>(HOBO_AUTH_PROVIDER_NAME);
				return yield* Effect.exit(authProvider.configure("default", undefined));
			}).pipe(Effect.provide(regLayer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("isolates createOwnerStoreConfigLayer so unmapped keys never fall through to outer ConfigProviders", async () => {
		const outerLayer = ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				AMBIENT_LEAK: "should-never-be-visible",
				HOBO_AUTH_SECRET: "ambient-override-forbidden",
			}),
		);
		const ownerLayer = createOwnerStoreConfigLayer({
			keys: {
				HOBO_AUTH_SECRET: "owner://HOBO_AUTH_SECRET",
			},
			resolveCredential: async () => "owner-store-isolated-secret-32-chars",
		}).pipe(Layer.provide(Layer.succeed(Stage, "prod")));

		const combinedLayer = ownerLayer.pipe(Layer.provide(outerLayer));
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const mapped = yield* Config.Redacted("HOBO_AUTH_SECRET");
				const unmappedExit = yield* Effect.exit(Config.String("AMBIENT_LEAK"));
				return {
					mappedValue: Redacted.value(mapped),
					unmappedFailed: Exit.isFailure(unmappedExit),
				};
			}).pipe(Effect.provide(combinedLayer)),
		);

		expect(result.mappedValue).toBe("owner-store-isolated-secret-32-chars");
		expect(result.unmappedFailed).toBe(true);
	});
});
