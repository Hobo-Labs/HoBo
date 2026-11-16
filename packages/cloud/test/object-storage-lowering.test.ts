import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { lowerManifest } from "../src/index.js";

describe("SDK object storage lowering", () => {
	it("uses the object paradigm for generic data ports while preserving explicit ports and relational data", () => {
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
			{ name: "database", port: "data", require: [] },
			{ name: "explicit", port: "kv", require: ["eventual"] },
		]);
	});
});
