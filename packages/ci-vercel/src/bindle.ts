/**
 * The hosted CI relay, declared as a HoBo app.
 *
 * HoBo deploys its own relay (`hobo ci deploy`, see the README), so the relay
 * says what it is in HoBo's own model: an HTTP entry, a private queue, a repair
 * schedule, PostgreSQL state and a secret store. Nothing here names a provider
 * (`assertNoBindleProviderSelection` holds); the target is chosen where the
 * deploy is run, never in this file.
 *
 * This file is the declaration, not the deployed code: `api/relay.ts` and
 * `api/queue.ts` import `src/entry.ts`, never this module, and the package's
 * build leaves it out (`tsconfig.json`), so what Vercel compiles and bundles
 * for the relay is unchanged. `test/relay-bindle.test.ts` ties every name here
 * to `vercel.json`, to the entry files and to the settings the source reads, so
 * the declaration cannot drift from the thing it describes.
 *
 * Two facts the Bindle model cannot carry yet are exported beside it, keyed by
 * the Bindle's resource names: a schedule's cadence (`b.schedule()` takes
 * none) and the capability requirement of a data resource (`b.data()` takes
 * none).
 */
import { bindle, config, env, secret } from "@hobo/bindles";
import { postgres } from "@hobo/data-postgres";

/** The Bindle resource names; each is also the name the platform sees. */
export const RELAY_RESOURCES = Object.freeze({
	/** The HTTP entry: `api/relay.ts`, which every route is rewritten to. */
	http: "relay",
	/** The private queue topic `api/queue.ts` consumes. */
	queue: "hobo-ci",
	/** The repair schedule. */
	schedule: "hobo-ci-repair",
	/** The relay's durable state. */
	state: "state",
	/** Where the relay's secrets are held. */
	secrets: "secrets",
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
 * What the `state` resource asks of a PostgreSQL product: the wire protocol
 * over TLS, binary JSON (the event store and inbox use `jsonb`), and a pooled
 * endpoint. The relay also needs a direct endpoint to the same database for
 * session advisory locks, which the requirement vocabulary has no key for; the
 * operator supplies it (`DATABASE_URL_UNPOOLED` below).
 */
export const relayState = postgres.database({
	jsonb: true,
	pooling: true,
	connectivity: ["tls-tcp"],
});

/**
 * Every setting the relay reads, by name. A value never lives here.
 *
 * `env.*` fields are non-secret configuration: `hobo ci deploy --set` may set
 * exactly these. `secret.*` fields are named only: the operator, the storage
 * integration or the relay's own vault holds them, and no HoBo deploy path is
 * handed one.
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
	HOBO_CI_DATABASE_ENV_PREFIX: env
		.string()
		.docs("The prefix a second connected Postgres store was given."),
	HOBO_CI_DATABASE_CA_CERT: env
		.string()
		.docs("A PEM root certificate for a database whose chain is private."),
	HOBO_CI_EVENTS_URL: env
		.string()
		.docs("Where relay failures are also delivered as CloudEvents."),
	HOBO_CI_EVENTS_TENANT: env
		.string()
		.docs("The tenant those events carry; `hobo-ci` if unset."),

	DATABASE_URL: secret
		.string()
		.required()
		.docs("The pooled connection to `state`, from its binding."),
	DATABASE_URL_UNPOOLED: secret
		.string()
		.required()
		.docs("A direct connection to the same database and role."),
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
});

export default bindle("hobo-ci-relay", (b) => {
	// Reads and writes the event store, inbox and projections, and owns the
	// schema (`admin`: it migrates itself).
	const state = b.data().allow("read", "write", "query", "admin");
	// Read-only: the relay never writes a secret through this store.
	const secrets = b.secret().allow("access");
	// The relay enqueues wakeups and repairs, and its consumer dequeues them.
	const queue = b.queue().allow("enqueue", "dequeue");
	const schedule = b.schedule().dependsOn(queue);
	const http = b.api().dependsOn(state, secrets, queue);
	return {
		[RELAY_RESOURCES.http]: http,
		[RELAY_RESOURCES.queue]: queue,
		[RELAY_RESOURCES.schedule]: schedule,
		[RELAY_RESOURCES.state]: state,
		[RELAY_RESOURCES.secrets]: secrets,
	};
});
