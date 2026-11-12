/**
 * How the hosted CI relay is delivered: its Freight source and its pipeline,
 * as delivery-as-code records (plan 0024; `packages/hobo/CD.md`). The relay is
 * HoBo delivering itself: `hobo ci deploy` records the relay build as Freight,
 * promotes it through this pipeline and the CD gate, and a conductor
 * reconciler realizes it on Vercel from the Yard beside this file
 * (`yard.ts`). `hobo deploy pipeline apply --file
 * packages/ci-vercel/deploy/delivery.ts` applies the same records by hand.
 *
 * The pipeline has two nodes, one per Camp of the Yard:
 *
 * - `preview` takes Freight from the relay's HoBo CI source or pushed by
 *   `hobo ci deploy` (`origin:manifest`);
 * - `production` takes only Freight that `preview` qualified: a production
 *   deploy of a commit that has not passed preview verification is refused.
 *
 * Each node verifies with HTTP probes of the relay's `/healthz` and `/readyz`
 * and fails closed on no data: a probe that cannot reach the relay is an
 * unhealthy attempt, and a node whose origin is not configured probes a
 * reserved `.invalid` host (RFC 6761) that never answers, so nothing is
 * qualified there until the owner names the origin.
 *
 * The origins are the module's only inputs, read once when it loads:
 * `HOBO_CI_RELAY_URL` (production, the same repository variable the smoke
 * check read) and `HOBO_CI_RELAY_PREVIEW_URL` (a preview origin that answers
 * without Deployment Protection, e.g. a protection-bypassed branch alias).
 * Neither is a secret. Like `yard.ts`, this file is a declaration: the build
 * Vercel runs leaves `deploy/` out.
 *
 * The module exports only the record arrays the delivery loader accepts
 * (`sources`, `pipelines`), in protobuf JSON form.
 */

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
function verification(origin: string) {
	return {
		windowMs: "60000",
		requiredObservations: 3,
		progressDeadlineMs: "300000",
		failOnNoData: true,
		probes: [
			{
				name: "healthz",
				urlRef: `${origin}/healthz`,
				expectStatus: 200,
				intervalMs: "20000",
				minSuccessRatio: 1,
			},
			{
				name: "readyz",
				urlRef: `${origin}/readyz`,
				expectStatus: 200,
				intervalMs: "20000",
				minSuccessRatio: 1,
			},
		],
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
				verification: verification(ORIGINS.preview),
			},
			{
				name: "production",
				campIds: [`${YARD}/${YARD}/production`],
				fromNodes: ["preview"],
				strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
				verification: verification(ORIGINS.production),
			},
		],
	},
];
