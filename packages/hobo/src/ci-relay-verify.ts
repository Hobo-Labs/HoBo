// How `hobo ci deploy --adopt` verifies the relay it adopted, fail closed,
// without ever needing past Vercel Deployment Protection.
//
// A deployment Vercel's Git integration builds gets its own URL
// (`hobo-ci-<hash>.vercel.app`), and under Deployment Protection that URL
// answers 401 to anyone without a Vercel session or a bypass secret. The
// production domain does not: Standard Protection leaves production domains
// public. So verification never probes the per-deployment URL:
//
// - production probes the relay's production origin (`HOBO_CI_RELAY_URL`, or
//   the Yard's `productionOrigin`), `/healthz` and `/readyz`, and `/healthz`
//   must name the Freight's commit (`commit`, from `VERCEL_GIT_COMMIT_SHA` in
//   `packages/ci-vercel/src/entry.ts`). That proves the adopted deployment is
//   the one the production domain serves, not merely that some relay is up.
//   A `/healthz` that answers 200 for another commit, or for none, is
//   reported to CD as 412 (the precondition "serves this commit" failed), so
//   the probe is unhealthy and the promotion is not qualified.
// - preview has no unprotected path: every preview URL is behind Deployment
//   Protection, and Vercel offers no per-path exemption for GET. Preview is
//   verified by the deployment record itself: a suite that reads GitHub's
//   Deployments API (the same observe-only read the realizer uses) and passes
//   only when the adopted deployment is READY and is the deployment of the
//   Freight's commit.
//
// What `/readyz` says when it is not 200 is kept as a finding, so a relay that
// is up but not configured is reported as such, with its remediation, instead
// of as an anonymous probe failure.
//
// No credential is read here: the probes are anonymous GETs and the suite
// reads through the caller's GitHub reader (credentialRef `env://GITHUB_TOKEN`).

import { clone, create } from "@bufbuild/protobuf";
import {
	type FreightId,
	type Outcome,
	PipelineRecordSchema,
	ReasonRecordSchema,
	SuiteCheckRecordSchema,
	type VerifyPort,
} from "@hobo/cd";
import type { HttpTransport, TransportResponse } from "@hobo/core";
import type { DeliveryModule } from "./cd-delivery-module.js";
import {
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

// public-contract: the suite that verifies an adopted preview by its deployment record.
export const RELAY_ADOPTED_DEPLOYMENT_SUITE = "vercel.git-deployment.ready";

// public-contract: what `/readyz` reports when the relay did not start
// (`packages/ci-vercel/src/entry.ts` RELAY_START_STATES).
export const RELAY_READYZ_STATES = Object.freeze([
	"not-configured",
	"config-service-denied",
	"config-service-unavailable",
	"start-failed",
] as const);
export type RelayReadyzState = (typeof RELAY_READYZ_STATES)[number];

// The parts of a started relay's `/readyz` report that must be true for it to
// be ready (`StatelessRelayReadiness` in packages/ci-vercel); `workers` is
// ready unless "failing".
const READINESS_PARTS = ["configService", "cache", "executionHost"] as const;

// public-contract: why a relay's production verification failed, by what its
// production origin answered (`relayVerifyFailure`).
export const RELAY_VERIFY_REFUSAL = Object.freeze({
	/** The production origin serves another commit than the Freight's. */
	commitMismatch: "HOBO_CI_DEPLOY_COMMIT_MISMATCH",
	/** `/readyz`: the relay's config service holds no valid configuration. */
	relayNotConfigured: "HOBO_CI_DEPLOY_RELAY_NOT_CONFIGURED",
	/** `/readyz` or `/healthz`: the relay is not ready (the reason says why). */
	relayNotReady: "HOBO_CI_DEPLOY_RELAY_NOT_READY",
} as const);

/** The status a `/healthz` that does not name the Freight's commit reads as. */
export const COMMIT_MISMATCH_STATUS = 412;

const ORIGIN = /^https:\/\/[^/?#\s@]+$/u;

/** An `https://host` origin with no path, or undefined. */
export function relayOrigin(raw: string | undefined): string | undefined {
	const value = raw?.trim().replace(/\/+$/u, "") ?? "";
	return ORIGIN.test(value) && URL.canParse(value)
		? new URL(value).origin
		: undefined;
}

/**
 * The relay's production origin: `HOBO_CI_RELAY_URL` when it names one, else
 * the Yard's `productionOrigin`. Undefined when neither does: verification
 * then has nothing to probe and the caller refuses.
 */
export function relayProductionOrigin(
	env: Readonly<Record<string, string | undefined>>,
	yardOrigin: string | undefined,
): Readonly<{ origin: string; from: string }> | undefined {
	const fromEnv = relayOrigin(env.HOBO_CI_RELAY_URL);
	if (fromEnv !== undefined)
		return { origin: fromEnv, from: "HOBO_CI_RELAY_URL" };
	const fromYard = relayOrigin(yardOrigin);
	if (fromYard !== undefined)
		return { origin: fromYard, from: "the Yard's productionOrigin" };
	return undefined;
}

// public-contract: the verification window `--adopt` gives each node: three
// observations 10 s apart across 30 s. Every attempt must pass, as in the
// delivery records; only the wait is shorter, so preview and production fit
// the adopt budget's reserves (ci-relay-adopt.ts RELAY_ADOPT_BUDGET).
// The progress deadline also bounds the rollout's convergence: production's
// deployment is READY before it is promoted, so it gives up after 90 s;
// preview waits there for Vercel's build, so its deadline lies beyond any
// adopt budget, and the budget, not the rollout, ends a build that is late.
export const RELAY_ADOPT_VERIFICATION = Object.freeze({
	windowMs: 30_000,
	requiredObservations: 3,
	intervalMs: 10_000,
	progressDeadlineMs: 90_000,
	previewProgressDeadlineMs: 25 * 60_000,
});

/**
 * The relay's delivery records as `--adopt` verifies them: production probes
 * aimed at the production origin, preview verified by the deployment-record
 * suite instead of probes (no preview URL answers without protection).
 */
export function adoptedVerificationRecords(
	records: DeliveryModule,
	productionOrigin: string,
): DeliveryModule {
	return {
		...records,
		pipelines: records.pipelines.map((pipeline) => {
			const copy = clone(PipelineRecordSchema, pipeline);
			for (const node of copy.nodes) {
				const spec = node.verification;
				if (spec === undefined) continue;
				// Short windows: the adopted checks are deterministic (a commit
				// match, a 200, a deployment record), so a longer window adds
				// wait, not evidence, and the whole command must fit its budget.
				spec.windowMs = BigInt(RELAY_ADOPT_VERIFICATION.windowMs);
				spec.requiredObservations =
					RELAY_ADOPT_VERIFICATION.requiredObservations;
				spec.progressDeadlineMs = BigInt(
					node.name === "production"
						? RELAY_ADOPT_VERIFICATION.progressDeadlineMs
						: RELAY_ADOPT_VERIFICATION.previewProgressDeadlineMs,
				);
				if (node.name === "production")
					for (const probe of spec.probes) {
						const path = URL.canParse(probe.urlRef)
							? new URL(probe.urlRef).pathname
							: `/${probe.name}`;
						probe.urlRef = `${productionOrigin}${path}`;
						probe.intervalMs = BigInt(RELAY_ADOPT_VERIFICATION.intervalMs);
					}
				else {
					spec.probes = [];
					spec.suites = [
						create(SuiteCheckRecordSchema, {
							suite: RELAY_ADOPTED_DEPLOYMENT_SUITE,
						}),
					];
				}
			}
			return copy;
		}),
	};
}

/** What the production origin answered that verification did not accept. */
export type RelayProbeFindings = Readonly<{
	/** `/healthz` answered 200 for another commit (null: it named none). */
	servedCommit?: string | null;
	/** `/healthz` did not answer 200 (its last status). */
	healthStatus?: number;
	/** `/readyz` said the relay did not start, and why. */
	readyzState?: RelayReadyzState;
	/** `/readyz` said the relay started but is not ready: the parts that are not. */
	notReady?: readonly string[];
	/** `/readyz` did not answer 200 (its last status). */
	readyStatus?: number;
}>;

function bodyOf(response: TransportResponse) {
	try {
		return parseJsonValue(response.body);
	} catch {
		return undefined;
	}
}

/** A probe transport and what it found at the production origin. */
export type RelayCommitProbe = Readonly<{
	transport: HttpTransport;
	findings(): RelayProbeFindings;
}>;

function readyzStateOf(
	value: JsonValue | undefined,
): RelayReadyzState | undefined {
	return RELAY_READYZ_STATES.find((state) => state === value);
}

/**
 * The probe transport for an adopted production: requests to `origin`'s
 * `/healthz` must name `commit`, and `/readyz`'s refusals are kept as
 * findings (the last answer of each wins). Every other request passes
 * through untouched.
 */
export function commitCheckingProbe(
	base: HttpTransport,
	expected: Readonly<{ origin: string; commit: string }>,
): RelayCommitProbe {
	let health: RelayProbeFindings = {};
	let ready: RelayProbeFindings = {};
	const transport: HttpTransport = async (request) => {
		const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
		if (request.method !== "GET" || url?.origin !== expected.origin)
			return base(request);
		const response = await base(request);
		const body = bodyOf(response);
		if (url.pathname === "/healthz") {
			if (response.status !== 200) {
				health = { healthStatus: response.status };
				return response;
			}
			const served =
				isJsonObject(body) && isJsonString(body.commit)
					? body.commit.toLowerCase()
					: null;
			if (served === expected.commit) {
				health = {};
				return response;
			}
			health = { servedCommit: served };
			return { ...response, status: COMMIT_MISMATCH_STATUS };
		}
		if (url.pathname === "/readyz") {
			if (response.status === 200 || !isJsonObject(body)) {
				ready = response.status === 200 ? {} : { readyStatus: response.status };
				return response;
			}
			const state =
				body.started === false ? readyzStateOf(body.state) : undefined;
			ready =
				state !== undefined
					? { readyStatus: response.status, readyzState: state }
					: body.ready === false
						? {
								readyStatus: response.status,
								notReady: [
									...READINESS_PARTS.filter((part) => body[part] === false),
									...(body.workers === "failing" ? ["workers"] : []),
								],
							}
						: { readyStatus: response.status };
		}
		return response;
	};
	return { transport, findings: () => ({ ...health, ...ready }) };
}

/**
 * The suite that verifies an adopted preview: the deployment record reads
 * READY and is the deployment of the Freight's commit (`readyState` returns
 * COMMIT_MISMATCH otherwise). Any other suite name is refused.
 */
export function adoptedDeploymentSuites(
	observe: Readonly<{
		deploymentId: string;
		commit: string;
		readyState(deploymentId: string): Promise<string>;
	}>,
): VerifyPort {
	const refuse = (code: string, message: string, remediation: string) =>
		({
			ok: false,
			reasons: [
				create(ReasonRecordSchema, {
					code,
					message,
					remediation,
					subject: RELAY_ADOPTED_DEPLOYMENT_SUITE,
				}),
			],
		}) satisfies Outcome<never>;
	return {
		async run(input: Readonly<{ suite: string; freightId: FreightId }>) {
			if (input.suite !== RELAY_ADOPTED_DEPLOYMENT_SUITE)
				return refuse(
					"verification-suite-unknown",
					`no suite ${input.suite} is composed for the adopted relay`,
					`Declare ${RELAY_ADOPTED_DEPLOYMENT_SUITE} or a probe.`,
				);
			const state = await observe.readyState(observe.deploymentId);
			if (state === "READY")
				return {
					ok: true,
					value: {
						deploymentId: observe.deploymentId,
						commit: observe.commit,
						readyState: state,
					},
				};
			return refuse(
				"verification-deployment-not-ready",
				`GitHub's record of deployment ${observe.deploymentId} reads ${state}, not READY for commit ${observe.commit}`,
				state === "SUPERSEDED"
					? "A newer push replaced this deployment; its own run adopts the newer one."
					: "Check the deployment's build on Vercel; this run changes nothing there.",
			);
		},
	};
}

export type RelayVerifyFailure = Readonly<{
	code: string;
	reason: string;
	remediation: string;
}>;

/**
 * Why production verification failed, from what the production origin
 * answered: the build it serves first (a wrong build makes every other answer
 * moot), then what `/readyz` said. Undefined when the findings name nothing.
 */
export function relayVerifyFailure(
	origin: string,
	commit: string,
	findings: RelayProbeFindings,
): RelayVerifyFailure | undefined {
	if (findings.servedCommit !== undefined)
		return {
			code: RELAY_VERIFY_REFUSAL.commitMismatch,
			reason:
				findings.servedCommit === null
					? `${origin}/healthz names no commit, so it is not serving the adopted build of ${commit} (a build from before /healthz reported its commit, or another deployment)`
					: `${origin}/healthz names commit ${findings.servedCommit}, not ${commit}: the production domain serves another deployment`,
			remediation:
				"Check which deployment Vercel aliased to the production domain (a newer push, a manual promote or a rollback moves it); a newer push's own run adopts its deployment. If the origin is not this project's production domain, correct HOBO_CI_RELAY_URL or the Yard's productionOrigin.",
		};
	if (findings.readyzState === "not-configured")
		return {
			code: RELAY_VERIFY_REFUSAL.relayNotConfigured,
			reason: `${origin}/readyz says the relay is not configured: its config service holds no valid relay configuration yet`,
			remediation:
				"Put the relay's configuration in the store deploy/secret-store.binding.json names (packages/ci-vercel/CONFIG-SERVICE.md): the GitHub App's credentials go in with hobo ci app create --via-workflow, the owner's entries as its section What the folder holds lists. Re-run this workflow once they are there.",
		};
	if (findings.readyzState === "config-service-denied")
		return {
			code: RELAY_VERIFY_REFUSAL.relayNotReady,
			reason: `${origin}/readyz says the relay's config service refused its identity`,
			remediation:
				"The relay identity named in deploy/secret-store.binding.json must trust this project's Vercel production OIDC tokens (OIDC Auth; packages/ci-vercel/CONFIG-SERVICE.md). hobo ci secret-store verify checks the deploy identity by name.",
		};
	if (findings.readyzState === "config-service-unavailable")
		return {
			code: RELAY_VERIFY_REFUSAL.relayNotReady,
			reason: `${origin}/readyz says the relay's config service did not answer`,
			remediation:
				"Check the store's status; the relay retries on every request, so re-run this workflow once it answers.",
		};
	if (findings.readyzState === "start-failed")
		return {
			code: RELAY_VERIFY_REFUSAL.relayNotReady,
			reason: `${origin}/readyz says the relay did not start`,
			remediation:
				"Read the deployment's runtime log (hobo_ci_relay_init_failed names the stage).",
		};
	if (findings.notReady !== undefined)
		return {
			code: RELAY_VERIFY_REFUSAL.relayNotReady,
			reason: `${origin}/readyz says the relay started but is not ready (${findings.notReady.length > 0 ? findings.notReady.join(", ") : "no part named"})`,
			remediation:
				"cache: the cache binding (deploy/yard.ts) is not reachable; executionHost: the Sandbox execution host is not configured; configService: the store stopped answering. packages/ci-vercel/README.md lists each.",
		};
	if (findings.healthStatus !== undefined)
		return {
			code: RELAY_VERIFY_REFUSAL.relayNotReady,
			reason: `${origin}/healthz answered ${findings.healthStatus}`,
			remediation:
				findings.healthStatus === 401 || findings.healthStatus === 403
					? "The production domain is behind protection: under Standard Deployment Protection it is public, so the origin named is not this project's production domain, or the project protects all deployments. Name the production domain, or set the project's protection to Standard."
					: "The production domain does not serve the relay; check the project's domains on Vercel.",
		};
	return undefined;
}
