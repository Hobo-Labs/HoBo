import { bindle, cache, collectBindleManifest, kv } from "@hobo/bindles";
import { lowerManifest } from "@hobo/cloud";
import { describe, expect, it } from "vitest";
import { targetFromBindleDefinition } from "../src/cloud/loader.js";

describe("SDK cache catalog", () => {
	it("keeps cache declarations distinct from durable key-value storage through collection and lowering", () => {
		expect(cache("sessions").portRef).toEqual(["hobo:cache"]);
		expect(kv("sessions").portRef).toEqual(["wasi:keyvalue"]);
		const app = bindle("cache-test", (builder) => {
			const sessions = builder.cache().allow("get", "set", "invalidate");
			const source = builder.kv().allow("get", "set");
			const api = builder.api().dependsOn(sessions, source);
			return { sessions, source, api };
		});
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		const resources = Object.values(manifest.value.resources);
		const cached = resources.find((resource) => resource.port === "hobo:cache");
		const durable = resources.find(
			(resource) => resource.paradigm === "key-value",
		);
		expect(cached).toMatchObject({
			type: "data.v1",
			paradigm: "cache",
			allow: ["get", "invalidate", "set"],
		});
		expect(durable).toMatchObject({ type: "data.v1", port: "hobo:data" });
		const intents = lowerManifest(manifest);
		expect(
			intents.find((intent) => intent.require.includes("atomicCompareAndSet")),
		).toMatchObject({ port: "kv", require: ["ttl", "atomicCompareAndSet"] });
		expect(
			intents.find((intent) => intent.name.includes("source")),
		).toMatchObject({ port: "kv", require: [] });
	});
});
