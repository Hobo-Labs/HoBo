import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { data, kv } from "../../src/catalog.js";
import { secretRef } from "../../src/secret-ref.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"contracts",
	"pacts",
	"bindles-sdk-lowering.pact.json",
);

describe("bindles → sdk-collector lowering pact", () => {
	it("emits lowering descriptors and resource descriptors for the collector boundary", () => {
		const state = kv("todos").allow("get", "set");
		const records = data("records");
		const loweringBatch = [
			state.get("next"),
			state.set("next", { id: "1" }),
			records.query({ text: "needle" }),
		];
		const resourceBatch = [state.toDescriptor(), records.toDescriptor()];

		const pact = {
			consumer: { name: "@hobo/bindles" },
			provider: { name: "hobo-sdk-collector" },
			interactions: [
				{
					description: "submit lowering descriptor batch",
					request: {
						method: "POST",
						path: "/lower",
						body: {
							schema: "hobo.bindles.lowering/v1",
							descriptors: loweringBatch,
						},
					},
					response: {
						status: 200,
						body: { accepted: loweringBatch.length },
					},
				},
				{
					description: "submit resource descriptor set",
					request: {
						method: "POST",
						path: "/resources",
						body: {
							schema: "hobo.bindles.resource/v1",
							descriptors: resourceBatch,
						},
					},
					response: {
						status: 200,
						body: { accepted: resourceBatch.length },
					},
				},
				{
					description:
						"secretRef value reads are distinct from managed secret resources",
					request: {
						method: "POST",
						path: "/secret-ref",
						body: secretRef("STRIPE_API_KEY"),
					},
					response: {
						status: 200,
						body: { kind: "secret-ref", lowersTo: "hobo:sdk" },
					},
				},
			],
			metadata: { pactSpecification: { version: "3.0.0" } },
		};

		writeFileSync(pactPath, `${JSON.stringify(pact, null, 2)}\n`, "utf8");

		const written = JSON.parse(readFileSync(pactPath, "utf8"));
		expect(written.consumer.name).toBe("@hobo/bindles");
		expect(written.provider.name).toBe("hobo-sdk-collector");
		expect(written.interactions).toHaveLength(3);
		expect(loweringBatch.every((entry) => entry.lowersTo === "hobo:sdk")).toBe(
			true,
		);
		expect(resourceBatch.every((entry) => entry.stableId.includes(":"))).toBe(
			true,
		);
	});
});
