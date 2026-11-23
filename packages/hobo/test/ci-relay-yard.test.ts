import { fileURLToPath } from "node:url";

import { camp } from "@hobo/camps";
import { type YardBindingInput, YardBoundaryError, yard } from "@hobo/yards";
import { describe, expect, it } from "vitest";

import {
	loadRelayJoinedYards,
	loadRelayYard,
	RelayPlacementRefusal,
	resolveRelayPlacement,
} from "../src/ci-relay-yard.js";

// The relay's placement: a Yard's Camp for the target, and the rows chosen for
// the profiles it requires (ADR-0151 hard gates, then canonical order). Yards
// here are built in memory; the real one is loaded once at the end.

const CACHE = "kv.redis-compatible/v1";
const VALKEY = "kv.valkey/v1";
const CONFIG = "secret-ref.runtime-projection/v1";

const marketplace: YardBindingInput = {
	profile: CACHE,
	productId: "upstash.redis/v1",
	connectivityId: "vercel.marketplace/v1",
	properties: { integration: "upstash/upstash-kv", resource: "relay-cache" },
};
const configService: YardBindingInput = {
	profile: CONFIG,
	productId: "infisical.secrets/v1",
	connectivityId: "infisical.oidc-auth/v1",
	properties: {
		settings: { HOBO_CI_CONFIG_SERVICE: "infisical" },
		inputs: ["INFISICAL_PROJECT_ID", "INFISICAL_IDENTITY_ID"],
	},
};

// The config service is Infisical's: its row lives in Infisical's Yard,
// joined to the relay's Vercel Yard by the relay's junction.
const configYard = yard("relay-config", {
	provider: "infisical",
	bindings: [configService],
});

function configYardWith(row: YardBindingInput) {
	return yard("relay-config", { provider: "infisical", bindings: [row] });
}

function relayYard(
	bindings: readonly YardBindingInput[],
	camps = [
		camp("production", {
			envType: "production",
			require: [CACHE, CONFIG],
			resolverConfig: {
				properties: { settings: { INFISICAL_ENVIRONMENT: "prod" } },
			},
		}),
		camp("preview", { envType: "preview", require: [CACHE] }),
	],
) {
	return yard("relay", {
		provider: "vercel",
		properties: { project: "relay", repository: "example/relay" },
		bindings,
		camps,
	});
}

function refusal(run: () => void): RelayPlacementRefusal {
	try {
		run();
	} catch (error) {
		if (error instanceof RelayPlacementRefusal) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("resolveRelayPlacement", () => {
	it("chooses the Camp the target names, and the rows its required profiles have", () => {
		const placement = resolveRelayPlacement(
			relayYard([marketplace]),
			"production",
			[configYard],
		);
		expect(placement).toMatchObject({
			yard: "relay",
			camp: "relay/production",
			providerId: "vercel",
			project: "relay",
			repository: "example/relay",
			inputs: ["INFISICAL_IDENTITY_ID", "INFISICAL_PROJECT_ID"],
			attachments: [
				{
					profile: CACHE,
					integration: "upstash/upstash-kv",
					resource: "relay-cache",
				},
			],
		});
		expect([...placement.settings]).toEqual([
			["HOBO_CI_CONFIG_SERVICE", "infisical"],
			["INFISICAL_ENVIRONMENT", "prod"],
		]);
		expect(
			placement.bindings.map((binding) => [binding.profile, binding.selected]),
		).toEqual([
			[CACHE, true],
			[CONFIG, true],
		]);
	});

	it("projects nothing from a row its Camp does not require", () => {
		const placement = resolveRelayPlacement(
			relayYard([marketplace]),
			"preview",
			[configYard],
		);
		expect(placement.camp).toBe("relay/preview");
		expect([...placement.settings]).toEqual([]);
		expect(placement.inputs).toEqual([]);
		expect(placement.bindings.find((b) => b.profile === CONFIG)).toMatchObject({
			selected: false,
			settings: ["HOBO_CI_CONFIG_SERVICE"],
			inputs: ["INFISICAL_IDENTITY_ID", "INFISICAL_PROJECT_ID"],
		});
	});

	it("chooses the first row of a profile in canonical order, whatever order it was written in", () => {
		// Two offerings Vercel provisions and runs for us (Marketplace), so
		// both are internal to the Vercel Yard.
		const aiven: YardBindingInput = {
			profile: VALKEY,
			productId: "aiven.valkey/v1",
			connectivityId: "vercel.marketplace/v1",
			properties: { integration: "aiven", resource: "relay-cache" },
		};
		const selfHosted: YardBindingInput = {
			profile: VALKEY,
			productId: "upstash.valkey/v1",
			connectivityId: "vercel.marketplace/v1",
			properties: { integration: "upstash", resource: "relay-cache" },
		};
		const camps = [camp("preview", { envType: "preview", require: [VALKEY] })];
		for (const rows of [
			[selfHosted, aiven],
			[aiven, selfHosted],
		]) {
			const placement = resolveRelayPlacement(
				relayYard(rows, camps),
				"preview",
			);
			expect(
				placement.bindings
					.filter((binding) => binding.selected)
					.map((binding) => binding.productId),
			).toEqual(["aiven.valkey/v1"]);
		}
	});

	it("refuses another vendor's service inside the Vercel Yard; it belongs to its own Yard", () => {
		expect(() => relayYard([marketplace, configService])).toThrow(
			YardBoundaryError,
		);
	});

	it("fails closed on a required profile the Yard has no row for", () => {
		const error = refusal(() =>
			resolveRelayPlacement(relayYard([marketplace]), "production"),
		);
		expect(error.code).toBe("HOBO_CI_DEPLOY_BINDING_UNAVAILABLE");
		expect(error.message).toContain(`requires ${CONFIG}`);
	});

	it("refuses a target with no Camp, or with two", () => {
		const none = refusal(() =>
			resolveRelayPlacement(
				relayYard([marketplace], [camp("preview", { envType: "preview" })]),
				"production",
			),
		);
		expect(none.code).toBe("HOBO_CI_DEPLOY_NO_CAMP");
		const two = refusal(() =>
			resolveRelayPlacement(
				relayYard(
					[marketplace],
					[
						camp("preview", { envType: "preview" }),
						camp("preview-2", { envType: "preview" }),
					],
				),
				"preview",
			),
		);
		expect(two.code).toBe("HOBO_CI_DEPLOY_NO_CAMP");
	});

	it("refuses a binding that projects a credential, by name or by value", () => {
		for (const settings of [
			{ INFISICAL_TOKEN: "synthetic" },
			{ UPSTASH_REDIS_REST_URL: "https://synthetic.example.test" },
			{ HOBO_CI_PUBLIC_URL: "https://user:synthetic-pw@ci.example.test" },
		]) {
			const error = refusal(() =>
				resolveRelayPlacement(relayYard([marketplace]), "production", [
					configYardWith({ ...configService, properties: { settings } }),
				]),
			);
			expect(error.code).toBe("HOBO_CI_DEPLOY_SETTING_REFUSED");
			expect(error.message).not.toContain("synthetic");
		}
	});

	it("refuses an input that names a credential", () => {
		const error = refusal(() =>
			resolveRelayPlacement(relayYard([marketplace]), "production", [
				configYardWith({
					...configService,
					properties: { inputs: ["INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"] },
				}),
			]),
		);
		expect(error.code).toBe("HOBO_CI_DEPLOY_SETTING_REFUSED");
	});

	it("refuses two chosen rows that set one setting differently, and a setting that is also an input", () => {
		const disagreeing = refusal(() =>
			resolveRelayPlacement(
				relayYard([
					{
						...marketplace,
						properties: {
							...marketplace.properties,
							settings: { HOBO_CI_CONFIG_SERVICE: "env" },
						},
					},
				]),
				"production",
				[configYard],
			),
		);
		expect(disagreeing.code).toBe("HOBO_CI_DEPLOY_BINDING_CONFLICT");
		const both = refusal(() =>
			resolveRelayPlacement(
				relayYard(
					[marketplace],
					[
						camp("production", {
							envType: "production",
							require: [CACHE, CONFIG],
							resolverConfig: {
								properties: { settings: { INFISICAL_PROJECT_ID: "x" } },
							},
						}),
					],
				),
				"production",
				[configYard],
			),
		);
		expect(both.code).toBe("HOBO_CI_DEPLOY_BINDING_CONFLICT");
	});

	it("refuses a Marketplace row that does not name its integration and resource", () => {
		const error = refusal(() =>
			resolveRelayPlacement(
				relayYard(
					[{ ...marketplace, properties: { integration: "Upstash KV!" } }],
					[camp("preview", { envType: "preview", require: [CACHE] })],
				),
				"preview",
			),
		);
		expect(error.code).toBe("HOBO_CI_DEPLOY_BINDING_MALFORMED");
	});
});

describe("loadRelayYard", () => {
	it("loads the relay's own Yard from packages/ci-vercel/deploy/yard.ts", async () => {
		const loaded = await loadRelayYard(
			fileURLToPath(new URL("../../ci-vercel/", import.meta.url)),
		);
		expect(loaded?.name).toBe("hobo-ci-relay");
		expect(loaded?.providerId).toBe("vercel");
		const relayDir = fileURLToPath(
			new URL("../../ci-vercel/", import.meta.url),
		);
		const joined =
			loaded === undefined ? [] : await loadRelayJoinedYards(relayDir, loaded);
		// Infisical, Aiven and self-hosted Valkey each have a Yard of their own.
		expect(joined.map((member) => [member.name, member.providerId])).toEqual([
			["hobo-ci-relay-config", "infisical"],
			["hobo-ci-relay-cache-aiven", "aiven"],
			["hobo-ci-relay-cache-valkey", "valkey"],
		]);
		const production = resolveRelayPlacement(
			loaded ?? relayYard([]),
			"production",
			joined,
		);
		expect(production.inputs).toEqual([]);
		expect([...production.settings.keys()]).toEqual([]);
		expect(production.bindings).toContainEqual(
			expect.objectContaining({
				profile: CONFIG,
				selected: true,
				settings: [],
				inputs: [],
			}),
		);
		expect(production.attachments).toEqual([
			{
				profile: CACHE,
				integration: "upstash/upstash-kv",
				resource: "hobo-ci-cache",
			},
		]);
	});

	it("answers undefined for a project with no Yard source", async () => {
		expect(
			await loadRelayYard(
				fileURLToPath(
					new URL("./fixtures/relay-yards/no-yard/", import.meta.url),
				),
			),
		).toBeUndefined();
	});
});
