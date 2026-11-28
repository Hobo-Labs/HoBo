import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import {
	BetterAuthStorageError,
	createHoboBetterAuthHttpApp,
	createHoboBetterAuthLayer,
	createMemorySecondaryStorageLayer,
	createNodeSqliteBetterAuthDatabaseLayer,
	createSqliteSecondaryStorageLayer,
	HoboBetterAuthCurrentUser,
	RuntimeContext,
	runHoboBetterAuthMigrations,
	SecondaryStorage,
} from "../src/better-auth/index.js";
import { createOwnerStoreSecretProvider } from "../src/environments/index.js";

const MeResponseSchema = Schema.Struct({
	userId: Schema.NonEmptyString,
	email: Schema.String,
	name: Schema.String,
	sessionId: Schema.NonEmptyString,
});
const decodeMeResponse = Schema.decodeUnknownSync(MeResponseSchema);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const SHARED_OWNER_SIGNING_SECRET =
	"hobo-owner-brokered-better-auth-signing-secret-v1-32bytes!";

function extractCookieHeader(headers: Record<string, string>): string {
	const raw = headers["set-cookie"] ?? "";
	return raw
		.split(/,(?=\s*[A-Za-z0-9_.-]+=)/u)
		.map((part) => part.split(";")[0]?.trim() ?? "")
		.filter((part) => part.length > 0)
		.join("; ");
}

function buildConfigLayer(options: {
	readonly baseUrl: string;
	readonly signingSecret?: string;
}) {
	const secretProvider = createOwnerStoreSecretProvider({
		keys: {
			HOBO_AUTH_SECRET: "owner://HOBO_AUTH_SECRET",
		},
		nonSecretValues: {
			HOBO_AUTH_BASE_URL: options.baseUrl,
			HOBO_AUTH_BASE_PATH: "/api/auth",
			HOBO_AUTH_TRUSTED_ORIGINS: `${options.baseUrl},http://box-b.hobo.localhost`,
		},
		resolveCredential: async () =>
			options.signingSecret ?? SHARED_OWNER_SIGNING_SECRET,
	});
	return secretProvider.layer.pipe(Layer.provide(Layer.succeed(Stage, "dev")));
}

function createAuthServerLayer(options: {
	readonly dbPath: string;
	readonly baseUrl: string;
	readonly secondaryStorage?: Layer.Layer<SecondaryStorage>;
	readonly signingSecret?: string;
}) {
	const dbLayer = createNodeSqliteBetterAuthDatabaseLayer(options.dbPath);
	const configLayer = buildConfigLayer({
		baseUrl: options.baseUrl,
		signingSecret: options.signingSecret,
	});
	const authDeps =
		options.secondaryStorage !== undefined
			? Layer.mergeAll(dbLayer, options.secondaryStorage, configLayer)
			: Layer.mergeAll(dbLayer, configLayer);
	const authLayer = createHoboBetterAuthLayer({
		id: "HoboAuthTest",
		storeSessionInDatabase: true,
	}).pipe(Layer.provide(authDeps));

	const httpApp = createHoboBetterAuthHttpApp({
		protectedHandler: Effect.gen(function* () {
			const user = yield* HoboBetterAuthCurrentUser;
			return HttpServerResponse.jsonUnsafe(
				{
					userId: user.userId,
					email: user.email,
					name: user.name,
					sessionId: user.sessionId,
				},
				{ status: 200 },
			);
		}),
	});

	return HttpServer.serve()(httpApp).pipe(
		Layer.provide(Layer.mergeAll(authLayer, RuntimeContext.phantom)),
		Layer.provideMerge(NodeHttpServer.layerTest),
	);
}

describe("Alchemy Better Auth runtime, SQLite restart durability, cross-box reuse, and SecondaryStorage contract", () => {
	it("persists Better Auth sessions in node:sqlite across HoBo server restarts using brokered owner://HOBO_AUTH_SECRET", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-better-auth-restart-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "auth.sqlite");
		const baseUrl = "http://127.0.0.1";

		const migrationOutcome = await Effect.runPromise(
			runHoboBetterAuthMigrations({ id: "HoboAuthTest" }).pipe(
				Effect.provide(
					Layer.mergeAll(
						createNodeSqliteBetterAuthDatabaseLayer(dbPath),
						buildConfigLayer({ baseUrl }),
						RuntimeContext.phantom,
					),
				),
			),
		);
		expect(migrationOutcome.applied).toBe(true);
		expect(migrationOutcome.signingKeyFingerprint).toMatch(
			/^sha256:[0-9a-f]{64}$/u,
		);

		const firstRun = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const anonProtected = yield* client.execute(
					HttpClientRequest.get("/api/me"),
				);
				const signUpRes = yield* client.execute(
					HttpClientRequest.post("/api/auth/sign-up/email").pipe(
						HttpClientRequest.setHeader("origin", baseUrl),
						HttpClientRequest.bodyJsonUnsafe({
							email: "owner@hobo.test",
							password: "hobo-strong-test-password-123!",
							name: "HoBo Owner",
						}),
					),
				);
				const cookie = extractCookieHeader(signUpRes.headers);
				const meBeforeRestart = yield* client.execute(
					HttpClientRequest.get("/api/me").pipe(
						HttpClientRequest.setHeader("cookie", cookie),
					),
				);
				const meBody = decodeMeResponse(yield* meBeforeRestart.json);
				return {
					anonStatus: anonProtected.status,
					signUpStatus: signUpRes.status,
					cookie,
					meStatus: meBeforeRestart.status,
					meBody,
				};
			}).pipe(
				Effect.scoped,
				Effect.provide(createAuthServerLayer({ dbPath, baseUrl })),
			),
		);

		expect(firstRun.anonStatus).toBe(401);
		expect(firstRun.signUpStatus).toBe(200);
		expect(firstRun.cookie.length).toBeGreaterThan(0);
		expect(firstRun.meStatus).toBe(200);
		expect(firstRun.meBody.email).toBe("owner@hobo.test");

		const afterRestart = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const meAfterRestart = yield* client.execute(
					HttpClientRequest.get("/api/me").pipe(
						HttpClientRequest.setHeader("cookie", firstRun.cookie),
					),
				);
				const meBody = decodeMeResponse(yield* meAfterRestart.json);
				return { status: meAfterRestart.status, meBody };
			}).pipe(
				Effect.scoped,
				Effect.provide(createAuthServerLayer({ dbPath, baseUrl })),
			),
		);

		expect(afterRestart.status).toBe(200);
		expect(afterRestart.meBody.userId).toBe(firstRun.meBody.userId);
		expect(afterRestart.meBody.sessionId).toBe(firstRun.meBody.sessionId);

		const rotatedSecretRestart = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const me = yield* client.execute(
					HttpClientRequest.get("/api/me").pipe(
						HttpClientRequest.setHeader("cookie", firstRun.cookie),
					),
				);
				return me.status;
			}).pipe(
				Effect.scoped,
				Effect.provide(
					createAuthServerLayer({
						dbPath,
						baseUrl,
						signingSecret:
							"different-rotated-signing-secret-invalidates-old-cookies-32!",
					}),
				),
			),
		);
		expect(rotatedSecretRestart).toBe(401);
	});

	it("reuses sessions across a second box sharing SQLite + SecondaryStorage + brokered secret, and propagates sign-out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-better-auth-cross-box-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "shared-auth.sqlite");
		const secondaryPath = join(dir, "shared-secondary.sqlite");
		const baseUrl = "http://127.0.0.1";

		await Effect.runPromise(
			runHoboBetterAuthMigrations({ id: "HoboAuthTest" }).pipe(
				Effect.provide(
					Layer.mergeAll(
						createNodeSqliteBetterAuthDatabaseLayer(dbPath),
						buildConfigLayer({ baseUrl }),
						RuntimeContext.phantom,
					),
				),
			),
		);

		const boxAServer = createAuthServerLayer({
			dbPath,
			baseUrl,
			secondaryStorage: createSqliteSecondaryStorageLayer(secondaryPath),
		});
		const boxBServer = createAuthServerLayer({
			dbPath,
			baseUrl,
			secondaryStorage: createSqliteSecondaryStorageLayer(secondaryPath),
		});

		const signedInOnBoxA = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const signUpRes = yield* client.execute(
					HttpClientRequest.post("/api/auth/sign-up/email").pipe(
						HttpClientRequest.setHeader("origin", baseUrl),
						HttpClientRequest.bodyJsonUnsafe({
							email: "multibox@hobo.test",
							password: "multibox-strong-password-456!",
							name: "MultiBox Owner",
						}),
					),
				);
				return {
					status: signUpRes.status,
					cookie: extractCookieHeader(signUpRes.headers),
				};
			}).pipe(Effect.scoped, Effect.provide(boxAServer)),
		);
		expect(signedInOnBoxA.status).toBe(200);

		const boxBAuthorized = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const res = yield* client.execute(
					HttpClientRequest.get("/api/me").pipe(
						HttpClientRequest.setHeader("cookie", signedInOnBoxA.cookie),
					),
				);
				const body = decodeMeResponse(yield* res.json);
				return { status: res.status, email: body.email };
			}).pipe(Effect.scoped, Effect.provide(boxBServer)),
		);
		expect(boxBAuthorized.status).toBe(200);
		expect(boxBAuthorized.email).toBe("multibox@hobo.test");

		const signOutOnBoxA = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const res = yield* client.execute(
					HttpClientRequest.post("/api/auth/sign-out").pipe(
						HttpClientRequest.setHeader("origin", baseUrl),
						HttpClientRequest.setHeader("cookie", signedInOnBoxA.cookie),
					),
				);
				return res.status;
			}).pipe(Effect.scoped, Effect.provide(boxAServer)),
		);
		expect(signOutOnBoxA).toBe(200);

		const boxBAfterSignOut = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const res = yield* client.execute(
					HttpClientRequest.get("/api/me").pipe(
						HttpClientRequest.setHeader("cookie", signedInOnBoxA.cookie),
					),
				);
				return res.status;
			}).pipe(Effect.scoped, Effect.provide(boxBServer)),
		);
		expect(boxBAfterSignOut).toBe(401);
	});

	it("returns HTTP 503 when Better Auth session storage is unavailable (distinguishing 401 vs 503)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-better-auth-outage-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "auth-outage.sqlite");
		const baseUrl = "http://127.0.0.1";
		const { layer: secondaryLayer, controller } =
			createMemorySecondaryStorageLayer();

		await Effect.runPromise(
			runHoboBetterAuthMigrations({ id: "HoboAuthTest" }).pipe(
				Effect.provide(
					Layer.mergeAll(
						createNodeSqliteBetterAuthDatabaseLayer(dbPath),
						buildConfigLayer({ baseUrl }),
						RuntimeContext.phantom,
					),
				),
			),
		);

		const serverLayer = createAuthServerLayer({
			dbPath,
			baseUrl,
			secondaryStorage: secondaryLayer,
		});

		const statusOnOutage = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const signUpRes = yield* client.execute(
					HttpClientRequest.post("/api/auth/sign-up/email").pipe(
						HttpClientRequest.setHeader("origin", baseUrl),
						HttpClientRequest.bodyJsonUnsafe({
							email: "outage@hobo.test",
							password: "outage-strong-password-789!",
							name: "Outage Test",
						}),
					),
				);
				const cookie = extractCookieHeader(signUpRes.headers);
				controller.setUnavailable(true);
				const res = yield* client.execute(
					HttpClientRequest.get("/api/me").pipe(
						HttpClientRequest.setHeader("cookie", cookie),
					),
				);
				return res.status;
			}).pipe(Effect.scoped, Effect.provide(serverLayer)),
		);

		expect(statusOnOutage).toBe(503);
	});

	it("verifies all five SecondaryStorage contract invariants on memory and SQLite adapters", async () => {
		let nowMs = 1_700_000_000_000;
		const advanceSeconds = (seconds: number) => {
			nowMs += seconds * 1000;
		};
		const dir = mkdtempSync(join(tmpdir(), "hobo-secondary-contract-"));
		tempDirs.push(dir);
		const memory = createMemorySecondaryStorageLayer({ now: () => nowMs });
		const sqliteLayer = createSqliteSecondaryStorageLayer(
			join(dir, "secondary.sqlite"),
			{ now: () => nowMs },
		);

		const adapters = [
			{ name: "memory", layer: memory.layer },
			{ name: "sqlite", layer: sqliteLayer },
		] as const;

		for (const adapter of adapters) {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* SecondaryStorage;
					const counters = yield* Effect.all(
						Array.from({ length: 5 }, () => storage.increment("rl:fixed", 10)),
						{ concurrency: "unbounded" },
					);

					advanceSeconds(6);
					const sixth = yield* storage.increment("rl:fixed", 10);

					advanceSeconds(5);
					const resetCounter = yield* storage.increment("rl:fixed", 10);

					yield* storage.set("once:key", "secret-handle", 30);
					const getDelOutcomes = yield* Effect.all(
						Array.from({ length: 4 }, () => storage.getAndDelete("once:key")),
						{ concurrency: "unbounded" },
					);

					yield* storage.set("ttl:key", "short-lived", 5);
					const beforeExpiry = yield* storage.get("ttl:key");
					advanceSeconds(6);
					const afterExpiry = yield* storage.get("ttl:key");

					yield* storage.delete("never-existed");

					return {
						counters: [...counters].sort((a, b) => a - b),
						sixth,
						resetCounter,
						getDelOutcomes,
						beforeExpiry,
						afterExpiry,
					};
				}).pipe(
					Effect.provide(Layer.merge(adapter.layer, RuntimeContext.phantom)),
				),
			);

			expect(result.counters, adapter.name).toEqual([1, 2, 3, 4, 5]);
			expect(result.sixth, adapter.name).toBe(6);
			expect(result.resetCounter, adapter.name).toBe(1);
			expect(
				result.getDelOutcomes.filter((v) => v === "secret-handle"),
				adapter.name,
			).toHaveLength(1);
			expect(
				result.getDelOutcomes.filter((v) => v === null),
				adapter.name,
			).toHaveLength(3);
			expect(result.beforeExpiry, adapter.name).toBe("short-lived");
			expect(result.afterExpiry, adapter.name).toBeNull();
		}

		memory.controller.setUnavailable(true);
		const failedExit = await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* SecondaryStorage;
				return yield* Effect.exit(storage.get("any-key"));
			}).pipe(
				Effect.provide(Layer.merge(memory.layer, RuntimeContext.phantom)),
			),
		);
		expect(Exit.isFailure(failedExit)).toBe(true);
		if (Exit.isFailure(failedExit)) {
			const reason = failedExit.cause.reasons[0];
			expect(reason?._tag).toBe("Fail");
			if (reason?._tag === "Fail") {
				expect(reason.error).toBeInstanceOf(BetterAuthStorageError);
			}
		}
	});
});
