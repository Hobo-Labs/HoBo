import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { lowerManifest } from "../src/index.js";

const base = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		config: {
			type: "data.v1",
			port: "hobo:data",
			paradigm: "secret",
			allow: ["put", "access", "put"],
		},
	},
};

describe("SDK secret lowering", () => {
	it("requires the exact allowed operations in stable order", () => {
		expect(lowerManifest(parseManifest(base))).toMatchObject([
			{ name: "config", port: "secretRef", require: ["access", "put"] },
		]);
	});

	it("rejects an unsupported operation instead of weakening the request", () => {
		expect(() =>
			lowerManifest(
				parseManifest({
					...base,
					resources: {
						config: { ...base.resources.config, allow: ["invented"] },
					},
				}),
			),
		).toThrow(/unsupported access operation/u);
	});

	it("does not override an explicitly declared different port", () => {
		const manifest = parseManifest({
			...base,
			resources: {
				config: { ...base.resources.config, port: "hobo:kv" },
			},
		});
		expect(lowerManifest(manifest)).toMatchObject([
			{ name: "config", port: "kv", require: ["eventual"] },
		]);
	});
});
