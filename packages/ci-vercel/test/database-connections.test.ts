import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
	databaseConnection,
	resolveDatabaseUrls,
	validateDirectDatabaseUrl,
	verifyRepairDatabase,
	withRepairPool,
} from "../src/database-connections.js";

describe("repair PostgreSQL connections", () => {
	it.each([
		"BEGIN",
		"ROLLBACK",
		"DELETE",
	])("discards the primary session after an uncertain %s failure", async (phase) => {
		const client = {
			query: vi.fn(async (sql: string) => {
				if (
					sql === phase ||
					(phase === "DELETE" &&
						sql.startsWith("DELETE FROM hobo_ci_database_probes WHERE id"))
				)
					throw new Error("connection lost");
				if (phase === "ROLLBACK" && sql.includes("pg_advisory_xact_lock"))
					throw new Error("query failed");
				return {
					rows: sql.startsWith("SELECT current_database")
						? [{ database: "ci", username: "owner" }]
						: [],
					rowCount: 1,
				};
			}),
			release: vi.fn(),
		};
		const direct = {
			query: vi.fn(async () => ({
				rows: [{ database: "ci", username: "owner" }],
				rowCount: 1,
			})),
		};
		await expect(
			verifyRepairDatabase({ connect: async () => client }, direct),
		).rejects.toThrow();
		expect(client.release).toHaveBeenCalledWith(true);
	});
	it("closes the temporary direct pool after success and failure", async () => {
		const success = { end: vi.fn(async () => {}) };
		await expect(withRepairPool(success, async () => "ok")).resolves.toBe("ok");
		expect(success.end).toHaveBeenCalledOnce();
		const failure = { end: vi.fn(async () => {}) };
		await expect(
			withRepairPool(failure, async () => {
				throw new Error("repair failed");
			}),
		).rejects.toThrow("repair failed");
		expect(failure.end).toHaveBeenCalledOnce();
	});

	it("requires an explicit direct endpoint and rejects Neon's pooler", () => {
		expect(() => validateDirectDatabaseUrl(undefined)).toThrow(
			"DATABASE_URL_UNPOOLED",
		);
		expect(() =>
			validateDirectDatabaseUrl(
				"postgresql://db:password@ep-name-pooler.us-east-1.aws.neon.tech/db",
			),
		).toThrow("direct PostgreSQL URL");
		for (const host of [
			"ep-name%2Dpooler.us-east-1.aws.neon.tech",
			"ep-name-pooler.us-east-1.aws.neon.tech.",
		])
			expect(() =>
				validateDirectDatabaseUrl(`postgresql://db:password@${host}/db`),
			).toThrow("direct PostgreSQL URL");
		expect(() =>
			validateDirectDatabaseUrl(
				"postgresql://db:password@db.example/db?host=other",
			),
		).toThrow("direct PostgreSQL URL");
		expect(
			validateDirectDatabaseUrl(
				"postgresql://db:password@ep-name.us-east-1.aws.neon.tech/db",
			),
		).toContain("ep-name.us-east-1.aws.neon.tech");
	});

	it("refuses the transaction poolers of the Marketplace providers and keeps their session endpoints", () => {
		for (const pooled of [
			"postgres://u:p@pooled.db.prisma.io:5432/postgres?sslmode=require",
			"postgres://u.ref:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
		])
			expect(() => validateDirectDatabaseUrl(pooled)).toThrow(
				"direct PostgreSQL URL",
			);
		for (const session of [
			"postgres://u:p@db.prisma.io:5432/postgres?sslmode=require",
			"postgres://u.ref:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
			"postgres://u:p@db.ref.supabase.co:5432/postgres",
		])
			expect(validateDirectDatabaseUrl(session)).toBe(session);
		expect(() =>
			validateDirectDatabaseUrl(undefined, "POSTGRES_URL_NON_POOLING"),
		).toThrow("POSTGRES_URL_NON_POOLING is required for repair");
	});

	it("finds the database in the variables each storage integration injects", () => {
		expect(
			resolveDatabaseUrls({
				DATABASE_URL: "postgres://pooled",
				DATABASE_URL_UNPOOLED: "postgres://direct",
				POSTGRES_URL: "postgres://legacy",
				POSTGRES_URL_NON_POOLING: "postgres://legacy-direct",
			}),
		).toEqual({
			binding: "explicit",
			primary: "postgres://pooled",
			primaryName: "DATABASE_URL",
			direct: "postgres://direct",
			directName: "DATABASE_URL_UNPOOLED",
		});
		// Prisma Postgres: DATABASE_URL is the direct string.
		expect(
			resolveDatabaseUrls({
				DATABASE_URL: "postgres://direct",
				DATABASE_URL_POOLED: "postgres://pooled",
			}),
		).toMatchObject({
			binding: "prisma-postgres",
			primary: "postgres://pooled",
			direct: "postgres://direct",
			directName: "DATABASE_URL",
		});
		expect(
			resolveDatabaseUrls({
				POSTGRES_URL: "postgres://pooled",
				POSTGRES_URL_NON_POOLING: "postgres://session",
			}),
		).toMatchObject({
			binding: "supabase",
			primary: "postgres://pooled",
			direct: "postgres://session",
			directName: "POSTGRES_URL_NON_POOLING",
		});
		// Bootstrap needs only the primary connection.
		expect(resolveDatabaseUrls({ DATABASE_URL: "postgres://only" })).toEqual({
			binding: "explicit",
			primary: "postgres://only",
			primaryName: "DATABASE_URL",
			direct: undefined,
			directName: "DATABASE_URL_UNPOOLED",
		});
		expect(() => resolveDatabaseUrls({})).toThrow(
			"missing configuration: DATABASE_URL",
		);
	});

	it("selects a store connected under a prefix while another is still attached", () => {
		const env = {
			DATABASE_URL: "postgres://old-pooled",
			DATABASE_URL_UNPOOLED: "postgres://old-direct",
			RELAY_POSTGRES_URL: "postgres://new-pooled",
			RELAY_POSTGRES_URL_NON_POOLING: "postgres://new-session",
			HOBO_CI_DATABASE_ENV_PREFIX: "RELAY_",
		};
		expect(resolveDatabaseUrls(env)).toEqual({
			binding: "supabase",
			primary: "postgres://new-pooled",
			primaryName: "RELAY_POSTGRES_URL",
			direct: "postgres://new-session",
			directName: "RELAY_POSTGRES_URL_NON_POOLING",
		});
		expect(() =>
			resolveDatabaseUrls({ HOBO_CI_DATABASE_ENV_PREFIX: "bad-prefix" }),
		).toThrow("invalid HOBO_CI_DATABASE_ENV_PREFIX");
		expect(() =>
			resolveDatabaseUrls({ ...env, HOBO_CI_DATABASE_ENV_PREFIX: "MISSING_" }),
		).toThrow("missing configuration: MISSING_DATABASE_URL");
	});

	it("verifies against a configured certificate authority and never disables verification", () => {
		const url = "postgres://u:p%40ss@db.example:6543/app?sslmode=require&x=1";
		const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
		const settings = databaseConnection(url, ca);
		// sslmode in the string would replace the ssl object, so it is removed.
		expect(settings).toEqual({
			connectionString: "postgres://u:p%40ss@db.example:6543/app?x=1",
			ssl: { ca },
		});
		expect(JSON.stringify(settings)).not.toContain("rejectUnauthorized");
		expect(() => databaseConnection(url, "not a certificate")).toThrow(
			"not a PEM certificate",
		);
		expect(() => databaseConnection("not a url", ca)).toThrow(
			"invalid database URL",
		);
	});

	describe("without a configured certificate authority", () => {
		const base = "postgres://u:p%40ss@db.example:6543/app";
		/** What `pg` itself makes of the settings: its own parse, its own client. */
		const effective = (url: string) => {
			const settings = databaseConnection(url, undefined);
			const client = new pg.Client(settings);
			return {
				connectionString: settings.connectionString,
				ssl: client.connectionParameters.ssl,
				host: client.connectionParameters.host,
				password: client.connectionParameters.password,
			};
		};
		/** TLS against the system trust store with the hostname checked: no
		 * `rejectUnauthorized: false`, no replaced identity check, no pinned CA. */
		const verifyFull = {};

		for (const mode of ["prefer", "require", "verify-ca"])
			it(`gives sslmode=${mode} verify-full semantics instead of passing it to pg`, () => {
				expect(effective(`${base}?sslmode=${mode}&x=1`)).toEqual({
					connectionString: `${base}?sslmode=verify-full&x=1`,
					ssl: verifyFull,
					host: "db.example",
					password: "p@ss",
				});
				// libpq compatibility is how pg gives these modes their weaker
				// meaning today: `require` and `prefer` accept any certificate, and
				// `verify-ca` skips the hostname (and refuses to start without a CA).
				for (const query of [
					`sslmode=${mode}&uselibpqcompat=true`,
					`uselibpqcompat=true&sslmode=${mode}`,
				])
					expect(effective(`${base}?${query}`)).toMatchObject({
						connectionString: `${base}?sslmode=verify-full`,
						ssl: verifyFull,
					});
			});

		it("shows what the unchanged string would have meant to pg", () => {
			// The control for the cases above: the same strings, handed to pg as
			// they are, switch verification off.
			for (const query of [
				"sslmode=require&uselibpqcompat=true",
				"sslmode=prefer&uselibpqcompat=true",
				"sslmode=no-verify",
				"ssl=no-verify",
			])
				expect(
					new pg.Client({ connectionString: `${base}?${query}` })
						.connectionParameters.ssl,
					query,
				).toEqual({ rejectUnauthorized: false });
		});

		it("never lets a string switch verification off", () => {
			for (const query of [
				"sslmode=no-verify",
				"ssl=no-verify",
				"ssl=no-verify&sslmode=disable",
				"sslmode=allow",
				"sslmode=REQUIRE",
				// pg takes the last of a repeated parameter.
				"sslmode=verify-full&sslmode=require&uselibpqcompat=true",
				"sslmode=require&sslmode=verify-full&uselibpqcompat=true",
				"sslmode=disable&sslmode=prefer&uselibpqcompat=true",
				"ssl=true&ssl=no-verify",
			]) {
				const { connectionString, ssl } = effective(`${base}?${query}`);
				expect(ssl, query).toEqual(verifyFull);
				expect(connectionString, query).toBe(`${base}?sslmode=verify-full`);
			}
			// `ssl=true` is already TLS with full verification in pg; only the
			// compatibility switch goes.
			expect(effective(`${base}?ssl=true&uselibpqcompat=true`)).toMatchObject({
				connectionString: `${base}?ssl=true`,
				ssl: true,
			});
		});

		it("leaves a string that is already strict, or asks for no TLS, exactly as it was", () => {
			for (const query of [
				"",
				"?x=1",
				"?sslmode=verify-full",
				"?sslmode=verify-full&application_name=hobo%20ci",
				"?sslmode=disable",
				"?ssl=true",
			]) {
				const url = `${base}${query}`;
				expect(databaseConnection(url, undefined), query).toEqual({
					connectionString: url,
				});
			}
			expect(effective(`${base}?sslmode=verify-full`).ssl).toEqual(verifyFull);
			expect(effective(`${base}?sslmode=disable`).ssl).toBe(false);
			expect(effective(base).ssl).toBe(false);
		});

		it("refuses a string it cannot inspect", () => {
			for (const value of [
				"not a url",
				"",
				"//db.example/app?sslmode=no-verify",
			])
				expect(() => databaseConnection(value, undefined), value).toThrow(
					"invalid database URL",
				);
		});
	});

	it("commits a unique marker and removes it after confirming the same database and role", async () => {
		const calls: string[] = [];
		let marker: unknown;
		const client = {
			query: vi.fn(async (sql: string, values?: unknown[]) => {
				calls.push(sql);
				if (sql.startsWith("INSERT INTO hobo_ci_database_probes"))
					marker = values?.[0];
				return {
					rows: sql.startsWith("SELECT current_database")
						? [{ database: "ci", username: "owner" }]
						: [],
					rowCount: 1,
				};
			}),
			release: vi.fn(),
		};
		const direct = {
			query: vi.fn(async (_sql: string, values?: unknown[]) => ({
				rows:
					values?.[0] === marker ? [{ database: "ci", username: "owner" }] : [],
				rowCount: values?.[0] === marker ? 1 : 0,
			})),
		};
		await verifyRepairDatabase({ connect: async () => client }, direct);
		expect(calls.indexOf("COMMIT")).toBeLessThan(
			calls.findIndex((sql) =>
				sql.startsWith("DELETE FROM hobo_ci_database_probes WHERE id"),
			),
		);
		expect(direct.query).toHaveBeenCalledWith(expect.any(String), [marker]);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it.each([
		"different database",
		"different role",
		"direct query error",
	])("fails closed and cleans the marker on %s", async (scenario) => {
		const client = {
			query: vi.fn(async (sql: string) => ({
				rows: sql.startsWith("SELECT current_database")
					? [{ database: "ci", username: "owner" }]
					: [],
				rowCount: 1,
			})),
			release: vi.fn(),
		};
		const direct = {
			query: vi.fn(async () => {
				if (scenario === "direct query error") throw new Error("unavailable");
				return {
					rows:
						scenario === "different database"
							? []
							: [{ database: "ci", username: "other" }],
					rowCount: scenario === "different database" ? 0 : 1,
				};
			}),
		};
		await expect(
			verifyRepairDatabase({ connect: async () => client }, direct),
		).rejects.toThrow();
		expect(client.query).toHaveBeenCalledWith(
			"DELETE FROM hobo_ci_database_probes WHERE id = $1",
			[expect.any(String)],
		);
		expect(client.release).toHaveBeenCalledOnce();
	});
});
