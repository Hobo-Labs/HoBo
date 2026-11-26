import type { SecretRef } from "@hobo/bindings";
import { describe, expect, it } from "vitest";

import type { NeonProviderError } from "../src/errors.js";
import {
	buildLogicalCopyPlan,
	buildPgDumpArgv,
	buildPgRestoreArgv,
	createPostgresMigrationDriver,
	libpqEnv,
	type PostgresTarget,
} from "../src/migration.js";
import { createStubCustody, createStubRunner } from "./harness.js";

const HOSTILE_DATABASE = 'neondb"; rm -rf / #$(id)`whoami`';

const TARGET: PostgresTarget = {
	host: "ep-fake-000000.c-2.us-east-2.aws.neon.tech",
	port: 5432,
	database: "neondb",
	username: "neondb_owner",
	sslMode: "require",
};

describe("argv construction", () => {
	it("keeps a shell-metacharacter database name as one inert argv element", () => {
		const argv = buildPgDumpArgv({
			target: { ...TARGET, database: HOSTILE_DATABASE },
			filePath: "/tmp/dump.bin",
			format: "custom",
		});

		const dbnameElements = argv.filter((element) =>
			element.startsWith("--dbname="),
		);
		expect(dbnameElements).toEqual([`--dbname=${HOSTILE_DATABASE}`]);
		// Nothing was split on `;`, `$(`, or a backtick, and no element other
		// than that one mentions the payload.
		expect(argv.filter((element) => element.includes("rm -rf"))).toHaveLength(
			1,
		);
		expect(argv).not.toContain("rm");
		expect(argv.join("\u0000").split("\u0000")).toEqual([...argv]);
	});

	it("uses fused --flag=value form so a value can never be read as a flag", () => {
		const argv = buildPgDumpArgv({
			target: { ...TARGET, database: "--help" },
			filePath: "/tmp/dump.bin",
			format: "custom",
		});
		expect(argv).toContain("--dbname=--help");
		expect(argv).not.toContain("--help");
	});

	it("refuses a value containing a NUL or newline", () => {
		expect(() =>
			buildPgDumpArgv({
				target: { ...TARGET, database: "neondb\u0000evil" },
				filePath: "/tmp/dump.bin",
				format: "custom",
			}),
		).toThrowError(/control character/u);
		expect(() =>
			buildPgRestoreArgv({
				target: { ...TARGET, username: "owner\nDROP" },
				filePath: "/tmp/dump.bin",
			}),
		).toThrowError(/control character/u);
	});

	it("refuses to place a connection URI in argv", () => {
		expect(() =>
			buildPgDumpArgv({
				target: {
					...TARGET,
					database:
						"postgresql://neondb_owner:REDACTED@ep-fake-000000.us-east-2.aws.neon.tech/db",
				},
				filePath: "/tmp/dump.bin",
				format: "custom",
			}),
		).toThrowError(/credential-shaped material in argv/u);
	});

	it("never puts the password in argv and always puts it in the environment", () => {
		const argv = buildPgDumpArgv({
			target: TARGET,
			filePath: "/tmp/dump.bin",
			format: "custom",
		});
		expect(argv).toContain("--no-password");
		expect(argv.join(" ")).not.toContain("hunter2");
		expect(libpqEnv(TARGET, "hunter2").PGPASSWORD).toBe("hunter2");
	});
});

describe("pg_dump / pg_restore through the injected runner", () => {
	it("runs pg_dump with the credential only in the environment", async () => {
		const custody = createStubCustody();
		// SAFETY: value was established by the surrounding parse or typed constructor.
		const ref = (await custody.deposit(
			"postgresql://neondb_owner:REDACTED@ep-fake-000000.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require",
			{
				providerId: "neon",
				resourceRef: "hobo://yard/demo/data/main",
				purpose: "connection-string-direct",
			},
		)) as SecretRef;
		const runner = createStubRunner();
		const driver = createPostgresMigrationDriver({ runner, resolver: custody });

		const outcome = await driver.dump({
			credentialRef: ref,
			filePath: "/tmp/dump.bin",
		});

		expect(outcome.ok).toBe(true);
		const run = runner.runs[0];
		expect(run?.argv[0]).toBe("pg_dump");
		expect(run?.argv.join(" ")).not.toContain("REDACTED");
		expect(run?.options.env.PGPASSWORD).toBe("REDACTED");
		expect(run?.options.env.PGSSLMODE).toBe("require");
	});

	it("maps a non-zero exit to MIGRATION_FAILED with redacted stderr", async () => {
		const custody = createStubCustody();
		// SAFETY: value was established by the surrounding parse or typed constructor.
		const ref = (await custody.deposit(
			"postgresql://neondb_owner:REDACTED@ep-fake-000000.c-2.us-east-2.aws.neon.tech/neondb",
			{
				providerId: "neon",
				resourceRef: "hobo://yard/demo/data/main",
				purpose: "connection-string-direct",
			},
		)) as SecretRef;
		const runner = createStubRunner({
			code: 1,
			stdout: "",
			stderr:
				"pg_restore: error: connection to postgresql://neondb_owner:REDACTED@ep-fake-000000.c-2.us-east-2.aws.neon.tech/neondb failed",
		});
		const driver = createPostgresMigrationDriver({ runner, resolver: custody });

		try {
			await driver.restore({ credentialRef: ref, filePath: "/tmp/dump.bin" });
			expect.unreachable("a failing restore must throw");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			const providerError = error as NeonProviderError;
			expect(providerError.code).toBe("MIGRATION_FAILED");
			expect(providerError.message).not.toContain("postgresql://");
			expect(providerError.message).toContain("[redacted]");
		}
	});

	it("sends logical-copy SQL on stdin, not on the command line", async () => {
		const custody = createStubCustody();
		// SAFETY: value was established by the surrounding parse or typed constructor.
		const ref = (await custody.deposit(
			"postgresql://neondb_owner:REDACTED@ep-fake-000000.c-2.us-east-2.aws.neon.tech/neondb",
			{
				providerId: "neon",
				resourceRef: "hobo://yard/demo/data/main",
				purpose: "connection-string-direct",
			},
		)) as SecretRef;
		const runner = createStubRunner();
		const driver = createPostgresMigrationDriver({ runner, resolver: custody });
		const plan = buildLogicalCopyPlan({
			publicationName: "hobo_move",
			subscriptionName: "hobo_move_sub",
			logicalReplicationEnabled: true,
		});

		await driver.applySourceStatements({
			credentialRef: ref,
			statements: plan.sourceStatements,
		});

		const run = runner.runs[0];
		expect(run?.argv).toContain("--file=-");
		expect(run?.options.stdin).toContain(
			"CREATE PUBLICATION hobo_move FOR ALL TABLES;",
		);
		expect(run?.argv.join(" ")).not.toContain("CREATE PUBLICATION");
	});
});

describe("logical copy plan", () => {
	it("fails closed when the database was not created with logical replication", () => {
		expect(() =>
			buildLogicalCopyPlan({
				publicationName: "hobo_move",
				subscriptionName: "hobo_move_sub",
				logicalReplicationEnabled: false,
			}),
		).toThrowError(/enable_logical_replication/u);
	});

	it("rejects identifiers that are not plain SQL identifiers", () => {
		expect(() =>
			buildLogicalCopyPlan({
				publicationName: "hobo_move; DROP TABLE users",
				subscriptionName: "hobo_move_sub",
				logicalReplicationEnabled: true,
			}),
		).toThrowError(/plain lowercase SQL identifiers/u);
	});

	it("leaves the DSN-bearing subscription statement to the caller", () => {
		const plan = buildLogicalCopyPlan({
			publicationName: "hobo_move",
			subscriptionName: "hobo_move_sub",
			tables: ["orders", "customers"],
			logicalReplicationEnabled: true,
		});
		expect(plan.sourceStatements).toEqual([
			"CREATE PUBLICATION hobo_move FOR TABLE orders, customers;",
		]);
		expect(plan.destinationStatementsRequireDsn).toBe(true);
		expect(JSON.stringify(plan)).not.toContain("CONNECTION");
	});
});
