import assert from "node:assert/strict";
import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { PackError, type ProcessRunner } from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	buildPgDumpArgv,
	buildPgDumpMigrationPlan,
	buildPgRestoreArgv,
	buildVacuumAnalyzeArgv,
	parsePostgresEndpoint,
	parsePostgresIdentifier,
	runPostgresCommand,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import { SUPERUSER_REF } from "./harness.js";

const PASSWORD_REF = parseSecretRef(SUPERUSER_REF).ref;

const ENDPOINT = {
	host: "pg-main.camp-demo.hobo.localhost",
	port: 5432,
	database: "app",
	role: "app_owner",
	sslMode: "require",
	passwordRef: PASSWORD_REF,
} as const;

function expectPackError(fn: () => void, code: string): void {
	try {
		fn();
	} catch (error) {
		assert.ok(
			error instanceof PackError,
			`expected PackError, got ${String(error)}`,
		);
		assert.equal(error.code, code);
		return;
	}
	throw new Error(`expected ${code} but nothing was thrown`);
}

describe("identifier and endpoint parsing", () => {
	it("accepts an unquoted lowercase identifier", () => {
		assert.equal(parsePostgresIdentifier("app_owner", "role"), "app_owner");
	});

	for (const bad of [
		'x"; DROP TABLE users; --',
		"App",
		"1app",
		"pg_catalog",
		"",
		"a".repeat(64),
		"app-owner",
	]) {
		it(`rejects ${JSON.stringify(bad)} at the parse boundary`, () => {
			expectPackError(
				() => parsePostgresIdentifier(bad, "role"),
				"PACK_OPERATION_FAILED",
			);
		});
	}

	it("rejects a host that is really a connection string", () => {
		expectPackError(
			() =>
				parsePostgresEndpoint({
					...ENDPOINT,
					host: "app:hunter2@pg-main.internal",
				}),
			"PACK_OPERATION_FAILED",
		);
	});

	it("rejects an out-of-range port", () => {
		expectPackError(
			() => parsePostgresEndpoint({ ...ENDPOINT, port: 0 }),
			"PACK_OPERATION_FAILED",
		);
	});
});

describe("buildPgDumpArgv", () => {
	it("emits an argv array with the credential carried as a locator", () => {
		const command = buildPgDumpArgv({
			endpoint: ENDPOINT,
			outputPath: "/var/backups/app-2026-08-08.dump",
		});
		assert.deepEqual(command.argv, [
			"pg_dump",
			"--host",
			"pg-main.camp-demo.hobo.localhost",
			"--port",
			"5432",
			"--username",
			"app_owner",
			"--dbname",
			"app",
			"--no-password",
			"--format=custom",
			"--file",
			"/var/backups/app-2026-08-08.dump",
		]);
		assert.equal(command.secretEnv.PGPASSWORD, PASSWORD_REF);
		assert.equal(command.env.PGSSLMODE, "require");
		// Nothing in the command object is a secret, which is why it is safe to
		// serialize into an event or a plan.
		assert.ok(!JSON.stringify(command).includes("hunter2"));
	});

	it("never puts the password anywhere in argv", () => {
		const command = buildPgDumpArgv({
			endpoint: ENDPOINT,
			outputPath: "/var/backups/app.dump",
		});
		for (const element of command.argv) {
			assert.ok(!element.toLowerCase().includes("password="));
			assert.ok(!element.includes(PASSWORD_REF));
		}
	});

	it("passes --no-password so a missing credential fails instead of hanging on a prompt", () => {
		const command = buildPgDumpArgv({
			endpoint: ENDPOINT,
			outputPath: "/var/backups/a.dump",
		});
		assert.ok(command.argv.includes("--no-password"));
	});

	it("rejects a relative or traversing output path", () => {
		expectPackError(
			() =>
				buildPgDumpArgv({ endpoint: ENDPOINT, outputPath: "backups/app.dump" }),
			"PACK_OPERATION_FAILED",
		);
		expectPackError(
			() =>
				buildPgDumpArgv({
					endpoint: ENDPOINT,
					outputPath: "/var/backups/../../etc/passwd",
				}),
			"PACK_OPERATION_FAILED",
		);
	});
});

describe("buildPgRestoreArgv", () => {
	it("stops at the first error and drops source ownership by default", () => {
		const command = buildPgRestoreArgv({
			endpoint: ENDPOINT,
			inputPath: "/var/backups/app.dump",
		});
		assert.ok(command.argv.includes("--exit-on-error"));
		assert.ok(command.argv.includes("--single-transaction"));
		assert.ok(command.argv.includes("--no-owner"));
		assert.ok(command.argv.includes("--no-privileges"));
		// Destructive flags are opt-in.
		assert.ok(!command.argv.includes("--clean"));
	});

	it("adds --clean --if-exists only when asked", () => {
		const command = buildPgRestoreArgv({
			endpoint: ENDPOINT,
			inputPath: "/var/backups/app.dump",
			clean: true,
		});
		assert.ok(command.argv.includes("--clean"));
		assert.ok(command.argv.includes("--if-exists"));
	});
});

describe("buildPgDumpMigrationPlan", () => {
	it("returns two commands rather than a shell pipeline", () => {
		const plan = buildPgDumpMigrationPlan({
			source: ENDPOINT,
			target: { ...ENDPOINT, host: "pg-new.camp-demo.hobo.localhost" },
			artifactPath: "/var/spool/migrate/app.dump",
		});
		assert.equal(plan.profileRef, "migration.postgres.pg-dump/v1");
		assert.equal(plan.dump.argv[0], "pg_dump");
		assert.equal(plan.restore.argv[0], "pg_restore");
		// Both steps reference the same artifact, and neither contains a pipe.
		assert.ok(plan.dump.argv.includes(plan.artifactPath));
		assert.ok(plan.restore.argv.includes(plan.artifactPath));
		for (const element of [...plan.dump.argv, ...plan.restore.argv]) {
			assert.ok(!element.includes("|"));
		}
	});

	it("refuses a migration that would move nothing", () => {
		expectPackError(
			() =>
				buildPgDumpMigrationPlan({
					source: ENDPOINT,
					target: ENDPOINT,
					artifactPath: "/var/spool/migrate/app.dump",
				}),
			"PACK_OPERATION_FAILED",
		);
	});

	it("allows the same server when the database differs", () => {
		const plan = buildPgDumpMigrationPlan({
			source: ENDPOINT,
			target: { ...ENDPOINT, database: "app_next" },
			artifactPath: "/var/spool/migrate/app.dump",
		});
		assert.ok(plan.restore.argv.includes("app_next"));
	});
});

describe("runPostgresCommand", () => {
	it("resolves the locator into the child environment at spawn time", async () => {
		const seen: {
			argv: readonly string[];
			env: Readonly<Record<string, string>>;
		}[] = [];
		const runner: ProcessRunner = {
			run(argv, options) {
				seen.push({ argv, env: options.env });
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			},
		};
		const command = buildVacuumAnalyzeArgv({ endpoint: ENDPOINT });
		const result = await runPostgresCommand(
			runner,
			{
				resolve: (ref) =>
					Promise.resolve(
						new SecretValue(parseSecretRef(ref), "resolved-password"),
					),
			},
			command,
		);
		assert.equal(result.code, 0);
		assert.equal(seen[0]?.env.PGPASSWORD, "resolved-password");
		// The value reached the environment and nothing else.
		assert.ok(
			!(seen[0]?.argv ?? []).some((element) =>
				element.includes("resolved-password"),
			),
		);
		assert.equal(command.env.PGPASSWORD, undefined);
	});

	it("reports an unavailable custody rather than running without a credential", async () => {
		let spawned = false;
		const runner: ProcessRunner = {
			run() {
				spawned = true;
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			},
		};
		await assert.rejects(
			runPostgresCommand(
				runner,
				{ resolve: () => Promise.reject(new Error("vault sealed")) },
				buildVacuumAnalyzeArgv({ endpoint: ENDPOINT }),
			),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "SECRET_CUSTODY_UNAVAILABLE");
				return true;
			},
		);
		assert.equal(spawned, false);
	});
});
