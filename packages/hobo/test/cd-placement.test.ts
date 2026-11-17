import path from "node:path";
import { fileURLToPath } from "node:url";

import type { IacProgram, IacProvider } from "@hobo/cloud";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { routePreparedPlacements } from "../src/cd-placement.js";
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

	it("passes every other resource to the deploy provider", async () => {
		calls.length = 0;
		const iac = routePreparedPlacements(deploy);
		await iac.apply(program("cd-api", "@hobo/provider-vercel"));
		await iac.destroy(program("cd-api", "@hobo/provider-vercel"));
		expect(calls).toEqual(["apply cd-api", "destroy cd-api"]);
	});
});
