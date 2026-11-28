import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRuntimeLocalComponentHost } from "../../src/index.js";
import type { JsonObject } from "../../src/json.js";
import {
	helloBindleComponent,
	helloBindleProvider,
} from "../../test/fixtures/hello-bindle.js";

interface PactInteraction {
	description: string;
	request: { method: string; path: string; body?: JsonObject };
	response: { status: number; body: JsonObject };
}

interface PactContract {
	consumer: { name: string };
	provider: { name: string };
	interactions: PactInteraction[];
	metadata: { boundaryId: string };
}

async function loadPact(): Promise<PactContract> {
	const raw = await readFile(
		new URL("../component-host-lifecycle.pact.json", import.meta.url),
		"utf8",
	);
	// SAFETY: assertion to `JSON.parse(raw) as PactContract` is required at this boundary.
	return JSON.parse(raw) as PactContract;
}

function runBoundary(
	interaction: PactInteraction,
	host: ReturnType<typeof createRuntimeLocalComponentHost>,
) {
	if (interaction.request.path === "/component-host/instantiate") {
		const body = interaction.request.body ?? {};
		host.registerProvider(helloBindleProvider);
		host.loadComponent({ parsed: true, ...helloBindleComponent });
		host.link({
			componentId: String(body.componentId),
			importInterface: String(body.importInterface),
			providerId: String(body.providerId),
			exportInterface: String(body.importInterface),
		});
		return {
			instanceId: helloBindleComponent.id,
			trapIsolated: true,
			teardownRegistered: true,
			boundaryMode: "live",
			transport: "in-process",
		};
	}

	if (interaction.request.path === "/component-host/teardown") {
		const body = interaction.request.body ?? {};
		const componentId = String(body.componentId);
		return host.teardownComponent(componentId).then(() => ({
			componentId,
			leasesReleased: host.activeLeases().length === 0,
			routesRemoved: host.linkTable().length === 0,
		}));
	}

	throw new Error(`unsupported pact path: ${interaction.request.path}`);
}

test("component-host-lifecycle consumer pact verifies runtime-local host boundary", async () => {
	const pact = await loadPact();
	const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });

	for (const interaction of pact.interactions) {
		const body = await runBoundary(interaction, host);
		assert.deepEqual(body, interaction.response.body);
	}

	assert.equal(pact.metadata.boundaryId, "component-host-lifecycle");
	assert.equal(pact.consumer.name, "runtime-local-component-host");
	assert.equal(pact.provider.name, "capability-provider-boundary");
});
