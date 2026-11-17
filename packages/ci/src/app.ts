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
	topic: CI_RELAY_RESOURCES.queue,
} as const);

export const ciRelayBindle = bindle("hobo-ci-relay", (b) => {
	const project = b.web();
	const cache = b.bucket().allow("read", "write", "delete").dependsOn(project);
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

export const ciConfigBindle = bindle("hobo-ci-config", (b) => ({
	config: b.secret().allow("access"),
}));

export const ciCacheBindle = bindle("hobo-ci-cache", (b) => ({
	cache: b.kv().allow("get", "set", "delete"),
}));

export const ciD1CacheBindle = bindle("hobo-ci-d1-cache", (b) => ({
	cache: b.data().allow("read", "write", "query"),
}));

export const ciPostgresCacheBindle = bindle("hobo-ci-postgres-cache", (b) => ({
	cache: b.data().allow("read", "write", "query"),
}));

export const ciUpstashBlobCacheBindle = bindle(
	"hobo-ci-upstash-blob-cache",
	(b) => ({
		cache: b.bucket().allow("read", "write"),
	}),
);

export const ciRunnerBindle = bindle("hobo-ci-runner", (b) => ({
	runner: b.job().allow("submit"),
}));

export const ciGithubAppBindle = bindle("hobo-ci-github-app", (b) => ({
	app: b.api(),
}));
