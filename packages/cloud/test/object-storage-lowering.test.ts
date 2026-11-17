import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { lowerManifest } from "../src/index.js";

describe("SDK object storage lowering", () => {
	it("lowers generic object and relational data while preserving explicit ports", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				bucket: { type: "data.v1", port: "hobo:data", paradigm: "object" },
				database: {
					type: "data.v1",
					port: "hobo:data",
					paradigm: "relational",
				},
				explicit: { type: "data.v1", port: "hobo:kv", paradigm: "object" },
			},
		});
		expect(lowerManifest(manifest)).toMatchObject([
			{ name: "bucket", port: "objectStore", require: ["durable"] },
			{ name: "database", port: "database", require: [] },
			{ name: "explicit", port: "kv", require: ["eventual"] },
		]);
	});
});
