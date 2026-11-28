import path from "node:path";

import { clone, create } from "@bufbuild/protobuf";
import {
	PipelineRecordSchema,
	ReasonRecordSchema,
	SuiteCheckRecordSchema,
	type VerifyPort,
} from "@hobo/cd";
import { HOBO_CI_COMPONENTS } from "@hobo/cd/compose";
import { type CommandResult, compileProjectManifest } from "@hobo/cli";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
import { lazyEgressFetch } from "@hobo/hobo-ci";
import { BUNDLED_SECRET_STORE_BINDING_FILE } from "@hobo/secret-store-claim";
import { type DeliveryModule, loadDeliveryFile } from "./cd-delivery-module.js";
import { relayAdoptDeadline } from "./ci-relay-adopt.js";
import {
	deliverRelay,
	RELAY_DELIVERY_FILE,
	type RelayRealization,
	type RelayTargetName,
} from "./ci-relay-delivery.js";
import { relayCommitSnapshot } from "./ci-relay-snapshot.js";
import { readRelaySource } from "./ci-relay-source.js";
import {
	loadRelayJoinedYards,
	loadRelayYard,
	resolveRelayPlacement,
} from "./ci-relay-yard.js";
import {
	parseOwnerStoreBinding,
	readSecretStoreBindingText,
	SecretStoreBindingRefusal,
	type SecretStoreBindingStore,
} from "./ci-secret-store.js";
import {
	createGithubReleaseJournal,
	findPendingGithubRelease,
} from "./github-release-journal.js";
import { defaultHoboHome } from "./hobo-home.js";
import { isJsonString } from "./json.js";
import { loadOwnerDeployCredentials } from "./owner-deploy-credentials.js";
import {
	promoteVerifiedRelease,
	type ReleaseOutcome,
} from "./release-controller.js";
import {
	createReleaseJournal,
	findPendingLocalRelease,
} from "./release-journal.js";
import { createVercelClient, type VercelFetch } from "./vercel-client.js";
import {
	createVercelReleaseProvider,
	resolveVercelProject,
} from "./vercel-release-provider.js";
import { deployVercelSource } from "./vercel-source-upload.js";

export const CI_DEPLOY_MANAGED_OPTIONS = [
	"managed",
	"sha",
	"ref",
	"deadline",
	"budget",
	"dry-run",
	"target",
] as const;
const PREVIEW_SUITE = "vercel.source-preview.ready";
const PRODUCTION_SUITE = "vercel.source-production.release";

export function managedRelayRecords(records: DeliveryModule): DeliveryModule {
	const seen = new Set<string>();
	const pipelines = records.pipelines.map((pipeline) => {
		const copy = clone(PipelineRecordSchema, pipeline);
		if (copy.name !== HOBO_CI_COMPONENTS.relay.pipeline) return copy;
		for (const node of copy.nodes) {
			if (node.name !== "preview" && node.name !== "production") continue;
			if (node.verification === undefined)
				throw new Error("A relay pipeline node has no verification.");
			if (seen.has(node.name))
				throw new Error("The relay pipeline has duplicate delivery nodes.");
			seen.add(node.name);
			const spec = node.verification;
			spec.windowMs = 1000n;
			spec.requiredObservations = 1;
			spec.progressDeadlineMs = 20n * 60n * 1000n;
			spec.probes = [];
			spec.suites = [
				create(SuiteCheckRecordSchema, {
					suite: node.name === "preview" ? PREVIEW_SUITE : PRODUCTION_SUITE,
				}),
			];
		}
		return copy;
	});
	if (!seen.has("preview") || !seen.has("production"))
		throw new Error(
			"The relay pipeline needs preview and production verification.",
		);
	return { ...records, pipelines };
}

export interface CiRelayManagedInput {
	readonly cwd: string;
	readonly values: Readonly<
		Record<string, string | boolean | string[] | undefined>
	>;
	readonly env: NodeJS.ProcessEnv;
	readonly credentials?: TrustedVault;
	readonly bindingStore?: SecretStoreBindingStore;
	readonly ownerSession?: TrustedVault;
	readonly ownerSettings?: Parameters<
		typeof loadOwnerDeployCredentials
	>[0]["ownerSettings"];
	readonly openOwnerStore?: Parameters<
		typeof loadOwnerDeployCredentials
	>[0]["open"];
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly home?: string;

	readonly source?: typeof readRelaySource;
	readonly snapshot?: typeof relayCommitSnapshot;
	readonly feedWaitMs?: number;
	readonly emitProgress: (message: string) => void;
}

function refused(code: string, message: string): CommandResult {
	return { ok: false, status: "rejected", code, message };
}

export async function runCiRelayManaged(
	input: CiRelayManagedInput,
): Promise<CommandResult> {
	const text = (name: string) => {
		const value = input.values[name];
		return isJsonString(value) ? value : undefined;
	};
	const sha = text("sha");
	const ref = text("ref");
	const requestedTarget = text("target") ?? "production";
	if (requestedTarget !== "preview" && requestedTarget !== "production")
		return refused(
			"HOBO_CI_MANAGED_TARGET_INVALID",
			"Managed delivery target must be preview or production.",
		);
	if (
		sha === undefined ||
		!/^[0-9a-f]{40}$/u.test(sha) ||
		ref === undefined ||
		!/^[A-Za-z0-9_./-]+$/u.test(ref) ||
		ref.includes("..")
	)
		return refused(
			"HOBO_CI_MANAGED_SOURCE_INVALID",
			"Managed delivery needs a full commit SHA and a valid ref.",
		);
	const now = input.now ?? Date.now;
	const limit = relayAdoptDeadline(now(), {
		deadline: text("deadline"),
		budget: text("budget"),
	});
	if (!limit.ok || limit.at - now() < 180_000)
		return refused(
			"HOBO_CI_MANAGED_BUDGET",
			"Managed delivery needs at least three minutes before its deadline.",
		);
	let source: ReturnType<typeof readRelaySource>;
	let snapshot: Awaited<ReturnType<typeof relayCommitSnapshot>>;
	try {
		source = (input.source ?? readRelaySource)(input.cwd, sha);
		snapshot = await (input.snapshot ?? relayCommitSnapshot)(input.cwd, sha);
	} catch {
		return refused(
			"HOBO_CI_MANAGED_SOURCE_UNAVAILABLE",
			"The pinned relay commit and its workspace inputs could not be read.",
		);
	}
	const vault = createTrustedVault();
	try {
		const yard = await loadRelayYard(snapshot.dir);
		const declaration = await compileProjectManifest(snapshot.dir);
		const loaded = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
			cwd: snapshot.dir,
		});
		let bindingText: string | undefined;
		try {
			bindingText = await readSecretStoreBindingText(input.bindingStore);
		} catch (error) {
			if (error instanceof SecretStoreBindingRefusal)
				return refused(error.code, error.message);
			throw error;
		}
		const binding =
			bindingText === undefined
				? undefined
				: parseOwnerStoreBinding(bindingText);
		if (yard?.providerId !== "vercel" || !declaration || !loaded.ok || !binding)
			return refused(
				"HOBO_CI_MANAGED_CONFIG_INVALID",
				"The pinned relay needs a Vercel Yard, delivery records, Bindle and secret-store binding.",
			);
		const joined = await loadRelayJoinedYards(snapshot.dir, yard);
		const preview = resolveRelayPlacement(yard, "preview", joined);
		const production = resolveRelayPlacement(yard, "production", joined);
		const { project, repository, rootDirectory, productionOrigin } = production;
		const teamId = binding.vercelTeamId;
		if (
			!project ||
			!repository ||
			rootDirectory !== "packages/ci-vercel" ||
			!productionOrigin ||
			!teamId ||
			preview.project !== project ||
			preview.repository !== repository
		)
			return refused(
				"HOBO_CI_MANAGED_PLACEMENT_INVALID",
				"The relay Yard must identify the same Vercel project, team, repository and workspace for both Camps.",
			);
		const records = managedRelayRecords(loaded.value);
		if (input.values["dry-run"] === true)
			return {
				status: "dry-run",
				code: "HOBO_CI_MANAGED_PLANNED",
				message: `Would deliver ${repository}@${sha} to ${project} through HoBo CD using ${source.files.length} committed files${requestedTarget === "production" ? ", then verify production" : " as a preview"}. No credential was read and nothing was deployed.`,
			};
		for (const name of ["VERCEL_TOKEN", "VERCEL_TEAM_ID"]) {
			const value = input.credentials?.reveal(name);
			if (value) vault.put(name, value);
		}
		await loadOwnerDeployCredentials({
			cwd: input.cwd,
			env: input.env,
			credentials: vault,
			...(input.ownerSession
				? { ownerSession: input.ownerSession }
				: undefined),
			...(input.ownerSettings
				? { ownerSettings: input.ownerSettings }
				: undefined),
			...(input.openOwnerStore ? { open: input.openOwnerStore } : undefined),
			...(input.fetch ? { fetch: input.fetch } : undefined),
		});
		const token = vault.reveal("VERCEL_TOKEN");
		if (!token)
			return refused(
				"HOBO_CI_DEPLOY_AUTH_REQUIRED",
				"HoBo CD needs access to the Vercel connection in the owner's selected store session.",
			);
		const savedTeam = vault.reveal("VERCEL_TEAM_ID");
		if (savedTeam && savedTeam !== teamId)
			return refused(
				"HOBO_CI_DEPLOY_TEAM_MISMATCH",
				"The selected Vercel connection does not belong to the relay's team.",
			);
		const githubActions =
			input.env.GITHUB_ACTIONS === "true" && requestedTarget === "production";
		const githubToken = input.env.GITHUB_TOKEN;
		if (
			githubActions &&
			(!githubToken ||
				input.env.GITHUB_REPOSITORY !== repository ||
				input.env.GITHUB_SHA !== sha)
		)
			return refused(
				"HOBO_CI_MANAGED_JOURNAL_REQUIRED",
				"GitHub Actions delivery needs its scoped deployment token and matching repository and commit for durable recovery.",
			);
		const http = input.fetch ?? lazyEgressFetch(input.env);
		const boundedFetch: typeof fetch = (url, init) => {
			const remaining = Math.min(20_000, limit.at - now());
			if (remaining <= 0) throw new Error("The delivery deadline expired.");
			const timeout = AbortSignal.timeout(remaining);
			return http(url, {
				...init,
				redirect: "error",
				signal: init?.signal
					? AbortSignal.any([init.signal, timeout])
					: timeout,
			});
		};
		const vercelFetch: VercelFetch = (url, init) => boundedFetch(url, init);
		let projectId: string;
		try {
			projectId = await resolveVercelProject({
				token,
				teamId,
				name: project,
				fetch: boundedFetch,
			});
		} catch {
			return refused(
				"HOBO_CI_MANAGED_PROJECT_UNAVAILABLE",
				"The selected Vercel project could not be verified for this team.",
			);
		}
		const home = input.home ?? defaultHoboHome(input.env);
		let recovery: Awaited<ReturnType<typeof findPendingGithubRelease>>;
		if (requestedTarget === "production") {
			try {
				recovery =
					githubActions && githubToken
						? await findPendingGithubRelease({
								repository,
								token: githubToken,
								commit: sha,
								deadline: limit.at,
								fetch: boundedFetch,
							})
						: await findPendingLocalRelease(home, projectId);
			} catch {
				return refused(
					"HOBO_CI_MANAGED_JOURNAL_UNAVAILABLE",
					"The durable release checkpoint could not be read safely.",
				);
			}
		}
		const client = createVercelClient({
			token,
			teamId,
			fetch: vercelFetch,
		});
		const provider = createVercelReleaseProvider({
			token,
			teamId,
			projectId,
			productionOrigin,
			fetch: boundedFetch,
			deadline: limit.at,
			...(input.now ? { now: input.now } : undefined),
		});
		const ids: Partial<Record<RelayTargetName, string>> = {};
		let release: ReleaseOutcome | undefined;
		if (recovery) {
			try {
				const current = await provider.current();
				if (
					current !== recovery.deploymentId &&
					current !== recovery.previousDeploymentId
				)
					return refused(
						"HOBO_CI_MANAGED_CONCURRENT_RELEASE",
						"Production changed while an earlier release was unfinished; inspect it before retrying.",
					);
				const journal =
					githubActions && githubToken
						? createGithubReleaseJournal({
								repository,
								token: githubToken,
								commit: recovery.commit,
								deadline: limit.at,
								deploymentId: recovery.deploymentId,
								fetch: boundedFetch,
							})
						: createReleaseJournal(home, projectId, recovery.deploymentId);
				const recovered = await promoteVerifiedRelease({
					provider,
					journal,
					deploymentId: recovery.deploymentId,
					commit: recovery.commit,
					deadline: Math.min(limit.at - 60_000, now() + 120_000),
					rollbackDeadline: limit.at,
					...(input.now ? { now: input.now } : undefined),
					...(input.sleep ? { sleep: input.sleep } : undefined),
				});
				if (!recovered.ok && (recovery.commit === sha || !recovered.rolledBack))
					return refused(
						"HOBO_CI_MANAGED_RECOVERY_FAILED",
						`The interrupted release could not be verified: ${recovered.code}; rollback ${recovered.rolledBack ? "completed" : "not confirmed"}.`,
					);
				if (recovery.commit === sha) release = recovered;
				else recovery = undefined;
			} catch {
				return refused(
					"HOBO_CI_MANAGED_RECOVERY_FAILED",
					"The interrupted release could not be checked safely.",
				);
			}
		}
		const makeRealization = (target: RelayTargetName): RelayRealization => ({
			async deploy(pin) {
				if (pin.sha !== sha || pin.repository !== repository)
					return {
						ok: false,
						code: "HOBO_CI_MANAGED_PIN_MISMATCH",
						message: "The CD Freight does not match the pinned source.",
					};
				try {
					if (target === "production" && recovery) {
						ids.production = recovery.deploymentId;
						return {
							ok: true,
							outputs: {
								deploymentId: recovery.deploymentId,
								url: "",
								target,
								commit: sha,
							},
						};
					}
					if (target === "production") {
						if (production.inputs.length > 0)
							return {
								ok: false,
								code: "HOBO_CI_MANAGED_SETTINGS_MISSING",
								message:
									"A production binding asks for store coordinates, which never become Vercel variables.",
							};
						await client.setProjectEnv({
							project: projectId,
							target,
							variables: Object.fromEntries(production.settings),
						});
					}
					const deployment = await deployVercelSource({
						token,
						teamId,
						project: projectId,
						name: project,
						repository,
						ref,
						rootDirectory,
						source:
							target === "production" && bindingText !== undefined
								? {
										...source,
										files: [
											...source.files,
											{
												path: path.posix.join(
													rootDirectory,
													BUNDLED_SECRET_STORE_BINDING_FILE,
												),
												mode: "100644",
												content: Buffer.from(bindingText),
											},
										],
									}
								: source,
						target,
						buildSettings: {
							installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
							buildCommand:
								"cd ../.. && pnpm exec turbo run build --filter=@hobo/ci-vercel... --concurrency=1",
						},
						deadline: limit.at - 60_000,
						fetch: boundedFetch,
					});
					ids[target] = deployment.id;
					return {
						ok: true,
						outputs: {
							deploymentId: deployment.id,
							url: deployment.url,
							target,
							commit: sha,
						},
					};
				} catch {
					return {
						ok: false,
						code: "HOBO_CI_MANAGED_DEPLOY_FAILED",
						message: `Vercel could not create the ${target} source deployment.`,
					};
				}
			},
			async readyState(id) {
				try {
					return await provider.sourceState(id, sha, target);
				} catch {
					return "UNKNOWN";
				}
			},
		});
		const suites: VerifyPort = {
			async run(request) {
				let ok = false;
				if (request.suite === PREVIEW_SUITE && ids.preview)
					ok =
						(await provider.sourceState(ids.preview, sha, "preview")) ===
						"READY";
				if (request.suite === PRODUCTION_SUITE && ids.production) {
					const journal =
						githubActions && githubToken
							? createGithubReleaseJournal({
									repository,
									token: githubToken,
									commit: sha,
									deadline: limit.at,
									deploymentId: ids.production,
									fetch: boundedFetch,
								})
							: createReleaseJournal(home, projectId, ids.production);
					release ??= await promoteVerifiedRelease({
						provider,
						journal,
						deploymentId: ids.production,
						commit: sha,
						deadline: limit.at - 60_000,
						rollbackDeadline: limit.at,
						...(input.now ? { now: input.now } : undefined),
						...(input.sleep ? { sleep: input.sleep } : undefined),
					});
					ok = release.ok;
				}
				return ok
					? { ok: true, value: { commit: sha } }
					: {
							ok: false,
							reasons: [
								create(ReasonRecordSchema, {
									code:
										release && !release.ok
											? release.code
											: "verification-deployment-not-ready",
									message:
										release && !release.ok
											? `Production release failed: ${release.code}; rollback ${release.rolledBack ? "completed" : "not confirmed"}.`
											: "The pinned source deployment is not READY.",
									remediation:
										"Inspect the deployment and resolve the reported failure before retrying.",
									subject: request.suite,
								}),
							],
						};
			},
		};
		const sourcePin = { repository, ref, sha, rootDirectory };
		const remaining = () => Math.max(0, limit.at - now() - 60_000);
		const base = {
			cwd: snapshot.dir,
			env: input.env,
			home,
			yard,
			declaration,
			source: sourcePin,
			records,
			suites,
			wait: true,
			intervalMs: 10_000,
			...(input.feedWaitMs !== undefined
				? { feedWaitMs: input.feedWaitMs }
				: undefined),
			...(input.now ? { now: input.now } : undefined),
			...(input.sleep ? { sleep: input.sleep } : undefined),
			emitProgress: input.emitProgress,
		};
		const previewResult = await deliverRelay({
			...base,
			target: "preview",
			realization: makeRealization("preview"),
			limitMs: Math.floor(remaining() * 0.45),
		});
		if (!previewResult.ok)
			return refused(previewResult.code, previewResult.message);
		if (requestedTarget === "preview")
			return {
				code: "HOBO_CI_MANAGED_PREVIEW",
				message: `HoBo CD delivered ${repository}@${sha} to a Vercel preview; its deployment record is READY.`,
				data: {
					command: "ci deploy",
					deploymentId: ids.preview ?? "",
					commit: sha,
				},
			};
		const productionResult = await deliverRelay({
			...base,
			target: "production",
			realization: makeRealization("production"),
			limitMs: remaining(),
		});
		if (!productionResult.ok)
			return refused(productionResult.code, productionResult.message);
		if (!release?.ok)
			return refused(
				"HOBO_CI_MANAGED_RELEASE_UNCONFIRMED",
				"CD did not confirm the production release and public health checks.",
			);
		return {
			code: "HOBO_CI_MANAGED_DEPLOYED",
			message: `HoBo CD delivered ${repository}@${sha} to ${productionOrigin}; production health verified.`,
			data: {
				command: "ci deploy",
				deploymentId: ids.production ?? "",
				commit: sha,
				productionOrigin,
				previousDeploymentId: release.previousDeploymentId,
			},
		};
	} catch {
		return refused(
			"HOBO_CI_MANAGED_FAILED",
			"Managed delivery could not complete; inspect the CD journal and deployment status.",
		);
	} finally {
		vault.clear();
		await snapshot.close().catch(() => {});
	}
}
