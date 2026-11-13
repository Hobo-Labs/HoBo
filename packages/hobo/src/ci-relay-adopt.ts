// `hobo ci deploy --adopt` — the token-free relay mode: HoBo delivering its
// own hosted CI relay as a publisher that observes, never deploys.
//
// The relay deploys through Vercel's Git integration: a push to `main` builds
// and promotes it on Vercel, with no deploy token anywhere in CI (ADR-0179
// amendment "Secretless first"). This verb adopts what that integration
// created. Given the commit, it finds Vercel's production deployment of the
// relay's project through GitHub's Deployments API, read with the job's own
// GitHub token (the credentialRef `env://GITHUB_TOKEN`, resolved by the CD
// CredentialResolver for each request and never recorded), and records it as
// relay Freight: the commit, the deployment's id, URL and state when adopted.
// It then promotes that Freight through `@hobo/cd`, preview then production,
// in the shared CD journal `hobo deploy` reads. The conductor's realizer is
// observe-only (`@hobo/provider-vercel`'s Git-integration adoption): it
// converges only when the deployment is READY and is the deployment of the
// Freight's commit, and it never creates, promotes, aliases or cancels a
// deployment.
//
// Verification fails closed and never needs past Vercel Deployment
// Protection (`ci-relay-verify.ts`): the per-deployment URL, which answers 401
// under protection, is never probed. Production probes the relay's production
// origin (`HOBO_CI_RELAY_URL`, else the Yard's `productionOrigin`): `/healthz`
// must name the Freight's commit, which proves the production domain serves
// the adopted deployment, and `/readyz` must answer 200. Preview, which has no
// unprotected URL, is verified by its deployment record: READY, and the
// deployment of the Freight's commit. A production verification that fails is
// recorded by CD as the promotion's end (CD's compensation restores the
// predecessor Set in the journal) and reported by its reason: the origin
// serves another commit, or `/readyz` says the relay is not configured, its
// store refused it, or it is not ready. Nothing is rolled back on Vercel,
// because this verb has no write to roll back with.
//
// HONEST SCOPE: exercised against recorded-shape GitHub answers, fake probes
// and a temporary journal; no live Vercel or GitHub lane runs here.

import { type CommandResult, compileProjectManifest } from "@hobo/cli";
import {
	createBoundedFetchTransport,
	guardTransport,
	type HttpTransport,
} from "@hobo/core";
import {
	type VercelAdoptedDeployment,
	vercelAdoptionVerdict,
	vercelGitDeploymentRecords,
	vercelGitDeploymentStatus,
} from "@hobo/provider-vercel";
import type { DeliveryModule } from "./cd-delivery-module.js";
import { loadDeliveryFile } from "./cd-delivery-module.js";
import { envCredentials } from "./cd-runtime.js";
import {
	deliverRelay,
	RELAY_DELIVERY_FILE,
	RELAY_DELIVERY_REFUSAL,
	type RelayDeliveryOutcome,
	type RelayRealization,
	type RelaySourcePin,
	type RelayTargetName,
} from "./ci-relay-delivery.js";
import {
	adoptedDeploymentSuites,
	adoptedVerificationRecords,
	commitCheckingProbe,
	RELAY_VERIFY_REFUSAL,
	type RelayProbeFindings,
	relayProductionOrigin,
	relayVerifyFailure,
} from "./ci-relay-verify.js";
import {
	loadRelayYard,
	RelayPlacementRefusal,
	resolveRelayPlacement,
} from "./ci-relay-yard.js";
import { validRepository } from "./ci-repository.js";
import { defaultHoboHome } from "./hobo-home.js";
import { isJsonObject, isJsonString, parseJsonValue } from "./json.js";

// The options `hobo ci deploy --adopt` takes; every other deploy option
// configures a deployment this mode never makes.
export const CI_DEPLOY_ADOPT_OPTIONS = ["adopt", "sha", "repo", "ref"] as const;

// public-contract: where the GitHub token the lookup reads comes from.
export const RELAY_ADOPT_CREDENTIAL_REF = "env://GITHUB_TOKEN";

// public-contract: typed refusals of `hobo ci deploy --adopt`.
export const RELAY_ADOPT_REFUSAL = Object.freeze({
	authRequired: "HOBO_CI_ADOPT_AUTH_REQUIRED",
	notFound: "HOBO_CI_ADOPT_NOT_FOUND",
	lookupFailed: "HOBO_CI_ADOPT_LOOKUP_FAILED",
	notAdopted: "HOBO_CI_ADOPT_NOT_ADOPTED",
	/** No production origin to verify at (HOBO_CI_RELAY_URL or the Yard's). */
	originUnset: "HOBO_CI_ADOPT_ORIGIN_UNSET",
	/** Production verification failed for a named reason (ci-relay-verify.ts). */
	...RELAY_VERIFY_REFUSAL,
} as const);

const GITHUB_API = "https://api.github.com";
const COMMIT = /^[0-9a-f]{40}$/u;
// How long to wait for Vercel to report the deployment, then how long each
// promotion may take (READY, then verification).
const FIND_LIMIT_MS = 15 * 60_000;
const WAIT_LIMIT_MS = 20 * 60_000;
const INTERVAL_MS = 10_000;

export interface CiRelayAdoptInput {
	/** The relay's project directory (holds `deploy/yard.ts`). */
	readonly cwd: string;
	readonly values: Readonly<
		Record<string, string | boolean | string[] | undefined>
	>;
	/** Read for GITHUB_TOKEN (through the credentialRef) and the CD store. */
	readonly env: NodeJS.ProcessEnv;
	/** The transport GitHub's Deployments API is read with; injected in tests. */
	readonly github?: HttpTransport;
	/** The transport the verification probes use; injected in tests. */
	readonly probe?: HttpTransport;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly home?: string;
	/** The relay's delivery records; read from `deploy/delivery.ts` when absent. */
	readonly records?: DeliveryModule;
	readonly emitProgress: (message: string) => void;
}

type CommandData = NonNullable<CommandResult["data"]>;

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

type GitHubRead =
	| Readonly<{ ok: true; body: ReturnType<typeof parseJsonValue> }>
	| Readonly<{ ok: false; status: number }>;

/**
 * A reader of the repository's deployment records, and nothing else: the
 * transport is guarded to GitHub's API and this repository's deployments, and
 * every request is a GET.
 */
function githubReader(
	transport: HttpTransport,
	repository: string,
	token: () => Promise<string>,
) {
	const prefix = `/repos/${repository}/deployments`;
	const guarded = guardTransport(transport, {
		allowedHosts: ["api.github.com"],
		allowedPathPrefixes: [prefix],
		maxTimeoutMs: 20_000,
		maxResponseBytes: 1024 * 1024,
	});
	return async (path: string): Promise<GitHubRead> => {
		const response = await guarded({
			method: "GET",
			url: `${GITHUB_API}${prefix}${path}`,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${await token()}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "hobo-ci-relay-adopt",
			},
			timeoutMs: 20_000,
			maxResponseBytes: 1024 * 1024,
		});
		if (response.status !== 200) return { ok: false, status: response.status };
		return { ok: true, body: parseJsonValue(response.body) };
	};
}

export async function runCiRelayAdopt(
	input: CiRelayAdoptInput,
): Promise<CommandResult> {
	const { values, env } = input;
	const text = (key: string) => {
		const value = values[key];
		return isJsonString(value) && value !== "" ? value : undefined;
	};
	const sha = text("sha");
	if (sha === undefined || !COMMIT.test(sha))
		return usage(
			"hobo ci deploy --adopt needs --sha <commit>: the full 40-character commit Vercel's Git integration deployed.",
		);
	let yard: Awaited<ReturnType<typeof loadRelayYard>>;
	let placement: ReturnType<typeof resolveRelayPlacement>;
	try {
		yard = await loadRelayYard(input.cwd);
		if (yard === undefined)
			return usage(
				"No Yard found here. Run hobo ci deploy --adopt in the relay's project directory (deploy/yard.ts), or pass --cwd packages/ci-vercel.",
			);
		if (yard.providerId !== "vercel")
			return {
				ok: false,
				status: "rejected",
				code: "HOBO_CI_DEPLOY_YARD_PROVIDER",
				message: `Yard ${yard.name} places the relay on ${yard.providerId}; --adopt observes Vercel Git-integration deployments only.`,
			};
		placement = resolveRelayPlacement(yard, "production");
	} catch (error) {
		if (error instanceof RelayPlacementRefusal)
			return {
				ok: false,
				status: "rejected",
				code: error.code,
				message: error.message,
			};
		throw error;
	}
	const relayYard = yard;
	const repository =
		text("repo") ?? placement.repository ?? env.GITHUB_REPOSITORY;
	if (repository === undefined || !validRepository(repository))
		return usage(
			"hobo ci deploy --adopt needs --repo <owner/name> (or a Yard whose properties name it): the repository Vercel's Git integration reports to.",
		);
	const project = placement.project;
	if (project === undefined)
		return usage(
			`Yard ${relayYard.name} names no Vercel project; --adopt looks for that project's deployment.`,
		);
	const production = relayProductionOrigin(env, placement.productionOrigin);
	if (production === undefined)
		return {
			ok: false,
			status: "usage",
			code: RELAY_ADOPT_REFUSAL.originUnset,
			message: `--adopt verifies production at the relay's production domain, and none is named: set HOBO_CI_RELAY_URL or the productionOrigin property of Yard ${relayYard.name} (an https origin, e.g. https://<project>.vercel.app). The per-deployment URL is not probed: Deployment Protection answers 401 there.`,
		};
	const declaration = await compileProjectManifest(input.cwd);
	if (declaration === null)
		return usage(
			"The relay's Bindle did not compile to a declaration, so there is nothing to record as Freight.",
		);

	const credentials = envCredentials(env);
	const token = async () => {
		const resolved = await credentials.resolve(
			RELAY_ADOPT_CREDENTIAL_REF,
			"github.deployments:read",
		);
		if (!resolved.token) throw new Error("no token");
		return resolved.token;
	};
	try {
		await token();
	} catch {
		return {
			ok: false,
			status: "authentication-required",
			code: RELAY_ADOPT_REFUSAL.authRequired,
			message: `--adopt reads GitHub's Deployments API with the token ${RELAY_ADOPT_CREDENTIAL_REF} names (in a workflow, GITHUB_TOKEN: \${{ github.token }} with deployments: read). No Vercel token is read.`,
		};
	}
	const read = githubReader(
		input.github ??
			createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
		repository,
		token,
	);
	const now = input.now ?? Date.now;
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

	// Find Vercel's production deployment of the commit: the newest record
	// whose statuses name its URL.
	input.emitProgress(
		`looking for Vercel's production deployment of ${project} at ${repository}@${sha}`,
	);
	let adopted: VercelAdoptedDeployment | undefined;
	const findUntil = now() + FIND_LIMIT_MS;
	let passes = Math.ceil(FIND_LIMIT_MS / INTERVAL_MS) + 1;
	try {
		for (;;) {
			const listing = await read(`?sha=${sha}&per_page=50`);
			if (!listing.ok)
				return lookupFailed(`listing deployments answered ${listing.status}`);
			for (const record of vercelGitDeploymentRecords(listing.body, {
				project,
				target: "production",
				commit: sha,
			})) {
				const statuses = await read(`/${record.id}/statuses?per_page=100`);
				if (!statuses.ok)
					return lookupFailed(
						`reading deployment ${record.id}'s statuses answered ${statuses.status}`,
					);
				const status = vercelGitDeploymentStatus(statuses.body);
				if (status.url === undefined) continue;
				adopted = {
					deploymentId: record.id,
					commit: record.commit,
					url: status.url,
					readyState: status.readyState,
					...(status.inspectorUrl !== undefined
						? { inspectorUrl: status.inspectorUrl }
						: undefined),
				};
				break;
			}
			passes -= 1;
			if (adopted !== undefined || now() >= findUntil || passes <= 0) break;
			await sleep(INTERVAL_MS);
		}
	} catch {
		return lookupFailed("GitHub did not answer");
	}
	if (adopted === undefined)
		return {
			ok: false,
			code: RELAY_ADOPT_REFUSAL.notFound,
			message: `Vercel reported no production deployment of ${project} for ${repository}@${sha} within ${FIND_LIMIT_MS / 60_000} minutes. Nothing was recorded.`,
		};
	const found = adopted;
	input.emitProgress(
		`adopting deployment ${found.deploymentId} (${found.readyState}) at ${found.url}`,
	);

	// The conductor's realization: observe the adopted deployment, never make one.
	const realization: RelayRealization = {
		async deploy(pin) {
			if (pin.adopted === undefined || pin.sha !== found.commit)
				return {
					ok: false,
					code: RELAY_ADOPT_REFUSAL.notAdopted,
					message: `The Freight being realized pins ${pin.sha ?? pin.ref}, not the adopted deployment of ${found.commit}; --adopt never creates a deployment.`,
				};
			return {
				ok: true,
				outputs: {
					deploymentId: pin.adopted.deploymentId,
					url: pin.adopted.url,
					target: "production",
					commit: found.commit,
					realizedBy: "vercel-git-integration (observed)",
					...(pin.adopted.inspectorUrl !== undefined
						? { inspectorUrl: pin.adopted.inspectorUrl }
						: undefined),
				},
			};
		},
		async readyState(deploymentId) {
			try {
				const record = await read(`/${deploymentId}`);
				const statuses = await read(`/${deploymentId}/statuses?per_page=100`);
				if (!record.ok || !statuses.ok) return "UNKNOWN";
				const commit =
					isJsonObject(record.body) && isJsonString(record.body.sha)
						? record.body.sha
						: "";
				return vercelAdoptionVerdict(
					{
						commit,
						readyState: vercelGitDeploymentStatus(statuses.body).readyState,
					},
					{ commit: found.commit },
				).readyState;
			} catch {
				// No answer is not a state: keep observing until the wait ends.
				return "UNKNOWN";
			}
		},
	};

	let records = input.records;
	if (records === undefined) {
		const loaded = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
			cwd: input.cwd,
		});
		if (!loaded.ok)
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_DELIVERY_INVALID",
				message: `${RELAY_DELIVERY_FILE}: ${loaded.code}: ${loaded.message}. ${loaded.remediation}`,
			};
		records = loaded.value;
	}
	const verified = adoptedVerificationRecords(records, production.origin);
	const probe = commitCheckingProbe(
		input.probe ?? createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
		{ origin: production.origin, commit: found.commit },
	);
	const suites = adoptedDeploymentSuites({
		deploymentId: found.deploymentId,
		commit: found.commit,
		readyState: (id) => realization.readyState(id),
	});
	input.emitProgress(
		`verifying preview by deployment ${found.deploymentId}'s record, production at ${production.origin} (${production.from})`,
	);
	const source: RelaySourcePin = {
		repository,
		ref: text("ref") ?? sha,
		sha,
		adopted: {
			deploymentId: found.deploymentId,
			url: found.url,
			readyState: found.readyState,
			...(found.inspectorUrl !== undefined
				? { inspectorUrl: found.inspectorUrl }
				: undefined),
		},
	};
	const deliver = (target: RelayTargetName) =>
		deliverRelay({
			cwd: input.cwd,
			env,
			home: input.home ?? defaultHoboHome(env),
			yard: relayYard,
			declaration,
			target,
			source,
			realization,
			records: verified,
			http: probe.transport,
			suites,
			wait: true,
			limitMs: WAIT_LIMIT_MS,
			intervalMs: INTERVAL_MS,
			...(input.sleep !== undefined ? { sleep: input.sleep } : undefined),
			...(input.now !== undefined ? { now: input.now } : undefined),
			emitProgress: input.emitProgress,
		});
	const data = (
		outcomes: Readonly<Record<string, RelayDeliveryOutcome>>,
	): CommandData => ({
		command: "ci deploy",
		mode: "adopt",
		adopted: { ...found },
		verifiedAt: production.origin,
		delivery: Object.fromEntries(
			Object.entries(outcomes).map(([node, outcome]) => [
				node,
				outcome.ok ? outcome.report : (outcome.report ?? null),
			]),
		),
	});
	const preview = await deliver("preview");
	if (!preview.ok) return failed("preview", preview, found, data({ preview }));
	const promoted = await deliver("production");
	if (!promoted.ok)
		return failed(
			"production",
			promoted,
			found,
			data({ preview, production: promoted }),
			{ origin: production.origin, findings: probe.findings() },
		);
	return {
		code: "HOBO_CI_ADOPTED",
		message: [
			`Adopted Vercel's deployment of ${repository}@${sha}: ${found.url}`,
			`  Freight ${promoted.report.alias} promoted through ${promoted.report.pipeline}: preview ${preview.report.state} (deployment record READY), production ${promoted.report.state} (${production.origin} serves ${sha.slice(0, 12)} and is ready)`,
			`  deployment ${found.deploymentId}${found.inspectorUrl ? ` (${found.inspectorUrl})` : ""}; nothing was deployed or changed on Vercel`,
		].join("\n"),
		data: data({ preview, production: promoted }),
	};
}

function lookupFailed(why: string): CommandResult {
	return {
		ok: false,
		code: RELAY_ADOPT_REFUSAL.lookupFailed,
		message: `GitHub's Deployments API could not be read (${why}). Nothing was recorded; the job needs deployments: read.`,
	};
}

function failed(
	node: RelayTargetName,
	outcome: Extract<RelayDeliveryOutcome, { ok: false }>,
	found: VercelAdoptedDeployment,
	data: CommandData,
	verify?: Readonly<{ origin: string; findings: RelayProbeFindings }>,
): CommandResult {
	const state = outcome.report?.state;
	const why =
		verify !== undefined &&
		outcome.code === RELAY_DELIVERY_REFUSAL.verificationFailed
			? relayVerifyFailure(verify.origin, found.commit, verify.findings)
			: undefined;
	return {
		ok: false,
		code: why?.code ?? outcome.code,
		message: [
			`The adopted deployment ${found.deploymentId} (${found.url}) did not pass ${node}: ${why?.reason ?? outcome.message}`,
			...(why !== undefined ? [`  ${why.remediation}`] : []),
			state !== undefined
				? `  CD recorded the ${node} promotion as ${state}; nothing was rolled back or changed on Vercel.`
				: "  Nothing was changed on Vercel.",
		].join("\n"),
		data:
			why !== undefined
				? {
						...data,
						verification: {
							code: why.code,
							reason: why.reason,
							remediation: why.remediation,
						},
					}
				: data,
	};
}
