import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHoboCli, createUpCommand } from "@hobo/cli";
import {
	createInProcessExecutor,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import { CD_PLACEMENT_YARDS } from "@hobo/hobo-cd";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	routePreparedPlacements,
	withYardOfferings,
} from "../src/cd-placement.js";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

// `hobo cd plan` places the CD project's journal and its config where `hobo cd
// up` makes them: the journal on the fleet `prepare` provisions (Neon
// Claimable Postgres), the config in the owner's secret store. Neither is a
// provider this machine registers, so without these Yards the plan was
// rejected for both (`capability.port-unavailable`).

const packages = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CD_PROJECT = path.join(packages, "hobo-cd");

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

async function planCd() {
	const runtime = createDefaultYardRuntime({ env: {} });
	// SAFETY: the default runtime's store is the runtime-local one.
	stores.push(runtime.store as RuntimeLocalEventStore);
	const cli = createComposedHoboCli({ yardRuntime: runtime });
	const out = await cli.run(["cd", "plan", "--json"], {
		cwd: CD_PROJECT,
		env: {},
	});
	return JSON.parse(out.stdout);
}

describe("hobo cd plan places CD on its own Yards", () => {
	it("places the journal on its fleet's Yard and the config on the owner's store", async () => {
		const plan = await planCd();
		expect(plan.ok, JSON.stringify(plan.data?.remediations)).toBe(true);
		const providers = new Map<string, string>(
			plan.data.resources.map((r: { name: string; provider: string }) => [
				r.name,
				r.provider,
			]),
		);
		expect(providers.get("cd-journal")).toBe("yard:hobo-cd-journal");
		expect(providers.get("cd-config")).toBe("yard:hobo-cd-config");
	});
});

describe("hobo cd up hands each resource to whoever makes it", () => {
	const calls: string[] = [];
	const deploy: IacProvider = {
		id: "vercel-deploy:hobo-cd",
		preview: async (p) => {
			calls.push(`preview ${p.resourceId}`);
			return { summary: "", changes: 1 };
		},
		apply: async (p) => {
			calls.push(`apply ${p.resourceId}`);
			return { provider: "vercel" };
		},
		destroy: async (p) => {
			calls.push(`destroy ${p.resourceId}`);
		},
		refresh: async (p) => {
			calls.push(`refresh ${p.resourceId}`);
			return { drift: false, observed: {} };
		},
	};
	const program = (resourceId: string, provider: string): IacProgram => ({
		programId: `p-${resourceId}`,
		deploymentId: "hobo-cd",
		resourceId,
		provider,
		driver: "test",
		action: "apply",
		stackName: "hobo-cd",
	});

	it("records the journal and config prepare made, and deploys nothing for them", async () => {
		calls.length = 0;
		const iac = routePreparedPlacements(deploy);
		for (const [resource, yard] of [
			["cd-journal", "yard:hobo-cd-journal"],
			["cd-config", "yard:hobo-cd-config"],
		] as const) {
			expect((await iac.preview(program(resource, yard))).changes).toBe(0);
			expect(await iac.apply(program(resource, yard))).toEqual({
				provider: yard,
				realizedBy: "prepare",
			});
			// cd down never drops the journal's databases or the owner's store.
			await iac.destroy(program(resource, yard));
			expect((await iac.refresh(program(resource, yard))).drift).toBe(false);
		}
		expect(calls).toEqual([]);
	});

	it("refuses other resources merely assigned to a prepared Yard", async () => {
		calls.length = 0;
		const iac = routePreparedPlacements(deploy);
		for (const [resource, yard] of [
			["another-database", "yard:hobo-cd-journal"],
			["another-secret", "yard:hobo-cd-config"],
			["cd-config", "yard:hobo-cd-journal"],
		] as const) {
			for (const operation of [
				"preview",
				"apply",
				"destroy",
				"refresh",
			] as const) {
				await expect(iac[operation](program(resource, yard))).rejects.toThrow(
					/not prepared/u,
				);
			}
		}
		expect(calls).toEqual([]);
	});

	it("passes every other resource to the deploy provider", async () => {
		calls.length = 0;
		const iac = routePreparedPlacements(deploy);
		await iac.apply(program("cd-api", "@hobo/provider-vercel"));
		await iac.destroy(program("cd-api", "@hobo/provider-vercel"));
		expect(calls).toEqual(["apply cd-api", "destroy cd-api"]);
	});
});

it("does not send the prepared journal or store to the provider on cd down", async () => {
	const base = createDefaultYardRuntime({ env: {} });
	// SAFETY: the default runtime's store is the runtime-local one.
	stores.push(base.store as RuntimeLocalEventStore);
	const destroyed: string[] = [];
	const iac: IacProvider = {
		id: "test",
		preview: async () => ({ summary: "", changes: 1 }),
		apply: async () => ({}),
		destroy: async (p) => {
			destroyed.push(p.resourceId);
		},
		refresh: async () => ({ drift: false, observed: {} }),
	};
	const runtime = {
		...base,
		registry: withYardOfferings(base.registry, CD_PLACEMENT_YARDS),
		executor: createInProcessExecutor({ iac }),
	};
	const up = createHoboCli({ commands: { up: createUpCommand({ runtime }) } });
	const result = await up.run(["up", "--json"], { cwd: CD_PROJECT, env: {} });
	expect(JSON.parse(result.stdout)).toMatchObject({
		ok: true,
		status: "deployed",
	});
	const cli = createComposedHoboCli({ yardRuntime: runtime });
	const down = await cli.run(["cd", "down", "--json"], {
		cwd: CD_PROJECT,
		env: {},
	});
	expect(JSON.parse(down.stdout)).toMatchObject({
		ok: true,
		status: "destroyed",
	});
	expect(destroyed).not.toContain("cd-journal");
	expect(destroyed).not.toContain("cd-config");
});

it("refuses CD up and down before an unguarded hosting supervisor is called", async () => {
	const base = createDefaultYardRuntime({ env: {} });
	// SAFETY: the default runtime's store is the runtime-local one.
	stores.push(base.store as RuntimeLocalEventStore);
	const called: string[] = [];
	const cli = createComposedHoboCli({
		yardRuntime: {
			...base,
			hostingExecution: {
				up: async () => {
					called.push("up");
					throw new Error("unexpected");
				},
				down: async () => {
					called.push("down");
					throw new Error("unexpected");
				},
			},
		},
	});
	for (const action of ["up", "down"] as const) {
		const result = await cli.run(["cd", action, "--json"], {
			cwd: CD_PROJECT,
			env: {},
		});
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_CD_PREPARED_PLACEMENT_UNAVAILABLE",
		});
	}
	expect(called).toEqual([]);
});
