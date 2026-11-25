import { describe, expect, it } from "vitest";

import {
	type CollectionContext,
	CollectionEngineError,
	type CollectionTarget,
	canonicalManifestHash,
	collectBindleManifest,
	compileBindleManifest,
	manifestFromWiring,
} from "../../src/index.js";
import {
	data as wiringData,
	service as wiringService,
} from "../../src/wiring/index.js";

const COMPONENT_HOST = { kind: "wasmtime", version: "46.0.1" } as const;

// The hello-bindle: a data resource + a service bound to it. The same
// declarations run two ways — enumerated statically for compileBindleManifest,
// and run in collection mode for collectBindleManifest.
function helloTarget(): CollectionTarget {
	return {
		bindleId: "hello-bindle",
		componentHost: COMPONENT_HOST,
		define(collect: CollectionContext) {
			const db = collect.data("db", { paradigm: "relational" });
			collect.service("api", {
				image: "oci://registry.example.com/api@sha256:abc123",
				bind: { db },
			});
		},
	};
}

describe("run-to-collect engine (S1-12b)", () => {
	it("produces a manifest byte-identical to the static compileBindleManifest", () => {
		const db = wiringData("db", { paradigm: "relational" });
		const api = wiringService("api", {
			image: "oci://registry.example.com/api@sha256:abc123",
			bind: { db },
		});
		const staticManifest = manifestFromWiring(
			compileBindleManifest([db, api]),
			COMPONENT_HOST,
		);
		const staticHash = canonicalManifestHash(staticManifest);

		const collected = collectBindleManifest(helloTarget());

		expect(collected.manifestHash).toBe(staticHash);
		expect(canonicalManifestHash(collected.manifest)).toBe(staticHash);
	});

	it("is deterministic across two runs of the same Bindle", () => {
		const first = collectBindleManifest(helloTarget());
		const second = collectBindleManifest(helloTarget());

		expect(second.manifestHash).toBe(first.manifestHash);
		expect(second.events).toEqual(first.events);
		expect(second.resources).toEqual(first.resources);
		expect(second.binds).toEqual(first.binds);
	});

	it("emits bindle.ResourcesCollected then bindle.ManifestProduced", () => {
		const result = collectBindleManifest(helloTarget());

		expect(result.events.map((event) => event.type)).toEqual([
			"bindle.ResourcesCollected",
			"bindle.ManifestProduced",
		]);
		const [collected, produced] = result.events;
		expect(collected?.seq).toBe(1);
		expect(collected?.type === "bindle.ResourcesCollected").toBe(true);
		if (collected?.type === "bindle.ResourcesCollected") {
			expect(collected.data.bindleId).toBe("hello-bindle");
			expect(collected.data.resources).toEqual(["api", "db"]);
			expect(collected.data.binds).toEqual(["api.db"]);
		}
		expect(produced?.seq).toBe(2);
		if (produced?.type === "bindle.ManifestProduced") {
			expect(produced.data.manifestHash).toBe(result.manifestHash);
			expect(produced.data.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
	});

	it("surfaces the manifest IR resources it observed", () => {
		const result = collectBindleManifest(helloTarget());

		expect(result.resources).toEqual(["api", "db"]);
		expect(result.manifest.value.resources.api?.type).toBe("component.v1");
		expect(result.manifest.value.resources.db?.type).toBe("data.v1");
	});

	it("rejects a target without a define function", () => {
		expect(() =>
			// SAFETY: assertion required at this I/O or test boundary.
			collectBindleManifest({
				bindleId: "broken",
				componentHost: COMPONENT_HOST,
			} as CollectionTarget),
		).toThrow(CollectionEngineError);
	});
});
