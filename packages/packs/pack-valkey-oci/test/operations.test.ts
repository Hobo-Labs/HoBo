import assert from "node:assert/strict";
import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { PackError, type ProcessRunner } from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	buildValkeyRdbBackupArgv,
	buildValkeyReplicaHandoffPlan,
	buildValkeyRewriteAofArgv,
	parseValkeyEndpoint,
	parseValkeyFilePath,
	runValkeyCommand,
	VALKEY_CLI_AUTH_ENV,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import { AUTH_REF } from "./harness.js";

const SOURCE = {
	host: "valkey-a.yard-1.hobo.test",
	passwordRef: AUTH_REF,
} as const;
const TARGET = {
	host: "valkey-b.yard-2.hobo.test",
	passwordRef: AUTH_REF,
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

describe("parseValkeyEndpoint", () => {
	it("defaults the port and database rather than inventing a host", () => {
		const endpoint = parseValkeyEndpoint(SOURCE);
		assert.equal(endpoint.port, 6379);
		assert.equal(endpoint.database, 0);
		assert.equal(endpoint.tls, false);
	});

	it("rejects a connection URL in the host field", () => {
		// The realistic mistake: pasting a redis:// URL where a hostname goes,
		// which would smuggle a credential into an argv element.
		expectPackError(
			() =>
				parseValkeyEndpoint({
					...SOURCE,
					host: "redis://default:hunter2@cache:6379",
				}),
			"PACK_OPERATION_FAILED",
		);
	});

	it("rejects an out-of-range port or database index", () => {
		expectPackError(
			() => parseValkeyEndpoint({ ...SOURCE, port: 0 }),
			"PACK_OPERATION_FAILED",
		);
		expectPackError(
			() => parseValkeyEndpoint({ ...SOURCE, database: 999 }),
			"PACK_OPERATION_FAILED",
		);
	});
});

describe("parseValkeyFilePath", () => {
	it("requires an absolute path with no traversal", () => {
		assert.equal(
			parseValkeyFilePath("/var/backups/cache.rdb", "path"),
			"/var/backups/cache.rdb",
		);
		expectPackError(
			() => parseValkeyFilePath("cache.rdb", "path"),
			"PACK_OPERATION_FAILED",
		);
		expectPackError(
			() => parseValkeyFilePath("/var/backups/../../etc/passwd", "path"),
			"PACK_OPERATION_FAILED",
		);
	});
});

describe("buildValkeyRdbBackupArgv", () => {
	it("asks the server for a fresh RDB rather than copying the volume", () => {
		const command = buildValkeyRdbBackupArgv({
			endpoint: SOURCE,
			outputPath: "/var/backups/cache.rdb",
		});
		assert.equal(command.argv[0], "valkey-cli");
		assert.ok(command.argv.includes("--rdb"));
		assert.ok(command.argv.includes("/var/backups/cache.rdb"));
		assert.equal(command.operationId, "valkey.backup.rdb-dump");
	});

	it("carries the credential as a locator in the environment, never in argv", () => {
		const command = buildValkeyRdbBackupArgv({
			endpoint: SOURCE,
			outputPath: "/var/backups/cache.rdb",
		});
		assert.equal(command.secretEnv[VALKEY_CLI_AUTH_ENV], AUTH_REF);
		for (const element of command.argv) {
			assert.ok(!element.includes("hobo-secret://"));
			assert.ok(!element.includes("hunter2"));
		}
		// Nothing resolved has been placed in the non-secret environment either.
		assert.deepEqual(command.env, {});
	});

	it("adds --tls only when the endpoint says so", () => {
		const plain = buildValkeyRdbBackupArgv({
			endpoint: SOURCE,
			outputPath: "/var/backups/cache.rdb",
		});
		assert.ok(!plain.argv.includes("--tls"));
		const secured = buildValkeyRdbBackupArgv({
			endpoint: { ...SOURCE, tls: true },
			outputPath: "/var/backups/cache.rdb",
		});
		assert.ok(secured.argv.includes("--tls"));
	});
});

describe("buildValkeyRewriteAofArgv", () => {
	it("issues BGREWRITEAOF in an aof mode", () => {
		const command = buildValkeyRewriteAofArgv({
			endpoint: SOURCE,
			durabilityMode: "aof-everysec",
		});
		assert.ok(command.argv.includes("BGREWRITEAOF"));
	});

	it("refuses in a mode with no append-only file", () => {
		// The server accepts the command and does nothing useful, so a schedule
		// would believe it was compacting a file that does not exist.
		for (const durabilityMode of ["none", "rdb-snapshots"] as const) {
			expectPackError(
				() => buildValkeyRewriteAofArgv({ endpoint: SOURCE, durabilityMode }),
				"PACK_OPERATION_FAILED",
			);
		}
	});
});

describe("buildValkeyReplicaHandoffPlan", () => {
	it("emits three separate commands, all aimed at the target", () => {
		const plan = buildValkeyReplicaHandoffPlan({
			source: SOURCE,
			target: TARGET,
		});
		assert.equal(plan.profileRef, "migration.valkey.replica-handoff/v1");
		// Every step talks to the server that is taking ownership.
		for (const command of [plan.replicate, plan.awaitSync, plan.promote]) {
			assert.ok(command.argv.includes(TARGET.host));
		}
		assert.deepEqual(plan.replicate.argv.slice(-3), [
			"REPLICAOF",
			SOURCE.host,
			"6379",
		]);
		assert.deepEqual(plan.awaitSync.argv.slice(-2), ["INFO", "replication"]);
		assert.deepEqual(plan.promote.argv.slice(-3), ["REPLICAOF", "NO", "ONE"]);
	});

	it("waits by asking a question rather than by sleeping", () => {
		const plan = buildValkeyReplicaHandoffPlan({
			source: SOURCE,
			target: TARGET,
		});
		assert.ok(
			!plan.awaitSync.argv.some((element) =>
				element.toLowerCase().includes("sleep"),
			),
		);
	});

	it("refuses a handoff from a server to itself", () => {
		expectPackError(
			() =>
				buildValkeyReplicaHandoffPlan({
					source: SOURCE,
					target: { ...SOURCE },
				}),
			"PACK_OPERATION_FAILED",
		);
	});
});

describe("runValkeyCommand", () => {
	it("resolves the locator into the child environment at spawn time", async () => {
		const command = buildValkeyRdbBackupArgv({
			endpoint: SOURCE,
			outputPath: "/var/backups/cache.rdb",
		});
		let observedEnv: Readonly<Record<string, string>> = {};
		const runner: ProcessRunner = {
			run(argv, options) {
				observedEnv = options.env;
				assert.equal(argv[0], "valkey-cli");
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			},
		};
		const resolver = {
			resolve: () =>
				Promise.resolve(
					new SecretValue(
						parseSecretRef(AUTH_REF),
						"correct-horse-battery-staple-32ch",
					),
				),
		};

		const result = await runValkeyCommand(runner, resolver, command);
		assert.equal(result.code, 0);
		// The value exists in the child environment and nowhere else.
		assert.equal(
			observedEnv[VALKEY_CLI_AUTH_ENV],
			"correct-horse-battery-staple-32ch",
		);
		assert.equal(command.secretEnv[VALKEY_CLI_AUTH_ENV], AUTH_REF);
	});

	it("surfaces an unavailable custody as a typed pack error", async () => {
		const command = buildValkeyRdbBackupArgv({
			endpoint: SOURCE,
			outputPath: "/var/backups/cache.rdb",
		});
		const runner: ProcessRunner = {
			run: () => Promise.reject(new Error("should not be reached")),
		};
		const resolver = {
			resolve: () => Promise.reject(new Error("vault sealed")),
		};
		await assert.rejects(
			() => runValkeyCommand(runner, resolver, command),
			(error: JsonValue) =>
				error instanceof PackError &&
				error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});
});
