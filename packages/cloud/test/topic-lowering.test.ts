import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { lowerManifest } from "../src/index.js";

describe("SDK topic lowering", () => {
	it("keeps topics and queues as different capabilities without inventing delivery guarantees", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				events: { type: "data.v1", port: "hobo:data", paradigm: "topic" },
				jobs: { type: "data.v1", port: "hobo:data", paradigm: "queue" },
			},
		});
		expect(lowerManifest(manifest)).toMatchObject([
			{ name: "events", port: "topic", require: [] },
			{ name: "jobs", port: "queue", require: [] },
		]);
	});
});
