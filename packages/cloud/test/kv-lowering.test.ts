import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { lowerManifest } from "../src/index.js";

describe("SDK key-value lowering", () => {
	it("selects the key-value port without inventing consistency or changing explicit ports", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				cache: { type: "data.v1", port: "hobo:data", paradigm: "key-value" },
				database: {
					type: "data.v1",
					port: "hobo:data",
					paradigm: "relational",
				},
				explicit: { type: "data.v1", port: "hobo:kv" },
			},
		});
		expect(lowerManifest(manifest)).toMatchObject([
			{ name: "cache", port: "kv", require: [] },
			{ name: "database", port: "data", require: [] },
			{ name: "explicit", port: "kv", require: ["eventual"] },
		]);
	});
});
