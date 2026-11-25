import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { JobFactSchema } from "@hobo/ci";
import {
	feedProviderHealth,
	SqliteProviderHealthStore,
} from "@hobo/ci/runner-order/provider-health-sqlite";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { providerHealthDbPath } from "../src/ci-provider-health.js";

const MINUTE = 60_000;
const T0 = 1_763_337_600_000;
const NOW = T0 + 13 * MINUTE;

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function setup() {
	const home = await mkdtemp(join(tmpdir(), "hobo-ci-provider-health-"));
	directories.push(home);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: home },
				now: () => NOW,
				git: async () => home,
			}),
		},
	});
	const path = join(home, "ci", "serve", "provider-health.sqlite");
	return { cli, home, path };
}

async function tripDepot(path: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	const store = new SqliteProviderHealthStore(path);
	for (const [id, at] of [
		[1, T0],
		[2, T0 + MINUTE],
		[3, T0 + 2 * MINUTE],
	] as const)
		await feedProviderHealth(
			store,
			create(JobFactSchema, {
				id,
				name: "test",
				labels: ["depot-ubuntu-24.04"],
				queuedAtMs: at,
			}),
			at + 11 * MINUTE,
		);
	store.close();
}

describe("hobo ci provider-health (R09)", () => {
	it("says nothing is recorded without creating the file", async () => {
		const { cli, home, path } = await setup();
		const result = await cli.run(["ci", "provider-health"], { cwd: home });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No provider health recorded yet");
		expect(existsSync(path)).toBe(false);
	});

	it("lists a tripped runner type with its next trial", async () => {
		const { cli, home, path } = await setup();
		await tripDepot(path);
		const result = await cli.run(["ci", "provider-health", "--json"], {
			cwd: home,
		});
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data.providers).toEqual([
			{
				key: "depot:depot-ubuntu-24.04",
				state: "unhealthy",
				misses: 3,
				trippedAt: new Date(T0 + 12 * MINUTE).toISOString(),
				nextTrialAt: new Date(T0 + 22 * MINUTE).toISOString(),
				backoffMinutes: 10,
			},
		]);
	});

	it("clears a runner type by hand so the next job may use it", async () => {
		const { cli, home, path } = await setup();
		await tripDepot(path);
		const cleared = await cli.run(
			["ci", "provider-health", "clear", "depot", "depot-ubuntu-24.04"],
			{ cwd: home },
		);
		expect(cleared.exitCode).toBe(0);
		expect(cleared.stdout).toContain("Cleared depot:depot-ubuntu-24.04");
		const store = new SqliteProviderHealthStore(path);
		expect((await store.unhealthy(NOW)).size).toBe(0);
		store.close();
		const again = await cli.run(
			["ci", "provider-health", "clear", "depot", "depot-ubuntu-24.04"],
			{ cwd: home },
		);
		expect(again.stdout).toContain("has no record to clear");
	});

	it("clears all tripped runner types for a provider when label is omitted", async () => {
		const { cli, home, path } = await setup();
		await tripDepot(path);
		const cleared = await cli.run(["ci", "provider-health", "clear", "depot"], {
			cwd: home,
		});
		expect(cleared.exitCode).toBe(0);
		expect(cleared.stdout).toContain("Cleared depot:depot-ubuntu-24.04");
		const store = new SqliteProviderHealthStore(path);
		expect((await store.unhealthy(NOW)).size).toBe(0);
		store.close();
	});

	it("refuses an unknown provider and a malformed call", async () => {
		const { cli, home } = await setup();
		const unknown = await cli.run(
			["ci", "provider-health", "clear", "acme", "acme-4"],
			{ cwd: home },
		);
		expect(unknown.exitCode).not.toBe(0);
		expect(unknown.stdout + unknown.stderr).toContain("not a hosted provider");
		const malformed = await cli.run(["ci", "provider-health", "clear"], {
			cwd: home,
		});
		expect(malformed.exitCode).not.toBe(0);
		expect(malformed.stdout + malformed.stderr).toContain("Usage:");
	});

	it("reads the file from the flag, then the environment, then HOBO_HOME", () => {
		expect(providerHealthDbPath(["--db", "/x.sqlite"], {})).toBe("/x.sqlite");
		expect(
			providerHealthDbPath([], { HOBO_CI_PROVIDER_HEALTH_DB: "/y.sqlite" }),
		).toBe("/y.sqlite");
		expect(providerHealthDbPath([], { HOBO_HOME: "/h" })).toBe(
			"/h/ci/serve/provider-health.sqlite",
		);
	});
});
