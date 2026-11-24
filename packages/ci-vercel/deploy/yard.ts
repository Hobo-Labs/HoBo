import { camp } from "@hobo/camps";
import { capability } from "@hobo/core";
import { junction } from "@hobo/junctions";
import { project } from "@hobo/provider-vercel";
import { yard } from "@hobo/yards";

/** The Vercel project the relay deploys to, and where Vercel builds it from. */
export const RELAY_PLACEMENT = Object.freeze({
	project: "hobo-ci",
	repository: "Hobo-Labs/HoBo",
	rootDirectory: "packages/ci-vercel",
	/**
	 * The production domain Vercel aliases each production deployment to.
	 * Standard Deployment Protection leaves it public (a per-deployment URL
	 * answers 401), so `hobo ci deploy --adopt` verifies here: `/healthz` must
	 * name the adopted commit, and `/readyz` must answer 200.
	 * `HOBO_CI_RELAY_URL` overrides it.
	 */
	productionOrigin: "https://hobo-ci.vercel.app",
} as const);

/** The queue topic, the repair schedule and the function entries, by name. */
export const RELAY_PLATFORM = Object.freeze({
	topic: "hobo-ci",
	schedule: "hobo-ci-repair",
	cron: "*/15 * * * *",
	httpEntry: "api/relay.ts",
	queueEntry: "api/queue.ts",
	maxDuration: 300,
} as const);

/** The Marketplace resource the cache binding attaches, one per team. */
export const RELAY_CACHE_RESOURCE = "hobo-ci-cache";

export const RELAY_CONFIG_SERVICE = Object.freeze({
	capability: "secrets.config-service/v1",
	bundledBindingFile: "deploy/secret-store.binding.json",
	secretPath: "/hobo-ci-relay",
	productionEnvironment: "prod",
} as const);

const PROJECT = project({ rootDirectory: RELAY_PLACEMENT.rootDirectory });

/** The profile a Vercel project satisfies (provider-vercel's slot factory). */
export const RELAY_PROJECT_PROFILE = PROJECT.profile;

// What both environments must have bound.
const COMMON_REQUIREMENTS = [
	capability.api.http,
	capability.service.queueConsumer,
	capability.service.scheduled,
	capability.queue.atLeastOnce,
	capability.queue.delay,
	capability.kv.redisCompatible,
	PROJECT.profile,
];

/**
 * The relay's own Yard: what Vercel runs. Its products are Vercel's, plus the
 * caches Vercel provisions and runs on our behalf through its Marketplace
 * (`vercel.marketplace/v1`). Nothing here is external: a service another
 * vendor runs has a Yard of its own below, joined by `junction`.
 */
const RELAY_YARD = yard("hobo-ci-relay", {
	provider: "vercel",
	regions: ["iad1"],
	properties: {
		project: RELAY_PLACEMENT.project,
		repository: RELAY_PLACEMENT.repository,
		rootDirectory: RELAY_PLACEMENT.rootDirectory,
		productionOrigin: RELAY_PLACEMENT.productionOrigin,
	},
	bindings: [
		// The project and the functions a git deployment of it produces.
		{
			profile: PROJECT.profile,
			...(PROJECT.productId !== undefined
				? { productId: PROJECT.productId }
				: undefined),
			properties: { rootDirectory: RELAY_PLACEMENT.rootDirectory },
		},
		{
			profile: capability.api.http,
			productId: "vercel.function/v1",
			properties: {
				entry: RELAY_PLATFORM.httpEntry,
				maxDuration: RELAY_PLATFORM.maxDuration,
			},
		},
		{
			profile: capability.service.queueConsumer,
			productId: "vercel.function/v1",
			properties: {
				entry: RELAY_PLATFORM.queueEntry,
				topic: RELAY_PLATFORM.topic,
			},
		},
		// Vercel Queues: intake, per-lease steps (delayed messages) and repairs.
		{
			profile: capability.queue.atLeastOnce,
			productId: "vercel.queues/v1",
			properties: { topics: [RELAY_PLATFORM.topic] },
		},
		{
			profile: capability.queue.delay,
			productId: "vercel.queues/v1",
			properties: { topics: [RELAY_PLATFORM.topic] },
		},
		{
			profile: capability.service.scheduled,
			productId: "vercel.schedules/v1",
			properties: {
				name: RELAY_PLATFORM.schedule,
				cron: RELAY_PLATFORM.cron,
				topic: RELAY_PLATFORM.topic,
			},
		},
		// The ephemeral-state cache, by backend. Each attaches differently; the
		// relay finds whichever is attached by the variables it injects.
		{
			profile: capability.kv.redisCompatible,
			productId: "upstash.redis/v1",
			connectivityId: "vercel.marketplace/v1",
			properties: {
				integration: "upstash/upstash-kv",
				resource: RELAY_CACHE_RESOURCE,
				injects: ["KV_REST_API_TOKEN", "KV_REST_API_URL"],
			},
		},
		{
			profile: capability.data.sqlite,
			productId: "turso.database/v1",
			connectivityId: "vercel.marketplace/v1",
			properties: {
				integration: "tursocloud",
				resource: RELAY_CACHE_RESOURCE,
				injects: ["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"],
			},
		},
		{
			profile: capability.bucket.object,
			productId: "vercel.blob/v1",
			connectivityId: "vercel.oidc/v1",
			properties: { store: RELAY_CACHE_RESOURCE, access: "private" },
		},
	],
	camps: [
		camp("production", {
			envType: "production",
			require: [...COMMON_REQUIREMENTS, capability.secretRef.runtimeProjection],
		}),
		// A deploy run by hand lands here unless it asks for production. No
		// config-service binding: the relay identity trusts production tokens
		// only, so a preview reads its environment (`HOBO_CI_CONFIG_SERVICE`
		// keeps its default, `env`).
		camp("preview", {
			envType: "preview",
			require: COMMON_REQUIREMENTS,
		}),
	],
});

export default RELAY_YARD;

export const relayConfigYard = yard("hobo-ci-relay-config", {
	provider: "infisical",
	bindings: [
		{
			profile: capability.secretRef.runtimeProjection,
			productId: "infisical.secrets/v1",
			connectivityId: "infisical.oidc-auth/v1",
			properties: {
				capability: RELAY_CONFIG_SERVICE.capability,
				bundledBindingFile: RELAY_CONFIG_SERVICE.bundledBindingFile,
			},
		},
	],
});

/** The Aiven-run Valkey cache offering, in Aiven's Yard. */
export const relayAivenCacheYard = yard("hobo-ci-relay-cache-aiven", {
	provider: "aiven",
	bindings: [
		{
			profile: capability.kv.valkey,
			productId: "aiven.valkey/v1",
			connectivityId: "config-service.url/v1",
			properties: { configServiceEntry: "VALKEY_URL" },
		},
	],
});

/** A self-hosted Valkey cache offering, in its own Yard. */
export const relaySelfHostedCacheYard = yard("hobo-ci-relay-cache-valkey", {
	provider: "valkey",
	bindings: [
		{
			profile: capability.kv.valkey,
			productId: "valkey.self-hosted/v1",
			connectivityId: "config-service.url/v1",
			properties: { configServiceEntry: "VALKEY_URL" },
		},
	],
});

/**
 * The relay's junction: the Vercel Yard joined to every Yard whose service it
 * uses. `hobo ci deploy` places the relay in the Vercel Yard's Camp and
 * satisfies a Camp requirement from a joined Yard's rows when the Vercel Yard
 * has none (the config service, for production).
 */
export const relayJunction = junction("hobo-ci-relay", {
	yards: [
		RELAY_YARD,
		relayConfigYard,
		relayAivenCacheYard,
		relaySelfHostedCacheYard,
	],
});
