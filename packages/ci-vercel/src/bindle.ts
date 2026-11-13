/**
 * The hosted CI relay, declared as a HoBo app.
 *
 * HoBo deploys its own relay (`hobo ci deploy`, see the README), so the relay
 * says what it is in HoBo's own model: an HTTP entry, three private queues
 * (repair ticks, webhook intake, lease steps), a repair schedule, a cache for
 * short-lived job state it may lose, and a config service it only reads
 * (ADR-0179). It keeps no database. Nothing here names a provider
 * (`assertNoBindleProviderSelection` holds); the target is chosen where the
 * deploy is run, never in this file.
 *
 * This file is the declaration, not the deployed code: `api/relay.ts` and the
 * queue entries import `src/entry.ts`, never this module, and the package's
 * build leaves it out (`tsconfig.json`), so what Vercel compiles and bundles
 * for the relay is unchanged. `test/relay-bindle.test.ts` ties every name here
 * to `vercel.json`, to the entry files and to the settings the deployed code
 * reads, so the declaration cannot drift from the thing it describes.
 *
 * Facts the Bindle model cannot carry yet are exported beside it, keyed by
 * the Bindle's resource names: a schedule's cadence (`b.schedule()` takes
 * none), the capability requirement of the cache (`b.kv()` takes none) and
 * what the relay asks of its config service (`b.secret()` takes none).
 */
import { bindle, config, env, secret } from "@hobo/bindles";
import { redisCompatible } from "@hobo/kv-redis-compatible";

/** The Bindle resource names; each is also the name the platform sees. */
export const RELAY_RESOURCES = Object.freeze({
	/** The HTTP entry: `api/relay.ts`, which every route is rewritten to. */
	http: "relay",
	/** The repair queue topic `api/queue.ts` consumes; the schedule publishes to it. */
	queue: "hobo-ci",
	/** Verified webhook deliveries, consumed by `api/intake.ts`. */
	intake: "hobo-ci-intake",
	/** Delayed per-lease lifecycle steps, consumed by `api/lease-steps.ts`. */
	steps: "hobo-ci-lease-steps",
	/** The repair schedule. */
	schedule: "hobo-ci-repair",
	/** Short-lived job state the relay can lose and rebuild. */
	cache: "cache",
	/** The config service: the config document and the relay's secrets, read only. */
	config: "config",
} as const);

/**
 * The repair schedule's cadence: every 15 minutes it puts a repair message on
 * the queue. Whoever runs the schedule (a platform schedule, or an external
 * trigger calling `GET /internal/tick`) runs it at this cadence.
 */
export const RELAY_REPAIR_SCHEDULE = Object.freeze({
	name: RELAY_RESOURCES.schedule,
	cron: "*/15 * * * *",
	topic: RELAY_RESOURCES.queue,
} as const);

/**
 * What the `cache` resource asks of a store: Redis command semantics with
 * per-key expiry, atomic increments and atomic create-if-absent, which is
 * what the relay's lease records, markers, counters and change ring are
 * built on (`EphemeralStatePort`). A REST transport is not required: a store
 * reached over TCP serves the same port.
 */
export const relayCache = redisCompatible.store({
	ttl: true,
	atomicIncrement: true,
	atomicCompareAndSet: true,
});

/**
 * What the relay asks of its config service: one revisioned config document
 * and a set of secrets, read with the deployment's own workload identity (no
 * secret in the deployment to sign in with), never written by the relay, and
 * cached in memory for at most a minute.
 */
export const relayConfigService = Object.freeze({
	access: "read-only",
	holds: Object.freeze(["config-document", "secrets"] as const),
	authentication: "workload-identity",
	refreshSeconds: 60,
} as const);

/**
 * Every setting the relay reads, by name. A value never lives here.
 *
 * `env.*` fields are non-secret configuration: `hobo ci deploy --set` may set
 * exactly these. `secret.*` fields are named only: the config service holds
 * them, and no HoBo deploy path is handed one. The cache's own coordinates
 * are its binding's, not settings here.
 */
export const relayConfig = config({
	HOBO_CI_PUBLIC_URL: env
		.string()
		.docs("The stable HTTPS origin GitHub calls."),
	HOBO_CI_BOOTSTRAP_ACCOUNT_ID: env
		.string()
		.docs("The owner account bootstrap mode creates."),
	HOBO_CI_INVITATION_EXPIRES_AT: env
		.string()
		.docs("When the onboarding invitation stops being accepted."),
	HOBO_CI_GITHUB_APP_ID: env.string().docs("An existing GitHub App's id."),
	HOBO_CI_GITHUB_APP_CLIENT_ID: env
		.string()
		.docs("That App's OAuth client id, for browser installation."),
	HOBO_CI_SANDBOX_ENABLED: env
		.string()
		.docs("`1` admits isolated Sandbox runner jobs."),
	HOBO_CI_SANDBOX_TEAM_ID: env.string().docs("The Sandbox team."),
	HOBO_CI_SANDBOX_PROJECT_ID: env.string().docs("The Sandbox project."),
	HOBO_CI_SANDBOX_ISSUER: env.string().docs("The pinned team token issuer."),
	HOBO_CI_SANDBOX_DOMAINS_JSON: env
		.string()
		.docs("The explicit hostname allowlist for runner traffic."),
	HOBO_CI_SANDBOX_PLAN: env
		.string()
		.docs("The Sandbox plan; `hobby` if unset."),
	HOBO_CI_EVENTS_URL: env
		.string()
		.docs("Where relay failures are also delivered as CloudEvents."),
	HOBO_CI_EVENTS_TENANT: env
		.string()
		.docs("The tenant those events carry; `hobo-ci` if unset."),
	HOBO_CI_CACHE_MONTHLY_COMMANDS: env
		.string()
		.docs(
			"The monthly command allowance of the cache fleet's command-billed default offer; 500000 if unset.",
		),
	HOBO_CI_CACHE_OFFERS_JSON: env
		.string()
		.docs(
			"The cache fleet's declared offers and switch marks (`RelayCacheOffers` in data-models/cache_offers.proto, as JSON): what each cache backend costs and allows and its budget cap. Defaults are the vendor free tiers; the config service's value wins over this one.",
		),
	HOBO_CI_CONFIG_SERVICE: env
		.string()
		.docs(
			"Which config-service binding supplies runtime config and secrets: the binding's kind, or `env` (the default) to read the environment. The config service's own coordinates are its binding's settings, declared at Camp scope, not here.",
		),

	CRON_SECRET: secret
		.string()
		.required()
		.docs(
			"Authenticates the schedule and the queue handoff; 32 bytes or more.",
		),
	HOBO_CI_SESSION_KEY: secret.string().docs("32 random bytes, base64url."),
	HOBO_CI_BOOTSTRAP_TOKEN_SHA256: secret
		.string()
		.docs("The digest of the owner's bootstrap bearer token."),
	HOBO_CI_ONBOARDING_CONTROL_TOKEN: secret
		.string()
		.docs("The onboarding control bearer token."),
	HOBO_CI_CONTROL_TOKENS_JSON: secret.string().docs("Trusted control tokens."),
	HOBO_CI_CONFIG_JSON: secret
		.string()
		.docs("The initial account and provider configuration."),
	HOBO_CI_GITHUB_APP_PRIVATE_KEY: secret
		.string()
		.docs("An existing GitHub App's private key."),
	HOBO_CI_WEBHOOK_SECRET: secret
		.string()
		.docs("An existing GitHub App's webhook secret."),
	HOBO_CI_GITHUB_APP_CLIENT_SECRET: secret
		.string()
		.docs("That App's OAuth client secret."),
	HOBO_CI_SANDBOX_PROXY_TOKEN_KEY: secret
		.string()
		.docs(
			"32 random bytes, base64url: Sandbox proxy session tokens are derived from it. Required with HOBO_CI_SANDBOX_ENABLED.",
		),
});

export default bindle("hobo-ci-relay", (b) => {
	// Lease records, markers, counters and the change ring: reads, writes and
	// deletes, all with a TTL. Nothing in it outlives a job by much.
	const cache = b.kv().allow("get", "set", "delete");
	// Read-only: the relay never writes its configuration or a secret.
	const configService = b.secret().allow("access");
	// The relay enqueues repairs, deliveries and lease steps, and its
	// consumers dequeue them.
	const queue = b.queue().allow("enqueue", "dequeue");
	const intake = b.queue().allow("enqueue", "dequeue");
	const steps = b.queue().allow("enqueue", "dequeue");
	const schedule = b.schedule().dependsOn(queue);
	const http = b.api().dependsOn(cache, configService, queue, intake, steps);
	return {
		[RELAY_RESOURCES.http]: http,
		[RELAY_RESOURCES.queue]: queue,
		[RELAY_RESOURCES.intake]: intake,
		[RELAY_RESOURCES.steps]: steps,
		[RELAY_RESOURCES.schedule]: schedule,
		[RELAY_RESOURCES.cache]: cache,
		[RELAY_RESOURCES.config]: configService,
	};
});
