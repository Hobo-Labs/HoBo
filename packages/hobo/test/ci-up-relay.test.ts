import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandModule, CommandRunInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { runCiRelayDeploy } from "../src/ci-relay-deploy.js";
import {
	createCiRelayPlanCommand,
	createCiRelayUpCommand,
	relayProjectDirFor,
} from "../src/ci-up-relay.js";
import { createComposedHoboCli, createDefaultYardRuntime } from "../src/index.js";

const packages = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CI_PROJECT = path.join(packages, "hobo-ci");
const RELAY = path.join(packages, "ci-vercel");

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

const never: CommandModule = {
	implemented: true,
	run: async () => {
		throw new Error("the fallback must not run for the relay project");
	},
};

function input(projectDir = CI_PROJECT): CommandRunInput & { progress: string[] } {
	const progress: string[] = [];
	// SAFETY: the relay plan and up read only the project, the cwd flag and emitProgress.
	const run = {
		verb: "up",
		args: [],
		flags: { cwd: projectDir },
		context: { cwd: projectDir, projectDir },
		emitProgress: (message: string) => progress.push(message),
	} as CommandRunInput;
	return Object.assign(run, { progress });
}

describe("hobo ci up through the relay's Yards", () => {
	it("finds the relay project for the bundled CI project", () => {
		expect(relayProjectDirFor(CI_PROJECT)).toBe(RELAY);
		expect(relayProjectDirFor(RELAY)).toBe(RELAY);
	});

	it("plans every relay resource on the relay's Yards, whatever this machine has registered", async () => {
		const runtime = createDefaultYardRuntime({ env: {} });
		// SAFETY: the default runtime's store is the runtime-local one.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });
		const plan = envelope(
			(await cli.run(["ci", "plan", "--json"], { cwd: CI_PROJECT, env: {} })).stdout,
		);
		expect(plan.ok, JSON.stringify(plan.data?.remediations)).toBe(true);
		const providers = new Map<string, string>(
			plan.data.resources.map((r: { name: string; provider: string }) => [
				r.name,
				r.provider,
			]),
		);
		expect(providers.get("relay")).toBe("yard:hobo-ci-relay");
		expect(providers.get("hobo-ci-repair")).toBe("yard:hobo-ci-relay");
		expect(providers.get("hobo-ci-intake")).toBe("yard:hobo-ci-relay");
		expect(providers.get("config")).toBe("yard:hobo-ci-relay-config");
	});

	it("up refuses without a Vercel connection, and points at hobo cd up", async () => {
		const up = createCiRelayUpCommand(createTrustedVault(), never, {
			deploy: async () => {
				throw new Error("nothing is deployed without a token");
			},
		});
		const result = await up.run(input());
		expect(result.code).toBe("HOBO_CI_UP_VERCEL_NOT_CONNECTED");
		expect(result.remediation?.join(" ")).toMatch(/hobo cd up/);
	});

	it("up delivers the current branch to the relay's preview with the vault's token", async () => {
		const vault = createTrustedVault();
		vault.put("VERCEL_TOKEN", "from-the-store");
		let delivered: Parameters<typeof runCiRelayDeploy>[0] | undefined;
		const up = createCiRelayUpCommand(vault, never, {
			head: async () => ({ ref: "feature/x", sha: "a".repeat(40) }),
			deploy: async (request) => {
				delivered = request;
				return { ok: true, status: "deployed", code: "HOBO_OK", message: "ok", data: {} };
			},
		});
		const result = await up.run(input());
		expect(result.ok).toBe(true);
		expect(delivered?.cwd).toBe(RELAY);
		expect(delivered?.values).toEqual({
			ref: "feature/x",
			sha: "a".repeat(40),
			target: "preview",
		});
		expect(delivered?.credentials?.reveal("VERCEL_TOKEN")).toBe("from-the-store");
	});

	it("plan falls back for a project with no relay Yard", async () => {
		let fellBack = false;
		const plan = createCiRelayPlanCommand(createDefaultYardRuntime({ env: {} }), {
			implemented: true,
			run: async () => {
				fellBack = true;
				return { ok: true, status: "ok", code: "HOBO_OK", message: "", data: {} };
			},
		});
		await plan.run(input("/nowhere"));
		expect(fellBack).toBe(true);
	});
});
