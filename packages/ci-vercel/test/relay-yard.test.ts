import { readdirSync, readFileSync } from "node:fs";
import { capability } from "@hobo/core";
import { parseYardBindings } from "@hobo/yards";
import { describe, expect, it } from "vitest";
import relayYard, {
	RELAY_CACHE_RESOURCE,
	RELAY_CONFIG_SERVICE,
	RELAY_PLACEMENT,
	RELAY_PLATFORM,
} from "../deploy/yard.js";
import { RELAY_REPAIR_SCHEDULE, RELAY_RESOURCES } from "../src/bindle.js";

// The relay's placement (`deploy/yard.ts`) against the relay itself: the
// platform configuration Vercel reads, the Bindle, and the config service's
// coordinates. A name changed on one side and not the other fails here.

const packageUrl = new URL("../", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, packageUrl), "utf8");

interface PlatformConfig {
	readonly functions: Readonly<
		Record<
			string,
			{
				readonly maxDuration?: number;
				readonly experimentalTriggers?: readonly { readonly topic?: string }[];
			}
		>
	>;
	readonly schedules: Readonly<
		Record<string, { readonly schedule: string; readonly topic: string }>
	>;
}

// SAFETY: vercel.json is this package's own committed platform configuration.
const platform = JSON.parse(text("vercel.json")) as PlatformConfig;

const rowsOf = (profile: string) =>
	relayYard.bindings.filter((row) => row.profile === profile);

const campOf = (name: string) => {
	const found = relayYard.camps.find(
		(entry) => entry.id === `hobo-ci-relay/${name}`,
	);
	if (found === undefined) throw new Error(`no camp ${name}`);
	return found;
};

describe("the relay's Yard", () => {
	it("is the one place the provider is named, and places the relay in its project", () => {
		expect(relayYard.kind).toBe("yard");
		expect(relayYard.name).toBe("hobo-ci-relay");
		expect(relayYard.providerId).toBe("vercel");
		expect(relayYard.regions).toEqual(["iad1"]);
		expect(relayYard.properties).toEqual({
			project: "hobo-ci",
			repository: "Hobo-Labs/HoBo",
			rootDirectory: "packages/ci-vercel",
			// The production domain: public under Deployment Protection, where
			// `hobo ci deploy --adopt` verifies the relay.
			productionOrigin: "https://hobo-ci.vercel.app",
		});
		expect(RELAY_PLACEMENT.rootDirectory).toBe("packages/ci-vercel");
	});

	it("holds its rows as the canonical set yards parses them into", () => {
		const reparsed = parseYardBindings(
			relayYard.bindings.map((row) => ({
				profile: row.profile,
				...(row.productId !== undefined
					? { productId: row.productId }
					: undefined),
				...(row.connectivityId !== undefined
					? { connectivityId: row.connectivityId }
					: undefined),
				properties: row.properties,
			})),
		);
		expect(reparsed).toEqual(relayYard.bindings);
	});

	it("has a production and a preview Camp, each with a row for every profile it requires", () => {
		expect(relayYard.camps.map((entry) => [entry.id, entry.envType])).toEqual([
			["hobo-ci-relay/production", "production"],
			["hobo-ci-relay/preview", "preview"],
		]);
		for (const entry of relayYard.camps) {
			expect(entry.derivedProviderId).toBe("vercel");
			for (const profile of entry.require)
				expect(
					rowsOf(profile).length,
					`${entry.id} ${profile}`,
				).toBeGreaterThan(0);
		}
	});

	it("binds the config service in production only; the store is chosen at deploy, its coordinates are inputs", () => {
		const production = campOf("production");
		const preview = campOf("preview");
		const profile = capability.secretRef.runtimeProjection;
		expect(production.require).toContain(profile);
		expect(preview.require).not.toContain(profile);
		expect(rowsOf(profile)).toEqual([
			expect.objectContaining({
				productId: "infisical.secrets/v1",
				connectivityId: "infisical.oidc-auth/v1",
				properties: {
					capability: "secrets.config-service/v1",
					bindingFile: "deploy/secret-store.binding.json",
					inputs: [
						"INFISICAL_IDENTITY_ID",
						"INFISICAL_PROJECT_ID",
						"INFISICAL_SITE_URL",
					],
					settings: {
						HOBO_CI_CONFIG_SERVICE: "infisical",
						INFISICAL_SECRET_PATH: "/hobo-ci-relay",
					},
				},
			}),
		]);
		expect(production.resolverConfig.properties).toEqual({
			settings: { INFISICAL_ENVIRONMENT: "prod" },
		});
		expect(RELAY_CONFIG_SERVICE.secretPath).toBe("/hobo-ci-relay");
	});

	it("declares every cache backend, and requires the Marketplace Redis one", () => {
		const backends = relayYard.bindings
			.filter((row) =>
				[
					"upstash.redis/v1",
					"turso.database/v1",
					"vercel.blob/v1",
					"aiven.valkey/v1",
					"valkey.self-hosted/v1",
				].includes(row.productId ?? ""),
			)
			.map((row) => [row.profile, row.productId, row.connectivityId]);
		expect(backends).toEqual([
			["bucket.object/v1", "vercel.blob/v1", "vercel.oidc/v1"],
			["data.sqlite/v1", "turso.database/v1", "vercel.marketplace/v1"],
			["kv.redis-compatible/v1", "upstash.redis/v1", "vercel.marketplace/v1"],
			["kv.valkey/v1", "aiven.valkey/v1", "config-service.url/v1"],
			["kv.valkey/v1", "valkey.self-hosted/v1", "config-service.url/v1"],
		]);
		for (const entry of relayYard.camps)
			expect(entry.require).toContain(capability.kv.redisCompatible);
		expect(rowsOf(capability.kv.redisCompatible)[0]?.properties).toMatchObject({
			integration: "upstash/upstash-kv",
			resource: RELAY_CACHE_RESOURCE,
		});
	});
});

describe("the Yard and the platform configuration agree", () => {
	it("names the queue topic, the schedule and the function entries vercel.json declares", () => {
		expect(RELAY_PLATFORM.topic).toBe(RELAY_RESOURCES.queue);
		expect(RELAY_PLATFORM.schedule).toBe(RELAY_REPAIR_SCHEDULE.name);
		expect(RELAY_PLATFORM.cron).toBe(RELAY_REPAIR_SCHEDULE.cron);
		expect(platform.schedules).toEqual({
			[RELAY_PLATFORM.schedule]: {
				schedule: RELAY_PLATFORM.cron,
				topic: RELAY_PLATFORM.topic,
			},
		});
		expect(
			platform.functions[RELAY_PLATFORM.queueEntry]?.experimentalTriggers?.map(
				(trigger) => trigger.topic,
			),
		).toEqual([RELAY_PLATFORM.topic]);
		expect(platform.functions[RELAY_PLATFORM.httpEntry]?.maxDuration).toBe(
			RELAY_PLATFORM.maxDuration,
		);
		expect(rowsOf(capability.service.scheduled)[0]?.properties).toEqual({
			name: RELAY_PLATFORM.schedule,
			cron: RELAY_PLATFORM.cron,
			topic: RELAY_PLATFORM.topic,
		});
	});
});

describe("the Yard is not deployed code", () => {
	it("is imported by no entry file and no source, and is outside the build", () => {
		const importsIt = /from\s+"[^"]*deploy\/yard(?:\.js)?"/u;
		const files = [
			...readdirSync(new URL("api/", packageUrl)).map((name) => `api/${name}`),
			...readdirSync(new URL("src/", packageUrl), { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => `src/${entry.name}`),
		];
		for (const file of files) expect(text(file), file).not.toMatch(importsIt);
		// SAFETY: tsconfig.json is this package's own committed configuration.
		const build = JSON.parse(text("tsconfig.json")) as {
			readonly include?: readonly string[];
			readonly compilerOptions?: { readonly rootDir?: string };
		};
		expect(build.include).toEqual(["src"]);
		expect(build.compilerOptions?.rootDir).toBe("src");
	});
});
