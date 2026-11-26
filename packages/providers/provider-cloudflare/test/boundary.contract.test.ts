import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	createHelloBindlePlan,
	parsePublishedManifest,
	publishCapabilityManifest,
	realizeHelloBindle,
	realizeResourcePlan,
} from "../src/index.js";

const contractsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
);
const boundaryPact = JSON.parse(
	readFileSync(
		join(contractsDir, "provider-cloudflare-boundary.pact.json"),
		"utf8",
	),
);
const realizePact = JSON.parse(
	readFileSync(
		join(contractsDir, "provider-cloudflare-realize-emission.pact.json"),
		"utf8",
	),
);

describe("ProviderCloudflareBoundary pact (consumer contract)", () => {
	it("manifest publish satisfies the boundary contract paths", () => {
		const published = publishCapabilityManifest();
		const parsed = parsePublishedManifest(published);

		assert.equal(boundaryPact.consumer.name, "@hobo/runtime");
		assert.equal(boundaryPact.provider.name, "ProviderCloudflareBoundary");
		assert.equal(boundaryPact.interactions[0].response.body.ok, true);
		assert.equal(parsed.ok, true);
		assert.deepEqual(
			Object.keys(published).sort(),
			[...boundaryPact.interactions[0].response.body.paths].sort(),
		);
	});

	it("realize hello-bindle satisfies the boundary contract resource ids", () => {
		const { iac } = realizeHelloBindle(createHelloBindlePlan());
		assert.equal(boundaryPact.interactions[1].response.body.ok, true);
		assert.deepEqual(
			iac.resources.map((resource) => resource.name).sort(),
			[...boundaryPact.interactions[1].response.body.resourceIds].sort(),
		);
	});
});

describe("RealizeEmissionBoundary pact (consumer contract)", () => {
	it("single-port realize matches the emission contract body", () => {
		const interaction = realizePact.interactions[0];
		const { iac } = realizeResourcePlan({
			name: interaction.request.body.name,
			port: interaction.request.body.port,
			provider: interaction.request.body.provider,
		});
		const expected = interaction.response.body;

		assert.equal(realizePact.provider.name, "RealizeEmissionBoundary");
		assert.equal(iac.apiVersion, expected.apiVersion);
		assert.equal(iac.kind, expected.kind);
		assert.equal(iac.provider, expected.provider);
		assert.equal(iac.resources[0]?.type, expected.resourceClass);
	});

	it("whole-plan realize matches the emission contract resource ids and classes", () => {
		const { iac } = realizeHelloBindle(createHelloBindlePlan());
		const expected = realizePact.interactions[1].response.body;
		assert.deepEqual(
			iac.resources.map((resource) => resource.name),
			expected.resourceIds,
		);
		assert.deepEqual(
			iac.resources.map((resource) => resource.type),
			expected.resourceClasses,
		);
	});
});
