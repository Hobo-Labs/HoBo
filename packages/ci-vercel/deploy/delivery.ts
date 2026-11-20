const YARD = "hobo-ci-relay";
const BINDLE = "hobo-ci-relay";
const SOURCE = "hobo-ci-relay";

function originFrom(name: string, fallback: string): string {
	const raw = process.env[name]?.trim() ?? "";
	if (!/^https:\/\/[^/?#\s]+\/?$/u.test(raw)) return fallback;
	return raw.replace(/\/+$/u, "");
}

const ORIGINS = Object.freeze({
	preview: originFrom(
		"HOBO_CI_RELAY_PREVIEW_URL",
		"https://preview.hobo-ci-relay.invalid",
	),
	production: originFrom(
		"HOBO_CI_RELAY_URL",
		"https://production.hobo-ci-relay.invalid",
	),
});

// Three observations a minute apart-ish: a probe every 20 s across a 60 s
// window, every attempt must answer 200, and the verification gives up
// (FAIL, never PASS) after five minutes.
function probe(origin: string, name: "healthz" | "readyz") {
	return {
		name,
		urlRef: `${origin}/${name}`,
		expectStatus: 200,
		intervalMs: "20000",
		minSuccessRatio: 1,
	};
}

function verification(
	origin: string,
	paths: readonly ("healthz" | "readyz")[],
) {
	return {
		windowMs: "60000",
		requiredObservations: 3,
		progressDeadlineMs: "300000",
		failOnNoData: true,
		probes: paths.map((name) => probe(origin, name)),
	};
}

/**
 * The relay's HoBo CI source (the record `hoboSelfDeliverySources` in
 * `@hobo/cd/compose` builds for the relay): passing runs of HoBo's CI, the
 * relay bundle output (a HOBO_CI subscription takes no branch filter). Until CI publishes that output the relay's
 * Freight is pushed by `hobo ci deploy`.
 */
export const sources = [
	{
		schemaVersion: "hobo.cd.source/v1",
		name: SOURCE,
		bindle: BINDLE,
		subscriptions: [
			{
				name: `${SOURCE}-1`,
				kind: "SUBSCRIPTION_KIND_HOBO_CI",
				locator: "Hobo-Labs/HoBo",
				selection: "SELECTION_STRATEGY_NEWEST_BUILD",
				discoveryLimit: 20,
				artifactName: "relay/bundle",
				artifactKind: "ARTIFACT_KIND_FUNCTION_BUNDLE",
			},
		],
		assembly: "ASSEMBLY_RULE_INDEPENDENT",
		automatic: true,
		pollIntervalMs: "300000",
	},
];

export const pipelines = [
	{
		schemaVersion: "hobo.cd.pipeline/v1",
		name: YARD,
		bindle: BINDLE,
		nodes: [
			{
				name: "preview",
				campIds: [`${YARD}/${YARD}/preview`],
				fromSources: [SOURCE, "origin:manifest"],
				strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
				verification: verification(ORIGINS.preview, ["healthz"]),
			},
			{
				name: "production",
				campIds: [`${YARD}/${YARD}/production`],
				fromNodes: ["preview"],
				strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
				verification: verification(ORIGINS.production, ["healthz", "readyz"]),
			},
		],
	},
];
