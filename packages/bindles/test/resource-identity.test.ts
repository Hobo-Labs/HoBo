import { describe, expect, it } from "vitest";
import { bindle } from "../src/bindle.js";
import { resourceIdentityLedger } from "../src/resource-identity.js";
import type { ResourceIdentityLedger } from "../src/types.js";

function original() {
	return bindle("shop", (builder) => {
		const cache = builder.kv();
		const api = builder.api().dependsOn(cache);
		return { cache, api };
	});
}

describe("Bindle resource identities", () => {
	it("preserves existing deployment IDs while exposing generated IDs", () => {
		const definition = original();
		expect(definition.resources.cache?.stableId).toBe("kv:cache");
		expect(definition.resources.cache?.generatedId).toBe("res_kv_0001");
		expect(JSON.stringify(definition)).not.toContain("generatedId");
		expect(resourceIdentityLedger(definition)).toEqual({
			bindleName: "shop",
			entries: [
				{ kind: "api", occurrence: 1, generatedId: "res_api_0001" },
				{ kind: "kv", occurrence: 1, generatedId: "res_kv_0001" },
			],
		});
	});

	it("keeps generated IDs stable when aliases are renamed or reordered", () => {
		const ledger = resourceIdentityLedger(original());
		const handler = () => () => new Response("ready");
		const renamed = bindle(
			"shop",
			(builder) => {
				const cache = builder.kv();
				const api = builder.api(handler).dependsOn(cache);
				return { service: api, storage: cache };
			},
			{ identityLedger: ledger },
		);
		expect(renamed.deploymentIdentity).toBe("generated");
		expect(renamed.resources.service?.stableId).toBe("api:res_api_0001");
		expect(renamed.resources.storage?.generatedId).toBe("res_kv_0001");
		expect(renamed.entrypoint("service")).toBe(handler);
		expect(renamed.entrypoint("res_api_0001")).toBe(handler);
		expect(
			JSON.parse(JSON.stringify(renamed)).resources.storage.generatedId,
		).toBe("res_kv_0001");
	});

	it("accepts a reviewed mapping for a same-kind insertion", () => {
		const ledger: ResourceIdentityLedger = {
			bindleName: "shop",
			entries: [
				{ kind: "kv", occurrence: 1, generatedId: "res_kv_0002" },
				{ kind: "kv", occurrence: 2, generatedId: "res_kv_0001" },
				{ kind: "api", occurrence: 1, generatedId: "res_api_0001" },
			],
		};
		const definition = bindle(
			"shop",
			(builder) => {
				const inserted = builder.kv();
				const existing = builder.kv();
				const api = builder.api().dependsOn(existing);
				return { inserted, existing, api };
			},
			{ identityLedger: ledger },
		);
		expect(definition.resources.existing?.generatedId).toBe("res_kv_0001");
		expect(definition.resources.inserted?.generatedId).toBe("res_kv_0002");
		expect(resourceIdentityLedger(definition).entries).toContainEqual({
			kind: "kv",
			occurrence: 2,
			generatedId: "res_kv_0001",
		});
	});

	it("rejects missing, duplicate, foreign, and unused ledger entries", () => {
		const ledger = resourceIdentityLedger(original());
		const duplicate = {
			kind: "kv" as const,
			occurrence: 1,
			generatedId: "res_kv_0001",
		};
		const build = () =>
			bindle(
				"shop",
				(builder) => ({ cache: builder.kv(), api: builder.api() }),
				{ identityLedger: ledger },
			);
		expect(build).not.toThrow();
		expect(() =>
			bindle("other", (builder) => ({ cache: builder.kv() }), {
				identityLedger: ledger,
			}),
		).toThrow(/match the Bindle/u);
		expect(() =>
			bindle(
				"shop",
				(builder) => ({
					cache: builder.kv(),
					api: builder.api(),
					extra: builder.kv(),
				}),
				{ identityLedger: ledger },
			),
		).toThrow(/missing kv:2/u);
		expect(() =>
			bindle("shop", (builder) => ({ cache: builder.kv() }), {
				identityLedger: ledger,
			}),
		).toThrow(/unused entries/u);
		expect(() =>
			bindle("shop", (builder) => ({ cache: builder.kv() }), {
				identityLedger: { ...ledger, entries: [duplicate, duplicate] },
			}),
		).toThrow(/duplicate entries/u);
	});
});
