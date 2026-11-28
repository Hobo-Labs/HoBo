import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	BetterAuth,
	type BetterAuthApiError,
	type BetterAuthInstance,
	BetterAuthMigrationError,
	type BetterAuthProps,
	BetterAuthStorageError,
	Database,
	type DatabaseService,
	SecondaryStorage,
	type SecondaryStorageService,
} from "@alchemy.run/better-auth";
import { Memory as BetterAuthMemory } from "@alchemy.run/better-auth/Memory";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { getMigrations } from "better-auth/db/migration";
import type * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
	type HoboBetterAuthResolvedConfig,
	readHoboBetterAuthConfig,
} from "../environments/index.js";
import { NodeSqliteDialect } from "./node-sqlite-dialect.js";

export {
	BetterAuth,
	type BetterAuthApiError,
	type BetterAuthInstance,
	BetterAuthMemory,
	BetterAuthMigrationError,
	type BetterAuthProps,
	BetterAuthStorageError,
	Database,
	type DatabaseService,
	RuntimeContext,
	SecondaryStorage,
	type SecondaryStorageService,
};

export class HoboBetterAuthUnauthorized extends Data.TaggedError(
	"HoboBetterAuthUnauthorized",
)<{
	readonly message: string;
}> {}

export class HoboBetterAuthUnavailable extends Data.TaggedError(
	"HoboBetterAuthUnavailable",
)<{
	readonly statusCode?: number;
	readonly code?: string;
	readonly message: string;
}> {}

export interface HoboBetterAuthAuthenticatedUser {
	readonly userId: string;
	readonly email: string;
	readonly name: string;
	readonly sessionId: string;
	readonly expiresAtIso: string;
}

export class HoboBetterAuthCurrentUser extends Context.Service<
	HoboBetterAuthCurrentUser,
	HoboBetterAuthAuthenticatedUser
>()("Hobo/BetterAuthCurrentUser") {}

export type HoboBetterAuthOptions = Readonly<{
	readonly id?: string;
	readonly sessionExpiresInSeconds?: number;
	readonly sessionUpdateAgeSeconds?: number;
	readonly storeSessionInDatabase?: boolean;
	readonly enableEmailAndPassword?: boolean;
}>;

export function fingerprintSigningSecret(
	signingSecret: Redacted.Redacted<string>,
): string {
	const digest = createHash("sha256")
		.update(Redacted.value(signingSecret))
		.digest("hex");
	return `sha256:${digest}`;
}

export function createNodeSqliteBetterAuthDatabaseLayer(
	filename: string,
): Layer.Layer<Database> {
	const openDialect = Effect.acquireRelease(
		Effect.sync(() => {
			const dialect = new NodeSqliteDialect(filename);
			return { dialect, type: "sqlite" as const };
		}),
		() => Effect.void,
	);

	return Layer.succeed(Database, {
		provider: "sqlite",
		runtime: openDialect,
		migrate: {
			identity: { driver: "node:sqlite", path: filename },
			connect: Effect.succeed(
				openDialect.pipe(
					Effect.catchDefect((cause) =>
						Effect.fail(
							new BetterAuthMigrationError({
								message: `Failed to open node:sqlite Better Auth database at ${filename}`,
								cause,
							}),
						),
					),
				),
			),
		},
	});
}

export function buildBetterAuthProps(
	config: HoboBetterAuthResolvedConfig,
	options: HoboBetterAuthOptions = {},
): BetterAuthProps {
	const githubSocial = Option.isSome(config.githubAppOAuth)
		? {
				github: {
					clientId: config.githubAppOAuth.value.clientId,
					clientSecret: Redacted.value(
						config.githubAppOAuth.value.clientSecret,
					),
				},
			}
		: undefined;
	return {
		id: options.id ?? "HoboAuth",
		baseURL: config.baseUrl,
		basePath: config.basePath,
		secret: config.signingSecret,
		migrate: false,
		trustedOrigins: [...config.trustedOrigins],
		emailAndPassword: {
			enabled: options.enableEmailAndPassword ?? true,
		},
		session: {
			expiresIn: options.sessionExpiresInSeconds ?? 60 * 60 * 24 * 7,
			updateAge: options.sessionUpdateAgeSeconds ?? 60 * 60 * 24,
			...(options.storeSessionInDatabase !== undefined
				? { storeSessionInDatabase: options.storeSessionInDatabase }
				: undefined),
		},
		...(githubSocial !== undefined
			? { socialProviders: githubSocial }
			: undefined),
	};
}

export function runHoboBetterAuthMigrations(
	options: HoboBetterAuthOptions = {},
): Effect.Effect<
	{ readonly applied: boolean; readonly signingKeyFingerprint: string },
	Config.ConfigError | BetterAuthMigrationError,
	Database | RuntimeContext
> {
	return Effect.gen(function* () {
		const config = yield* readHoboBetterAuthConfig;
		const database = yield* Database;
		const signingKeyFingerprint = fingerprintSigningSecret(
			config.signingSecret,
		);
		if (database.migrate === undefined) {
			return { applied: false, signingKeyFingerprint };
		}
		const migrate = database.migrate;
		yield* Effect.scoped(
			Effect.gen(function* () {
				const connect = yield* migrate.connect;
				const rawDb = yield* connect;
				const props = buildBetterAuthProps(config, options);
				const migrations = yield* Effect.tryPromise({
					try: () =>
						getMigrations({
							...props,
							database: rawDb,
							secret: Redacted.value(config.signingSecret),
						}),
					catch: (cause) =>
						new BetterAuthMigrationError({
							message: "Failed to prepare Better Auth schema migrations",
							cause,
						}),
				});
				yield* Effect.tryPromise({
					try: () => migrations.runMigrations(),
					catch: (cause) =>
						new BetterAuthMigrationError({
							message: "Failed to apply Better Auth schema migrations",
							cause,
						}),
				});
			}),
		);
		return { applied: true, signingKeyFingerprint };
	});
}

export interface HoboBetterAuthService {
	readonly config: HoboBetterAuthResolvedConfig;
	readonly signingKeyFingerprint: string;
	readonly instance: BetterAuthInstance<BetterAuthProps>;
}

export class HoboBetterAuth extends Context.Service<
	HoboBetterAuth,
	HoboBetterAuthService
>()("Hobo/BetterAuth") {}

export function createHoboBetterAuthLayer(
	options: HoboBetterAuthOptions = {},
): Layer.Layer<HoboBetterAuth, Config.ConfigError, Database> {
	return Layer.effect(
		HoboBetterAuth,
		Effect.gen(function* () {
			const config = yield* readHoboBetterAuthConfig;
			const props = buildBetterAuthProps(config, options);
			const instance = yield* BetterAuth(props);
			return {
				config,
				signingKeyFingerprint: fingerprintSigningSecret(config.signingSecret),
				instance,
			};
		}),
	);
}

const SessionSnapshotSchema = Schema.Struct({
	user: Schema.Struct({
		id: Schema.NonEmptyString,
		email: Schema.String,
		name: Schema.String,
	}),
	session: Schema.Struct({
		id: Schema.NonEmptyString,
		expiresAt: Schema.Union([Schema.Date, Schema.String]),
	}),
});

const decodeSessionSnapshot = Schema.decodeUnknownSync(SessionSnapshotSchema);

function toAuthenticatedUser(
	raw: NonNullable<
		Awaited<
			ReturnType<
				BetterAuthInstance<BetterAuthProps>["getSession"]
			> extends Effect.Effect<infer A, never, never>
				? A
				: {
						readonly user: {
							readonly id: string;
							readonly email: string;
							readonly name: string;
						};
						readonly session: {
							readonly id: string;
							readonly expiresAt: Date | string;
						};
					}
		>
	>,
): HoboBetterAuthAuthenticatedUser {
	const parsed = decodeSessionSnapshot(raw);
	const expiresAtIso =
		parsed.session.expiresAt instanceof Date
			? parsed.session.expiresAt.toISOString()
			: parsed.session.expiresAt;
	return {
		userId: parsed.user.id,
		email: parsed.user.email,
		name: parsed.user.name,
		sessionId: parsed.session.id,
		expiresAtIso,
	};
}

export function resolveHoboBetterAuthSession(
	headers?: Headers,
): Effect.Effect<
	HoboBetterAuthAuthenticatedUser,
	HoboBetterAuthUnauthorized | HoboBetterAuthUnavailable,
	HoboBetterAuth | RuntimeContext | HttpServerRequest.HttpServerRequest
> {
	return Effect.gen(function* () {
		const auth = yield* HoboBetterAuth;
		const lookup =
			headers !== undefined
				? auth.instance.getSession(headers)
				: auth.instance.getSession();
		const session = yield* lookup.pipe(
			Effect.mapError(
				(error) =>
					new HoboBetterAuthUnavailable({
						statusCode: error.statusCode,
						...(error.body?.code !== undefined
							? { code: error.body.code }
							: undefined),
						message: `Better Auth session lookup failed (${error.statusCode})`,
					}),
			),
			Effect.catchDefect((defect) =>
				Effect.fail(
					new HoboBetterAuthUnavailable({
						message:
							defect instanceof Error
								? defect.message
								: "Better Auth session lookup defect",
					}),
				),
			),
		);
		if (session === null) {
			return yield* new HoboBetterAuthUnauthorized({
				message: "Authentication required",
			});
		}
		return toAuthenticatedUser(session);
	});
}

export function createHoboBetterAuthHttpApp(options: {
	readonly protectedHandler: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HoboBetterAuthCurrentUser | HttpServerRequest.HttpServerRequest
	>;
}) {
	return Effect.gen(function* () {
		const auth = yield* HoboBetterAuth;
		const request = yield* HttpServerRequest.HttpServerRequest;
		const pathname = new URL(request.url, auth.config.baseUrl).pathname;
		if (
			pathname === auth.config.basePath ||
			pathname.startsWith(`${auth.config.basePath}/`)
		) {
			return yield* auth.instance.fetch;
		}
		if (pathname === "/healthz") {
			return HttpServerResponse.jsonUnsafe({ status: "ok" }, { status: 200 });
		}
		const resolved = yield* Effect.result(resolveHoboBetterAuthSession());
		if (resolved._tag === "Failure") {
			if (resolved.failure._tag === "HoboBetterAuthUnauthorized") {
				return HttpServerResponse.jsonUnsafe(
					{ error: "unauthorized" },
					{ status: 401 },
				);
			}
			return HttpServerResponse.jsonUnsafe(
				{
					error: "authentication_unavailable",
					code: resolved.failure.code ?? "AUTH_BACKEND_ERROR",
				},
				{ status: 503 },
			);
		}
		return yield* options.protectedHandler.pipe(
			Effect.provideService(HoboBetterAuthCurrentUser, resolved.success),
		);
	});
}

export interface SecondaryStorageFaultController {
	setUnavailable(unavailable: boolean): void;
}

export interface MemorySecondaryStorageHandle {
	readonly layer: Layer.Layer<SecondaryStorage>;
	readonly controller: SecondaryStorageFaultController;
}

interface StoredKvEntry {
	readonly value: string;
	readonly expiresAtMs: number | null;
}

export function createMemorySecondaryStorageLayer(options?: {
	readonly now?: () => number;
}): MemorySecondaryStorageHandle {
	const now = options?.now ?? (() => Date.now());
	const entries = new Map<string, StoredKvEntry>();
	let unavailable = false;

	const guardAvailable = (
		operation: string,
	): Effect.Effect<void, BetterAuthStorageError> =>
		unavailable
			? Effect.fail(
					new BetterAuthStorageError({
						message: `SecondaryStorage unavailable during ${operation}`,
					}),
				)
			: Effect.void;

	const readLive = (key: string): StoredKvEntry | undefined => {
		const entry = entries.get(key);
		if (entry === undefined) return undefined;
		if (entry.expiresAtMs !== null && now() >= entry.expiresAtMs) {
			entries.delete(key);
			return undefined;
		}
		return entry;
	};

	const service: SecondaryStorageService = {
		get: (key) =>
			Effect.gen(function* () {
				yield* guardAvailable("get");
				const entry = readLive(key);
				return entry === undefined ? null : entry.value;
			}),
		set: (key, value, ttlSeconds) =>
			Effect.gen(function* () {
				yield* guardAvailable("set");
				const expiresAtMs =
					ttlSeconds !== undefined ? now() + ttlSeconds * 1000 : null;
				entries.set(key, { value, expiresAtMs });
			}),
		delete: (key) =>
			Effect.gen(function* () {
				yield* guardAvailable("delete");
				entries.delete(key);
			}),
		getAndDelete: (key) =>
			Effect.gen(function* () {
				yield* guardAvailable("getAndDelete");
				const entry = readLive(key);
				if (entry === undefined) return null;
				entries.delete(key);
				return entry.value;
			}),
		increment: (key, ttlSeconds) =>
			Effect.gen(function* () {
				yield* guardAvailable("increment");
				const current = readLive(key);
				if (current === undefined) {
					const expiresAtMs = now() + ttlSeconds * 1000;
					entries.set(key, { value: "1", expiresAtMs });
					return 1;
				}
				const parsed = Number.parseInt(current.value, 10);
				const next = (Number.isNaN(parsed) ? 0 : parsed) + 1;
				entries.set(key, {
					value: String(next),
					expiresAtMs: current.expiresAtMs,
				});
				return next;
			}),
	};

	return {
		layer: Layer.succeed(SecondaryStorage, service),
		controller: {
			setUnavailable: (next) => {
				unavailable = next;
			},
		},
	};
}

const KvRowSchema = Schema.Struct({
	value: Schema.String,
	expires_at_ms: Schema.NullOr(Schema.Finite),
});
const decodeKvRow = Schema.decodeUnknownSync(KvRowSchema);

export function createSqliteSecondaryStorageLayer(
	filename: string,
	options?: { readonly now?: () => number },
): Layer.Layer<SecondaryStorage> {
	const now = options?.now ?? (() => Date.now());

	const openStore = () => {
		const db = new DatabaseSync(filename);
		db.exec("PRAGMA busy_timeout = 5000;");
		if (filename !== ":memory:") {
			db.exec("PRAGMA journal_mode = WAL;");
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS hobo_better_auth_secondary_kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at_ms INTEGER
			);
		`);
		return db;
	};

	const withStore = <A>(
		operation: string,
		run: (db: DatabaseSync) => A,
	): Effect.Effect<A, BetterAuthStorageError> =>
		Effect.try({
			try: () => {
				const db = openStore();
				try {
					return run(db);
				} finally {
					db.close();
				}
			},
			catch: (cause) =>
				new BetterAuthStorageError({
					message: `SQLite SecondaryStorage failed during ${operation}`,
					cause,
				}),
		});

	const service: SecondaryStorageService = {
		get: (key) =>
			withStore("get", (db) => {
				const raw = db
					.prepare(
						"SELECT value, expires_at_ms FROM hobo_better_auth_secondary_kv WHERE key = ?",
					)
					.get(key);
				if (raw === undefined) return null;
				const row = decodeKvRow(raw);
				if (row.expires_at_ms !== null && now() >= row.expires_at_ms) {
					db.prepare(
						"DELETE FROM hobo_better_auth_secondary_kv WHERE key = ?",
					).run(key);
					return null;
				}
				return row.value;
			}),
		set: (key, value, ttlSeconds) =>
			withStore("set", (db) => {
				const expiresAtMs =
					ttlSeconds !== undefined ? now() + ttlSeconds * 1000 : null;
				db.prepare(
					`INSERT INTO hobo_better_auth_secondary_kv (key, value, expires_at_ms)
					VALUES (?, ?, ?)
					ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
				).run(key, value, expiresAtMs);
			}),
		delete: (key) =>
			withStore("delete", (db) => {
				db.prepare(
					"DELETE FROM hobo_better_auth_secondary_kv WHERE key = ?",
				).run(key);
			}),
		getAndDelete: (key) =>
			withStore("getAndDelete", (db) => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const raw = db
						.prepare(
							"SELECT value, expires_at_ms FROM hobo_better_auth_secondary_kv WHERE key = ?",
						)
						.get(key);
					if (raw === undefined) {
						db.exec("COMMIT");
						return null;
					}
					const row = decodeKvRow(raw);
					db.prepare(
						"DELETE FROM hobo_better_auth_secondary_kv WHERE key = ?",
					).run(key);
					db.exec("COMMIT");
					if (row.expires_at_ms !== null && now() >= row.expires_at_ms) {
						return null;
					}
					return row.value;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			}),
		increment: (key, ttlSeconds) =>
			withStore("increment", (db) => {
				const currentNow = now();
				db.exec("BEGIN IMMEDIATE");
				try {
					const raw = db
						.prepare(
							"SELECT value, expires_at_ms FROM hobo_better_auth_secondary_kv WHERE key = ?",
						)
						.get(key);
					if (raw === undefined) {
						const expiresAtMs = currentNow + ttlSeconds * 1000;
						db.prepare(
							"INSERT INTO hobo_better_auth_secondary_kv (key, value, expires_at_ms) VALUES (?, '1', ?)",
						).run(key, expiresAtMs);
						db.exec("COMMIT");
						return 1;
					}
					const row = decodeKvRow(raw);
					if (row.expires_at_ms !== null && currentNow >= row.expires_at_ms) {
						const expiresAtMs = currentNow + ttlSeconds * 1000;
						db.prepare(
							"UPDATE hobo_better_auth_secondary_kv SET value = '1', expires_at_ms = ? WHERE key = ?",
						).run(expiresAtMs, key);
						db.exec("COMMIT");
						return 1;
					}
					const parsed = Number.parseInt(row.value, 10);
					const next = (Number.isNaN(parsed) ? 0 : parsed) + 1;
					db.prepare(
						"UPDATE hobo_better_auth_secondary_kv SET value = ? WHERE key = ?",
					).run(String(next), key);
					db.exec("COMMIT");
					return next;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			}),
	};

	return Layer.succeed(SecondaryStorage, service);
}
