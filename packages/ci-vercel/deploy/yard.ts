/**
 * Where the hosted CI relay is placed, and what may be bound to it there: the
 * relay's Yard and its two Camps (ADR-0179 phase 6; ADR-0157).
 *
 * The Bindle (`src/bindle.ts`) says what the relay is and names no provider.
 * This file is the other half: the provider (Vercel), the project and the
 * repository it builds from, and the binding rows, the catalog of offerings
 * that may satisfy each capability the relay needs on that provider. A Camp is
 * one environment of the relay: `production` (what a merge to `main` deploys)
 * and `preview` (the default of a deploy run by hand). A Camp's `require` list
 * names the capability profiles that environment must have bound; for each,
 * `hobo ci deploy` takes the first row in canonical order (ADR-0151: hard gates,
 * then lexicographic order; rows never rank).
 *
 * A row's `properties` carry two things the deploy reads, and nothing secret:
 *
 * - `settings`: non-secret configuration the binding projects onto the
 *   deployment (names and values);
 * - `inputs`: names of non-secret settings the deploy must be given with
 *   `--set`, because their values belong to the owner's accounts (an Infisical
 *   identity id, a project id), not to this repository.
 *
 * and, for an offering attached through the Vercel Marketplace, `integration`
 * and `resource`: what the deploy's provisioning step attaches, idempotently.
 * A Camp's `resolverConfig.properties.settings` adds the settings that differ
 * between environments.
 *
 * Credentials are never here: the integrations write their own connection
 * variables onto the project (`injects` names them), and the config service
 * holds the relay's secrets.
 *
 * Product ids: `vercel.project/v1` is the provider-vercel catalog's. The others
 * (`vercel.function/v1`, `vercel.queues/v1`, `vercel.schedules/v1`,
 * `upstash.redis/v1`, `turso.database/v1`, `aiven.valkey/v1`,
 * `valkey.self-hosted/v1`, `infisical.secrets/v1`) name offerings this Yard
 * declares and `hobo ci deploy` realizes through its git deployment and its
 * provisioning step; no provider package resolves them yet.
 *
 * Like the Bindle, this file is a declaration, not deployed code: nothing in
 * `api/` or `src/` imports it, and the build Vercel runs leaves `deploy/` out.
 * `test/relay-yard.test.ts` ties it to `vercel.json` and to the Bindle.
 */
import { camp } from "@hobo/camps";
import { capability } from "@hobo/core";
import { project } from "@hobo/provider-vercel";
import { yard } from "@hobo/yards";

/** The Vercel project the relay deploys to, and where Vercel builds it from. */
export const RELAY_PLACEMENT = Object.freeze({
	project: "hobo-ci",
	repository: "Hobo-Labs/HoBo",
	rootDirectory: "packages/ci-vercel",
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

/** The relay's folder in the config service (`CONFIG-SERVICE.md`). */
export const RELAY_CONFIG_SERVICE = Object.freeze({
	siteUrl: "https://app.infisical.com",
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

export default yard("hobo-ci-relay", {
	provider: "vercel",
	regions: ["iad1"],
	properties: {
		project: RELAY_PLACEMENT.project,
		repository: RELAY_PLACEMENT.repository,
		rootDirectory: RELAY_PLACEMENT.rootDirectory,
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
		{
			profile: capability.kv.valkey,
			productId: "aiven.valkey/v1",
			connectivityId: "config-service.url/v1",
			properties: { configServiceEntry: "VALKEY_URL" },
		},
		{
			profile: capability.kv.valkey,
			productId: "valkey.self-hosted/v1",
			connectivityId: "config-service.url/v1",
			properties: { configServiceEntry: "VALKEY_URL" },
		},
		// The config service: Infisical, signed in to with the deployment's own
		// Vercel OIDC token. Its coordinates are configuration; the two ids are
		// the owner's and are given at deploy time.
		{
			profile: capability.secretRef.runtimeProjection,
			productId: "infisical.secrets/v1",
			connectivityId: "infisical.oidc-auth/v1",
			properties: {
				settings: {
					HOBO_CI_CONFIG_SERVICE: "infisical",
					INFISICAL_SITE_URL: RELAY_CONFIG_SERVICE.siteUrl,
					INFISICAL_SECRET_PATH: RELAY_CONFIG_SERVICE.secretPath,
				},
				inputs: ["INFISICAL_IDENTITY_ID", "INFISICAL_PROJECT_ID"],
			},
		},
	],
	camps: [
		// A merge to `main` deploys here. The relay reads Infisical's `prod`
		// environment, whose machine identity trusts production tokens only.
		camp("production", {
			envType: "production",
			require: [...COMMON_REQUIREMENTS, capability.secretRef.runtimeProjection],
			resolverConfig: {
				properties: {
					settings: {
						INFISICAL_ENVIRONMENT: RELAY_CONFIG_SERVICE.productionEnvironment,
					},
				},
			},
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
