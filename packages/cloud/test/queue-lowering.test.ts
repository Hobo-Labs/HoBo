import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { lowerManifest } from "../src/index.js";

describe("SDK queue lowering", () => {
	it("retains queue identity without asserting delivery guarantees or changing an explicit port", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				jobs: { type: "data.v1", port: "hobo:data", paradigm: "queue" },
				explicit: { type: "data.v1", port: "hobo:kv", paradigm: "queue" },
			},
		});
		expect(lowerManifest(manifest)).toMatchObject([
			{ name: "explicit", port: "kv", require: ["eventual"] },
			{ name: "jobs", port: "queue", require: [] },
		]);
	});
});
