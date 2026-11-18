import {
	bindle,
	collectBindleManifest,
	resourceIdentityLedger,
} from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { targetFromBindleDefinition } from "../src/cloud/loader.js";

describe("generated Bindle resource IDs", () => {
	it("keeps legacy manifests unchanged and lowers reviewed IDs independently of aliases", () => {
		const initial = bindle("shop", (builder) => {
			const cache = builder.kv();
			const api = builder.api().dependsOn(cache);
			return { cache, api };
		});
		const legacy = collectBindleManifest(targetFromBindleDefinition(initial));
		expect(legacy.resources).toEqual(["api", "cache"]);

		const ledger = resourceIdentityLedger(initial);
		const renamed = bindle(
			"shop",
			(builder) => {
				const storage = builder.kv();
				const service = builder.api().dependsOn(storage);
				return { service, storage };
			},
			{ identityLedger: ledger },
		);
		const collected = collectBindleManifest(
			targetFromBindleDefinition(renamed),
		);
		expect(collected.resources).toEqual(["res_api_0001", "res_kv_0001"]);
		expect(collected.manifest.value.resources.res_api_0001?.bind).toContain(
			"res_kv_0001",
		);
		expect(collected.binds).toContain("res_api_0001.storage");
	});

	it("rejects a generated identity that does not match its resource kind", () => {
		const initial = bindle("shop", (builder) => ({ cache: builder.kv() }));
		const cache = initial.resources.cache;
		if (!cache) throw new Error("missing cache");
		const definition = {
			...initial,
			deploymentIdentity: "generated" as const,
			resources: {
				cache: { ...cache, generatedId: "res_api_0001" },
			},
		};
		expect(() => targetFromBindleDefinition(definition)).toThrow(
			/invalid resource identity/u,
		);
	});
});
