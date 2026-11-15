import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	deploymentPlanned,
	hashDeploymentPlan,
	type IacProgram,
	type IacProvider,
	type ResourcePlan,
} from "@hobo/cloud";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	secretRefJunctions,
	withSecretRefExecution,
} from "../src/secret-ref-executor.js";

// A secret placed on the owner's store is executed as a reference: the store
// opened and answering, the reference returned, nothing provisioned or
// deleted, and the provider junction that joins the reader's Yard to the
// store's named. Every other program goes to the lane underneath.

const DEPLOYMENT = "app";
const stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const nodes: ResourcePlan[] = [
	{
		name: "api",
		port: "compute",
		provider: "@hobo/provider-cloudflare",
		deps: ["config"],
		strategy: "rolling-update",
	},
	{
		name: "config",
		port: "secretRef",
		provider: "secret-store:bitwarden",
		deps: [],
		strategy: "rolling-update",
	},
];

async function recorded(): Promise<RuntimeLocalEventStore> {
	const store = createRuntimeLocalEventStore({
		dataDir: mkdtempSync(join(tmpdir(), "hobo-secret-ref-")),
		clock: createManualClock(),
	});
	stores.push(store);
	const plan: DeploymentPlan = {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources: nodes,
		dependencyOrder: ["config", "api"],
		objective: "min-cost",
	};
	await store.append(
		`deployment:${DEPLOYMENT}`,
		[
			deploymentPlanned({
				deploymentId: DEPLOYMENT,
				planHash: hashDeploymentPlan(plan),
				plan,
			}),
		],
		{
			expectedSeq: 0,
			actor: { kind: "system", id: "test" },
			tenant: "hobo-dev",
		},
	);
	return store;
}

function program(resourceId: string, provider: string): IacProgram {
	return {
		programId: `prog-${resourceId}`,
		deploymentId: DEPLOYMENT,
		resourceId,
		provider,
		driver: "test",
		action: "apply",
		stackName: `${DEPLOYMENT}/${resourceId}`,
	};
}

function bitwarden(): OpenedSecretStore {
	return {
		id: "bitwarden",
		port: createMemorySecretsPort({ id: "memory" }),
		reference: (name) => `bitwarden://org/project/${name}`,
	};
}

function lane() {
	const applied: string[] = [];
	const inner: IacProvider = {
		id: "lane",
		async preview() {
			return { summary: "lane", changes: 1 };
		},
		async apply(p) {
			applied.push(p.resourceId);
			return { binding: p.resourceId };
		},
		async destroy(p) {
			applied.push(`-${p.resourceId}`);
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
	return { inner, applied };
}

describe("secretRef execution", () => {
	it("returns the reference and the provider junction, and leaves the rest to the lane", async () => {
		const { inner, applied } = lane();
		const iac = withSecretRefExecution(inner, {
			open: async () => bitwarden(),
			store: await recorded(),
		});
		await expect(
			iac.apply(program("config", "secret-store:bitwarden")),
		).resolves.toEqual({
			reference: "bitwarden://org/project/config",
			binding: "bitwarden://org/project/config",
			store: "bitwarden",
			junctions: "app-config-cloudflare",
		});
		await iac.apply(program("api", "@hobo/provider-cloudflare"));
		// The store's entries are the owner's: destroy deletes nothing there.
		await iac.destroy(program("config", "secret-store:bitwarden"));
		expect(applied).toEqual(["api"]);
	});

	it("refuses a store that did not open, or is not the one the plan chose", async () => {
		const store = await recorded();
		const { inner } = lane();
		await expect(
			withSecretRefExecution(inner, {
				open: async () => undefined,
				store,
			}).apply(program("config", "secret-store:bitwarden")),
		).rejects.toMatchObject({ code: "HOBO_SECRET_REF_STORE_UNAVAILABLE" });
		await expect(
			withSecretRefExecution(inner, {
				open: async () => ({ ...bitwarden(), id: "infisical" }),
				store,
			}).apply(program("config", "secret-store:bitwarden")),
		).rejects.toMatchObject({ code: "HOBO_SECRET_REF_STORE_MISMATCH" });
		await expect(
			withSecretRefExecution(inner, {
				open: async () => bitwarden(),
				store,
			}).apply(program("unplanned", "secret-store:bitwarden")),
		).rejects.toMatchObject({ code: "HOBO_SECRET_REF_UNPLANNED" });
	});

	it("joins each reader's provider Yard to the store's Yard", () => {
		const [joined] = secretRefJunctions(DEPLOYMENT, "config", nodes);
		expect(joined?.kind).toBe("junction");
		expect(joined?.members.map((member) => member.providerId).sort()).toEqual([
			"bitwarden",
			"cloudflare",
		]);
		expect(secretRefJunctions(DEPLOYMENT, "api", nodes)).toEqual([]);
	});
});
