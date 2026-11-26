import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	canonicalManifestHash,
	parseManifest,
	serializeManifest,
} from "../../src/manifest/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const goldenManifest = JSON.parse(
	readFileSync(
		join(testDir, "../fixtures/manifests/golden/db-api-site.json"),
		"utf8",
	),
);
const pactPath = join(
	testDir,
	"../../contracts/pacts/manifest-ir-registry.pact.json",
);

describe("Manifest IR Registry pact", () => {
	it("registers a manifest and writes the consumer pact fixture", () => {
		const manifest = parseManifest(goldenManifest);
		const hash = canonicalManifestHash(manifest);
		const body = {
			schema: "hobo.manifest/v1",
			manifest: JSON.parse(serializeManifest(manifest)),
		};

		const pact = {
			consumer: { name: "BindlesManifestEmitter" },
			provider: { name: "ManifestIrRegistry" },
			interactions: [
				{
					description: "register parsed hobo.manifest/v1 deployment IR",
					request: {
						method: "POST",
						path: "/manifests",
						body,
					},
					response: {
						status: 201,
						body: {
							schema: "hobo.manifest/v1",
							hash,
						},
					},
				},
			],
			metadata: { pactSpecification: { version: "3.0.0" } },
		};

		mkdirSync(dirname(pactPath), { recursive: true });
		writeFileSync(pactPath, `${JSON.stringify(pact, null, 2)}\n`);

		expect(pact.consumer.name).toBe("BindlesManifestEmitter");
		expect(pact.provider.name).toBe("ManifestIrRegistry");
		expect(pact.interactions[0]?.response.body.hash).toMatch(
			/^sha256:[a-f0-9]{64}$/,
		);
	});
});
