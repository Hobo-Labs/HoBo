import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@hobo/bindles";
import {
	collectStream,
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import { at, first } from "@hobo/core/total-access";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createFixtureSession,
	createYardClient,
	type YardRuntime,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

// Consumer pact pinning the CLI <-> Yard (@hobo/cloud) boundary. The CLI's cloud
// verbs share one call path (the yard-client seam); this contract asserts that
// seam's observable responses against the recorded expectations, so MCP parity
// (S3-01) can reuse the same boundary.

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"cli-yard-boundary.pact.json",
);

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions", "assets"],
		},
		sessions: { type: "data.v1", port: "kv" },
		assets: { type: "data.v1", port: "objectStore" },
	},
};

const UNSATISFIABLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["ledger"],
		},
		ledger: { type: "data.v1", port: "hobo:database" },
	},
};

interface Interaction {
	description: string;
	request: { operation: string; bindle: string };
	response: JsonObject;
}

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

function inMemoryIac(): IacProvider {
	return {
		id: "mock-local-container",
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {
			/* no-op */
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

function makeRuntime(): YardRuntime {
	const dir = join(
		tmpdir(),
		`hobo-cli-pact-${Math.random().toString(36).slice(2)}`,
	);
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(store);
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac: inMemoryIac() }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
}

function interaction(
	pact: { interactions: Interaction[] },
	description: string,
): Interaction {
	const found = pact.interactions.find(
		(entry) => entry.description === description,
	);
	if (!found) throw new Error(`missing pact interaction: ${description}`);
	return found;
}

describe("CLI <-> Yard boundary pact", () => {
	// SAFETY: `const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {` is required at this I/O or test boundary.
	const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: Interaction[];
	};

	it("names the CLI consumer and the Yard provider", () => {
		expect(pact.consumer.name).toBe("@hobo/cli");
		expect(pact.provider.name).toBe("@hobo/cloud");
	});

	it("hobo plan previews the DeploymentPlan without side-effect events", async () => {
		const runtime = makeRuntime();
		const client = createYardClient(runtime);
		const rendered = client.plan(parseManifest(HELLO_BINDLE), {
			deploymentId: "pact-plan",
		});

		const expected = interaction(
			pact,
			first(pact.interactions).description,
		).response;
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		expect(rendered.dependencyOrder).toEqual(expected.dependencyOrder);
		expect(rendered.resources.map((r) => r.name)).toEqual(expected.resources);

		// Read-only: the pure Planner appended nothing to the deployment stream.
		const events = await collectStream(runtime.store, "deployment:pact-plan");
		expect(events).toEqual(expected.sideEffectEvents);
	});

	it("hobo up drives the gateway and orchestrator to deployment.Deployed", async () => {
		const runtime = makeRuntime();
		const client = createYardClient(runtime);
		const session = createFixtureSession({ subject: "pact" });
		const result = await client.up(parseManifest(HELLO_BINDLE), {
			deploymentId: "pact-up",
			session,
		});

		const expected = interaction(
			pact,
			at(pact.interactions, 1).description,
		).response;
		expect(result.status).toBe(expected.status);
		if (result.status === "rejected") throw new Error("unexpected rejection");
		expect(result.provisioned).toEqual(expected.provisioned);

		const events = await collectStream(runtime.store, "deployment:pact-up");
		expect(events.at(-1)?.type).toBe(expected.terminalEvent);
	});

	it("hobo down drives the compensation/destroy path to Destroyed", async () => {
		const runtime = makeRuntime();
		const client = createYardClient(runtime);
		const session = createFixtureSession({ subject: "pact" });
		const bindle = parseManifest(HELLO_BINDLE);
		await client.up(bindle, { deploymentId: "pact-down", session });
		const result = await client.down(bindle, {
			deploymentId: "pact-down",
			session,
		});

		const expected = interaction(
			pact,
			at(pact.interactions, 2).description,
		).response;
		expect(result.status).toBe(expected.status);
		expect([...result.destroyed].sort()).toEqual(expected.destroyed);
	});

	it("rejects an unsatisfiable manifest with machine-readable remediation", () => {
		const runtime = makeRuntime();
		const client = createYardClient(runtime);
		const rendered = client.plan(parseManifest(UNSATISFIABLE), {
			deploymentId: "pact-reject",
		});

		const expected = interaction(
			pact,
			at(pact.interactions, 3).description,
		).response;
		expect(rendered.ok).toBe(false);
		if (rendered.ok) return;
		expect(rendered.remediations[0]?.resource).toBe(
			expected.remediationResource,
		);
		expect(rendered.remediations[0]?.code).toBe(expected.remediationCode);
	});
});
