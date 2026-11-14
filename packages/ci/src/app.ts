/** Provider-neutral SDK declarations for the hosted HoBo CI application. */
import { bindle } from "@hobo/bindles";

export const CI_RELAY_RESOURCES = Object.freeze({
	project: "project",
	http: "relay",
	queue: "hobo-ci",
	intake: "hobo-ci-intake",
	steps: "hobo-ci-lease-steps",
	schedule: "hobo-ci-repair",
	cache: "cache",
	config: "config",
} as const);

export const CI_RELAY_REPAIR_SCHEDULE = Object.freeze({
	name: CI_RELAY_RESOURCES.schedule,
	cron: "*/15 * * * *",
	function: "api/repair",
	entry: "api/repair.ts",
} as const);

/** The relay owns its execution, queues, schedule and native Blob storage.
 * Its remote configuration service is a separate Bindle and Yard, connected
 * through a Junction rather than masquerading as a local resource. */
export const ciRelayBindle = bindle("hobo-ci-relay", (b) => {
	const project = b.web();
	const cache = b.bucket().allow("read", "write", "delete").dependsOn(project);
	// Queue and schedule bindings are verified against the exact Git deployment.
	// Cache connection is projected before that deployment is created.
	const http = b.api().dependsOn(project, cache);
	const queue = b.queue().allow("enqueue", "dequeue").dependsOn(http);
	const intake = b.queue().allow("enqueue", "dequeue").dependsOn(http);
	const steps = b.queue().allow("enqueue", "dequeue").dependsOn(http);
	const schedule = b.schedule().dependsOn(http, queue, intake, steps);
	return {
		[CI_RELAY_RESOURCES.project]: project,
		[CI_RELAY_RESOURCES.http]: http,
		[CI_RELAY_RESOURCES.queue]: queue,
		[CI_RELAY_RESOURCES.intake]: intake,
		[CI_RELAY_RESOURCES.steps]: steps,
		[CI_RELAY_RESOURCES.schedule]: schedule,
		[CI_RELAY_RESOURCES.cache]: cache,
	};
});

/** The provider holding CI configuration is independently placed. */
export const ciConfigBindle = bindle("hobo-ci-config", (b) => ({
	config: b.secret().allow("access"),
}));

/** A cache on another provider is placed in its own Yard. The relay uses it
 * through a Junction, not as a product owned by the relay's provider. */
export const ciCacheBindle = bindle("hobo-ci-cache", (b) => ({
	cache: b.kv().allow("get", "set", "delete"),
}));

/** D1 is a provider-owned database; the Junction projects its cache adapter. */
export const ciD1CacheBindle = bindle("hobo-ci-d1-cache", (b) => ({
	cache: b.data().allow("read", "write", "query"),
}));

/** PostgreSQL remains in its provider Yard and crosses a Junction. */
export const ciPostgresCacheBindle = bindle("hobo-ci-postgres-cache", (b) => ({
	cache: b.data().allow("read", "write", "query"),
}));

/** Upstash owns the private bucket; the cache adapter crosses a Junction. */
export const ciUpstashBlobCacheBindle = bindle(
	"hobo-ci-upstash-blob-cache",
	(b) => ({
		cache: b.bucket().allow("read", "write"),
	}),
);

/** A separate execution target for the configured CI job runner. */
export const ciRunnerBindle = bindle("hobo-ci-runner", (b) => ({
	runner: b.job().allow("submit"),
}));

/** GitHub supplies a verified App/JIT API; an isolated host runs the jobs. */
export const ciGithubAppBindle = bindle("hobo-ci-github-app", (b) => ({
	app: b.api(),
}));
