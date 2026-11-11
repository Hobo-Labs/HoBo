import { createCipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseConfiguration } from "@hobo/ci";
import { PostgresCiStore } from "@hobo/ci/postgres";
import { createHostedAppBootstrap } from "@hobo/ci-gh-actions";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
	type ScratchDatabase,
	withScratchDatabases,
} from "../../ci/db/tooling/index.js";
import { StoreUnavailable } from "../src/bootstrap-entry.js";
import type { RelayDatabase } from "../src/database-connections.js";
import { pgExecutor } from "../src/database-fleet-executor.js";
import { importRelayData } from "../src/database-selection-import.js";
import {
	promoteStore,
	readStoreMarker,
} from "../src/database-selection-marker.js";
import {
	createSelectedRelay,
	type SelectionLogRecord,
	StoreSelectionUndecided,
	selectableStores,
	selectStore,
} from "../src/database-selection-relay.js";
import { composeRelay } from "../src/relay-composition.js";
import { prepareRelaySchema } from "../src/relay-schema.js";

/** Real PostgreSQL: one disposable server whose role may create databases.
 * Every test makes its own databases on it and drops them. */
const server = process.env.HOBO_TEST_POSTGRES_URL;
const TIMEOUT_MS = 120_000;

function urlOf(database: ScratchDatabase): string {
	const url = new URL(server ?? "");
	url.pathname = `/${database.name}`;
	return url.toString();
}

/** The same store with a credential the server rejects: class 28. */
function rejectedCredential(connection: string): string {
	const url = new URL(connection);
	url.username = `hobo_ci_no_such_role_${randomBytes(4).toString("hex")}`;
	return url.toString();
}

/** A database the server does not have: 3D000. */
function missingDatabase(connection: string): string {
	const url = new URL(connection);
	url.pathname = `/hobo_ci_absent_${randomBytes(4).toString("hex")}`;
	return url.toString();
}

/** An address nothing listens on, so the attempt fails without an answer
 * from any server. */
const UNREACHABLE = "postgres://hobo_ci@127.0.0.1:1/postgres";

/** Two attached stores, as a Vercel project names them: the old one
 * unprefixed, the new one under `NEW_`. */
function attached(old: string, fresh: string) {
	return selectableStores({
		DATABASE_URL: old,
		DATABASE_URL_UNPOOLED: old,
		NEW_DATABASE_URL: fresh,
		NEW_DATABASE_URL_UNPOOLED: fresh,
	});
}

function recorder() {
	const records: SelectionLogRecord[] = [];
	return { records, log: (record: SelectionLogRecord) => records.push(record) };
}

async function markerRows(pool: pg.Pool) {
	const present = await pool.query(
		"SELECT to_regclass('hobo_ci_store_selection') IS NOT NULL AS present",
	);
	if (!present.rows[0]?.present) return undefined;
	const rows = await pool.query(
		`SELECT generation::text AS generation, reason, imported_from,
			imported_at IS NOT NULL AS imported FROM hobo_ci_store_selection ORDER BY generation`,
	);
	return rows.rows;
}

const key = Buffer.alloc(32, 7);
const credentials = {
	pem: "-----BEGIN RSA PRIVATE KEY-----\nrelay\n-----END RSA PRIVATE KEY-----",
	webhookSecret: "w".repeat(40),
	clientId: "Iv1.selection",
	clientSecret: "client-secret",
};

/** The App vault's envelope: version, nonce, tag, AES-256-GCM ciphertext. */
function seal(appId: number): Buffer {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(`hobo-ci-app:v1:${appId}`));
	const encrypted = Buffer.concat([
		cipher.update(JSON.stringify(credentials)),
		cipher.final(),
	]);
	return Buffer.concat([
		Buffer.from([1]),
		nonce,
		cipher.getAuthTag(),
		encrypted,
	]);
}

/** A store the relay has lived on: a registered App, its credentials, an
 * installation and a configuration with an account. */
async function registerApp(pool: pg.Pool) {
	// The relay ran on this store: its stores initialised it as a writer.
	await prepareRelaySchema(pool, "old", "writer");
	await pool.query(
		`INSERT INTO hobo_ci_platform_app (singleton, status, session_digest, token_digest, state_digest, expires_ms, app_id)
		VALUES (true, 'ready', $1, $2, '', 0, 42)`,
		["a".repeat(64), "b".repeat(64)],
	);
	await pool.query(
		"INSERT INTO hobo_ci_app_credentials (app_id, ciphertext) VALUES (42, $1)",
		[seal(42)],
	);
	await pool.query(
		"INSERT INTO hobo_ci_app_installations (installation_id, app_id, account_id) VALUES (7, 42, 'example')",
	);
	await configureAccount(pool);
}

async function configureAccount(pool: pg.Pool) {
	await new PostgresCiStore(pool).configure(
		parseConfiguration(
			await readFile(
				new URL(
					"../../ci/data-models/fixtures/valid/configuration.json",
					import.meta.url,
				),
				"utf8",
			),
		),
		0,
		new Date().toISOString(),
	);
}

/** What the relay itself would find on a store: the App it loads at start-up
 * and the accounts in its configuration. */
async function registrationOn(pool: pg.Pool) {
	const bootstrap = createHostedAppBootstrap({
		pool,
		key,
		publicOrigin: "https://ci.hobo.test",
		accountId: "example",
		bootstrapTokenSha256: "c".repeat(64),
	});
	return {
		app: await bootstrap.load(),
		accounts: (
			await new PostgresCiStore(pool).configuration()
		)?.configuration?.accounts.map((account) => account.id),
		installations: (
			await pool.query(
				"SELECT installation_id::text AS id, account_id FROM hobo_ci_app_installations ORDER BY 1",
			)
		).rows,
	};
}

function scratch(
	labels: readonly string[],
	run: (databases: readonly ScratchDatabase[]) => Promise<void>,
) {
	return withScratchDatabases(server ?? "", labels, run);
}

function both(databases: readonly ScratchDatabase[]) {
	const [old, fresh] = databases;
	if (!old || !fresh) throw new Error("scratch databases missing");
	return { old, fresh, oldUrl: urlOf(old), freshUrl: urlOf(fresh) };
}

describe.skipIf(!server)("store selection on PostgreSQL", () => {
	it(
		"chooses the unprefixed store on the first run, marks it once and leaves the other untouched",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const { records, log } = recorder();
				const first = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(first.store.prefix).toBe("");
				expect(first.reason).toBe("first-run");
				expect(await markerRows(old.pool)).toEqual([
					{
						generation: String(first.generation),
						reason: "first-run",
						imported_from: null,
						imported: false,
					},
				]);
				// A store that was only looked at holds nothing new.
				expect(await markerRows(fresh.pool)).toBeUndefined();
				// The generation is the store's clock, in milliseconds.
				expect(Math.abs(first.generation - Date.now())).toBeLessThan(600_000);
				expect(records).toEqual([
					{
						event: "hobo_ci_database_selected",
						prefix: "",
						binding: "explicit",
						database: first.store.database,
						generation: first.generation,
						reason: "first-run",
						candidates: [
							{
								prefix: "",
								database: first.store.database,
								class: "serving",
								generation: 0,
							},
							{
								prefix: "NEW_",
								database: expect.stringMatching(/^[0-9a-f]{12}$/),
								class: "serving",
								generation: 0,
							},
						],
					},
				]);
				// Names and digests only.
				expect(JSON.stringify(records)).not.toContain("127.0.0.1");
				expect(JSON.stringify(records)).not.toContain(old.name);

				// Every later start finds the marker and writes nothing.
				const again = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(again).toMatchObject({
					reason: "marker",
					generation: first.generation,
				});
				expect(again.store.prefix).toBe("");
				expect(await markerRows(old.pool)).toHaveLength(1);
				expect(await markerRows(fresh.pool)).toBeUndefined();
			}),
		TIMEOUT_MS,
	);

	it(
		"passes over a store that refuses, stays on the other when the first answers again, and does not flip back later",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const { records, log } = recorder();
				// The relay lived on the old store first.
				const before = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(before.store.prefix).toBe("");

				// The old store refuses: the server answers, with class 28.
				const moved = await selectStore(
					attached(rejectedCredential(oldUrl), freshUrl),
					{ log },
				);
				expect(moved.store.prefix).toBe("NEW_");
				expect(moved.reason).toBe("previous-refusing");
				expect(moved.generation).toBeGreaterThan(before.generation);
				expect(records.at(-1)).toMatchObject({
					event: "hobo_ci_database_selected",
					prefix: "NEW_",
					candidates: [
						{ prefix: "", class: "refusing", sqlstate: "28000" },
						{ prefix: "NEW_", class: "serving", generation: 0 },
					],
				});
				expect(await markerRows(fresh.pool)).toEqual([
					{
						generation: String(moved.generation),
						reason: "previous-refusing",
						imported_from: null,
						imported: false,
					},
				]);

				// The old store answers again, with its older generation.
				const stayed = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(stayed).toMatchObject({
					reason: "marker",
					generation: moved.generation,
				});
				expect(stayed.store.prefix).toBe("NEW_");
				expect(await markerRows(old.pool)).toEqual([
					expect.objectContaining({ generation: String(before.generation) }),
				]);

				// Now the new store refuses. The old one is used again and has to
				// outrank the new one's marker, which nobody could read.
				const back = await selectStore(
					attached(oldUrl, rejectedCredential(freshUrl)),
					{ log },
				);
				expect(back.store.prefix).toBe("");
				expect(back.reason).toBe("previous-refusing");
				expect(back.generation).toBeGreaterThan(moved.generation);
				expect(await markerRows(old.pool)).toHaveLength(1);

				// Both answer: the relay stays where it last moved to.
				const settled = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(settled).toMatchObject({
					reason: "marker",
					generation: back.generation,
				});
				expect(settled.store.prefix).toBe("");
			}),
		TIMEOUT_MS,
	);

	it(
		"treats a database the server does not have as a refusal",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { fresh, oldUrl, freshUrl } = both(databases);
				const { records, log } = recorder();
				const chosen = await selectStore(
					attached(missingDatabase(oldUrl), freshUrl),
					{ log },
				);
				expect(chosen.store.prefix).toBe("NEW_");
				expect(records[0]).toMatchObject({
					candidates: [
						{ prefix: "", class: "refusing", sqlstate: "3D000" },
						{ prefix: "NEW_", class: "serving" },
					],
				});
				expect(await markerRows(fresh.pool)).toHaveLength(1);
			}),
		TIMEOUT_MS,
	);

	it(
		"does not choose, and writes nothing, while a candidate cannot be classified",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const { records, log } = recorder();
				// Even with a marked, serving store next to it.
				await selectStore(attached(oldUrl, freshUrl), { log });
				const marked = await markerRows(old.pool);
				records.length = 0;
				await expect(
					selectStore(attached(oldUrl, UNREACHABLE), {
						log,
						probeTimeoutMs: 2000,
					}),
				).rejects.toBeInstanceOf(StoreSelectionUndecided);
				await expect(
					selectStore(attached(UNREACHABLE, freshUrl), {
						log,
						probeTimeoutMs: 2000,
					}),
				).rejects.toBeInstanceOf(StoreSelectionUndecided);
				expect(records).toEqual([
					{
						event: "hobo_ci_database_selection_undecided",
						cause: "unclassified-candidate",
						candidates: [
							expect.objectContaining({ prefix: "", class: "serving" }),
							{
								prefix: "NEW_",
								database: expect.any(String),
								class: "unknown",
								code: "ECONNREFUSED",
							},
						],
					},
					{
						event: "hobo_ci_database_selection_undecided",
						cause: "unclassified-candidate",
						candidates: [
							expect.objectContaining({ prefix: "", class: "unknown" }),
							expect.objectContaining({ prefix: "NEW_", class: "serving" }),
						],
					},
				]);
				expect(await markerRows(old.pool)).toEqual(marked);
				expect(await markerRows(fresh.pool)).toBeUndefined();
			}),
		TIMEOUT_MS,
	);

	it(
		"leaves one marker row when many instances select at once",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const quiet = { log: () => {} };
				const first = await Promise.all(
					Array.from({ length: 8 }, () =>
						selectStore(attached(oldUrl, freshUrl), quiet),
					),
				);
				expect(new Set(first.map((entry) => entry.store.prefix))).toEqual(
					new Set([""]),
				);
				expect(new Set(first.map((entry) => entry.generation)).size).toBe(1);
				expect(await markerRows(old.pool)).toHaveLength(1);
				expect(await markerRows(fresh.pool)).toBeUndefined();

				// And when they all promote the other store at once.
				const refused = rejectedCredential(oldUrl);
				const moved = await Promise.all(
					Array.from({ length: 8 }, () =>
						selectStore(attached(refused, freshUrl), quiet),
					),
				);
				expect(new Set(moved.map((entry) => entry.store.prefix))).toEqual(
					new Set(["NEW_"]),
				);
				// One that probed after another had written renews the generation,
				// because the refusing store still cannot be read. The store ends
				// with the one newest row either way.
				expect(await markerRows(fresh.pool)).toEqual([
					expect.objectContaining({
						generation: String(
							Math.max(...moved.map((entry) => entry.generation)),
						),
						reason: "previous-refusing",
					}),
				]);
				expect(await markerRows(old.pool)).toHaveLength(1);
			}),
		TIMEOUT_MS,
	);

	it(
		"carries a registered App and its account into the pristine chosen store, once",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const { records, log } = recorder();
				await registerApp(old.pool);
				const expected = await registrationOn(old.pool);
				expect(expected.app).toMatchObject({ appId: 42, ...credentials });
				expect(expected.accounts).toEqual(["example"]);

				// The old store is over its quota: the relay starts on the new one,
				// which has nothing. There is nobody to read from.
				const moved = await selectStore(
					attached(rejectedCredential(oldUrl), freshUrl),
					{ log },
				);
				expect(moved.store.prefix).toBe("NEW_");
				expect(records.map((record) => record.event)).toEqual([
					"hobo_ci_database_selected",
				]);

				// A month later the old store answers and the new one is still empty.
				const stayed = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(stayed.store.prefix).toBe("NEW_");
				expect(stayed.reason).toBe("marker");
				const imported = records.at(-1);
				expect(imported).toMatchObject({
					event: "hobo_ci_database_import",
					status: "imported",
					target: stayed.store.database,
				});
				if (
					imported?.event !== "hobo_ci_database_import" ||
					imported.status !== "imported"
				)
					throw new Error("the import did not happen");
				expect(imported.rows).toBeGreaterThan(3);
				// The registration came across and the relay's own code reads it.
				expect(await registrationOn(fresh.pool)).toEqual(expected);
				expect(await markerRows(fresh.pool)).toEqual([
					{
						generation: String(moved.generation),
						reason: "previous-refusing",
						imported_from: imported.source,
						imported: true,
					},
				]);
				// The old store was read, not marked. Its migrations created the
				// marker table, empty, which reads as no generation.
				expect(await markerRows(old.pool)).toEqual([]);

				// It never repeats, whatever the old store holds later.
				await old.pool.query(
					"UPDATE hobo_ci_app_installations SET account_id = 'changed'",
				);
				records.length = 0;
				await selectStore(attached(oldUrl, freshUrl), { log });
				expect(records.map((record) => record.event)).toEqual([
					"hobo_ci_database_selected",
				]);
				expect(await registrationOn(fresh.pool)).toEqual(expected);
				expect(
					await importRelayData({
						source: {
							database: imported.source,
							settings: { connectionString: oldUrl },
						},
						target: {
							database: imported.target,
							settings: { connectionString: freshUrl },
						},
					}),
				).toMatchObject({ status: "refused", refusal: "already-imported" });
				expect(await registrationOn(fresh.pool)).toEqual(expected);

				// The record of the import moves with the generation.
				const renewed = await selectStore(
					attached(rejectedCredential(oldUrl), freshUrl),
					{ log },
				);
				expect(renewed.generation).toBeGreaterThan(moved.generation);
				expect(await markerRows(fresh.pool)).toEqual([
					expect.objectContaining({
						generation: String(renewed.generation),
						imported_from: imported.source,
						imported: true,
					}),
				]);
			}),
		TIMEOUT_MS,
	);

	it(
		"refuses to import into a store that is not pristine, or was never selected",
		() =>
			scratch(["old", "new", "other"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const other = databases[2];
				if (!other) throw new Error("scratch database missing");
				const { records, log } = recorder();
				await registerApp(old.pool);
				await selectStore(attached(rejectedCredential(oldUrl), freshUrl), {
					log,
				});
				// Someone onboarded on the new store before the old one came back.
				await prepareRelaySchema(fresh.pool, "new", "writer");
				await configureAccount(fresh.pool);
				await fresh.pool.query(
					"INSERT INTO hobo_ci_app_installations (installation_id, app_id, account_id) VALUES (9, 77, 'example')",
				);
				const before = await registrationOn(fresh.pool);
				expect(before.app).toBeUndefined();

				records.length = 0;
				const stayed = await selectStore(attached(oldUrl, freshUrl), { log });
				expect(stayed.store.prefix).toBe("NEW_");
				expect(records.at(-1)).toMatchObject({
					event: "hobo_ci_database_import",
					status: "refused",
					refusal: "not-pristine",
				});
				expect(await registrationOn(fresh.pool)).toEqual(before);

				// The same answer from inside the import's own transaction, which
				// is the check that decides.
				const sides = {
					source: { database: "old", settings: { connectionString: oldUrl } },
					target: { database: "new", settings: { connectionString: freshUrl } },
				};
				expect(await importRelayData(sides)).toMatchObject({
					status: "refused",
					refusal: "not-pristine",
				});
				expect(await registrationOn(fresh.pool)).toEqual(before);
				expect(await markerRows(fresh.pool)).toEqual([
					expect.objectContaining({ imported_from: null, imported: false }),
				]);

				// A store that holds no generation is not the relay's store.
				expect(
					await importRelayData({
						...sides,
						target: {
							database: "other",
							settings: { connectionString: urlOf(other) },
						},
					}),
				).toMatchObject({ status: "refused", refusal: "not-selected" });
				expect((await registrationOn(other.pool)).installations).toEqual([]);
			}),
		TIMEOUT_MS,
	);

	it(
		"refuses a source that is too large or whose schema differs, and leaves the target as it was",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				await registerApp(old.pool);
				await promoteStore(pgExecutor(fresh.pool), {
					held: 0,
					atLeast: 1,
					reason: "first-run",
				});
				const sides = {
					source: { database: "old", settings: { connectionString: oldUrl } },
					target: { database: "new", settings: { connectionString: freshUrl } },
				};
				expect(
					await importRelayData({ ...sides, limits: { maxRows: 2 } }),
				).toMatchObject({ status: "refused", refusal: "oversized" });
				expect(
					await importRelayData({ ...sides, limits: { maxBytes: 16 } }),
				).toMatchObject({ status: "refused", refusal: "oversized" });

				await old.pool.query(
					"ALTER TABLE hobo_ci_app_installations ADD COLUMN left_behind text",
				);
				expect(await importRelayData(sides)).toEqual({
					status: "refused",
					refusal: "schema-mismatch",
					detail:
						"column hobo_ci_app_installations.left_behind is missing on target",
				});
				// Nothing arrived and nothing was recorded, so it can still happen.
				const untouched = await registrationOn(fresh.pool);
				expect(untouched.app).toBeUndefined();
				expect(untouched.installations).toEqual([]);
				expect(await readStoreMarker(pgExecutor(fresh.pool))).toMatchObject({
					imported: false,
				});

				await old.pool.query(
					"ALTER TABLE hobo_ci_app_installations DROP COLUMN left_behind",
				);
				expect(await importRelayData(sides)).toMatchObject({
					status: "imported",
				});
				expect(await registrationOn(fresh.pool)).toEqual(
					await registrationOn(old.pool),
				);
			}),
		TIMEOUT_MS,
	);

	it(
		"migrates the source without touching its rows, and refuses one ahead of this release",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				await registerApp(old.pool);
				// A table the old relay never needed, so never created, and no
				// migration ledger: the old store predates the runner.
				await old.pool.query(
					"DROP TABLE hobo_ci_queued_scans, hobo_ci_schema_migrations",
				);
				const before = await registrationOn(old.pool);
				await promoteStore(pgExecutor(fresh.pool), {
					held: 0,
					atLeast: 1,
					reason: "first-run",
				});
				const sides = {
					source: { database: "old", settings: { connectionString: oldUrl } },
					target: { database: "new", settings: { connectionString: freshUrl } },
				};
				const ledger = (pool: pg.Pool) =>
					pool.query(
						"SELECT scope, id FROM hobo_ci_schema_migrations ORDER BY scope, id",
					);

				expect(await importRelayData(sides)).toMatchObject({
					status: "imported",
				});
				// The source got the missing table and its ledger, and nothing else.
				expect(await registrationOn(old.pool)).toEqual(before);
				expect(
					(
						await old.pool.query(
							"SELECT count(*)::int AS rows FROM hobo_ci_queued_scans",
						)
					).rows,
				).toEqual([{ rows: 0 }]);
				expect(await markerRows(old.pool)).toEqual([]);
				// One ledger, keyed by scope: two packages' `0001_` migrations do
				// not collide.
				const expected = [
					{ scope: "@hobo/ci", id: "0000_baseline" },
					{ scope: "@hobo/ci", id: "0001_events_account" },
					{ scope: "@hobo/ci-gh-actions", id: "0000_baseline" },
					{ scope: "@hobo/ci-vercel", id: "0000_baseline" },
					{ scope: "@hobo/ci-vercel", id: "0001_store_selection" },
				];
				expect((await ledger(old.pool)).rows).toEqual(expected);
				expect((await ledger(fresh.pool)).rows).toEqual(expected);
				expect(await registrationOn(fresh.pool)).toEqual(before);

				// A source a newer release has migrated is left exactly as it is.
				await fresh.pool.query("TRUNCATE hobo_ci_store_selection");
				await promoteStore(pgExecutor(fresh.pool), {
					held: 0,
					atLeast: 1,
					reason: "first-run",
				});
				await old.pool.query(
					`INSERT INTO hobo_ci_schema_migrations (scope, id, sql_sha256, plan_digest, engine)
					VALUES ('@hobo/ci-vercel', '0002_from_the_future', 'x', 'x', 'x')`,
				);
				expect(await importRelayData(sides)).toEqual({
					status: "refused",
					refusal: "schema-ahead",
					detail:
						"the source records @hobo/ci-vercel migrations this release does not have: 0002_from_the_future",
				});
				expect(await readStoreMarker(pgExecutor(fresh.pool))).toMatchObject({
					imported: false,
				});
			}),
		TIMEOUT_MS,
	);

	it(
		"runs the real relay on the chosen store when the old one refuses and a new one is attached",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const refused = rejectedCredential(oldUrl);
				const origin = "https://ci.hobo.test";
				const lines: string[] = [];
				const info = vi.spyOn(console, "info").mockImplementation((line) => {
					lines.push(String(line));
				});
				// The environment of the production outage: the old store's two
				// variables, the new store under a prefix, and nothing that says
				// which to use.
				const relay = composeRelay({
					env: {
						HOBO_CI_PUBLIC_URL: origin,
						HOBO_CI_SESSION_KEY: key.toString("base64url"),
						HOBO_CI_BOOTSTRAP_ACCOUNT_ID: "example",
						HOBO_CI_BOOTSTRAP_TOKEN_SHA256: "c".repeat(64),
						CRON_SECRET: "s".repeat(32),
						DATABASE_URL: refused,
						DATABASE_URL_UNPOOLED: refused,
						NEW_DATABASE_URL: freshUrl,
						NEW_DATABASE_URL_UNPOOLED: freshUrl,
					},
					notify: async () => {},
					continueRepair: async () => {},
					scheduledRepair: async () => {},
				});
				try {
					const ready = await relay.handle(new Request(`${origin}/readyz`));
					// Not `store-unavailable`: the bootstrap store answered, on the
					// new database, and holds no App yet.
					expect(ready.status).toBe(503);
					expect(await ready.json()).toEqual({
						ready: false,
						reason: "bootstrap-required",
					});
				} finally {
					info.mockRestore();
					await relay.close();
				}
				const selected = lines
					.map((line) => JSON.parse(line))
					.filter((record) => record.event === "hobo_ci_database_selected");
				expect(selected).toEqual([
					expect.objectContaining({
						prefix: "NEW_",
						reason: "previous-refusing",
						candidates: [
							expect.objectContaining({ class: "refusing", sqlstate: "28000" }),
							expect.objectContaining({ class: "serving" }),
						],
					}),
				]);
				expect(lines.join("\n")).not.toContain("127.0.0.1");
				// The relay's tables are on the new store and nowhere else.
				const tables = (pool: pg.Pool) =>
					pool.query(
						"SELECT to_regclass('hobo_ci_platform_app') IS NOT NULL AS present",
					);
				expect((await tables(fresh.pool)).rows).toEqual([{ present: true }]);
				expect((await tables(old.pool)).rows).toEqual([{ present: false }]);
				expect(await markerRows(fresh.pool)).toHaveLength(1);
			}),
		TIMEOUT_MS,
	);

	it(
		"selects again after the chosen store starts refusing, once the back-off has passed",
		() =>
			scratch(["old", "new"], async (databases) => {
				const { old, fresh, oldUrl, freshUrl } = both(databases);
				const { records, log } = recorder();
				const origin = "https://ci.hobo.test";
				let now = 5_000_000;
				// A stand-in application that does what the relay does with the
				// database it is handed: open a pool on it and query.
				const build = async (database: RelayDatabase) => {
					const pool = new pg.Pool({ ...database.primary, max: 1 });
					pool.on("error", () => {});
					return {
						async handle() {
							const result = await pool.query(
								"SELECT current_database() AS name",
							);
							return Response.json(result.rows[0]);
						},
						async tick() {},
						close: () => pool.end(),
					};
				};
				const relay = createSelectedRelay({
					env: { HOBO_CI_PUBLIC_URL: origin },
					stores: attached(oldUrl, freshUrl),
					build,
					select: (stores) => selectStore(stores, { log }),
					now: () => now,
				});
				const ask = async () =>
					(await relay.handle(new Request(`${origin}/v1/status`))).json();
				try {
					expect(await ask()).toEqual({ name: old.name });
					expect(await ask()).toEqual({ name: old.name });
					expect(records).toHaveLength(1);

					// The store goes away under the running relay.
					old.pool.on("error", () => {});
					await fresh.pool.query(`DROP DATABASE ${old.name} WITH (FORCE)`);
					// The first request may still find the killed connection; the
					// one that dials again gets the server's refusal.
					const failures: string[] = [];
					while (failures.length < 3 && !failures.includes("3D000"))
						failures.push(
							await ask().then(
								() => "answered",
								(error) =>
									error instanceof Error && "code" in error
										? String(error.code)
										: "uncoded",
							),
						);
					expect(failures).toContain("3D000");
					// It is left alone for the back-off, like any store that failed.
					await expect(ask()).rejects.toBeInstanceOf(StoreUnavailable);
					expect(
						(await relay.handle(new Request(`${origin}/readyz`))).status,
					).toBe(503);
					expect(records).toHaveLength(1);

					now += 5_000;
					expect(await ask()).toEqual({ name: fresh.name });
					expect(records.at(-1)).toMatchObject({
						event: "hobo_ci_database_selected",
						prefix: "NEW_",
						reason: "previous-refusing",
						candidates: [
							{ prefix: "", class: "refusing", sqlstate: "3D000" },
							{ prefix: "NEW_", class: "serving" },
						],
					});
					expect(await ask()).toEqual({ name: fresh.name });
					expect(records).toHaveLength(2);
				} finally {
					await relay.close();
				}
			}),
		TIMEOUT_MS,
	);
});
