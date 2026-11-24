import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type { CommandModule, CommandResult, YardRuntime } from "@hobo/cli";
import {
	createInProcessExecutor,
	createRegistryFromProviders,
	type Executor,
	type IacOutputs,
	type IacProgram,
	type IacProvider,
	type PlannerRegistry,
} from "@hobo/cloud";
import type { TrustedVault } from "@hobo/core";
import {
	CD_DEPLOY_ENVIRONMENT,
	CD_PLACEMENT_YARDS,
	CD_STORE_COORDINATES_HANDOFF,
	cdConfigYard,
	cdJournalYard,
} from "@hobo/hobo-cd";
import { BUNDLED_SECRET_STORE_BINDING_FILE } from "@hobo/secret-store-claim";
import type { Yard } from "@hobo/yards";

import { relayYardRegistryProvider } from "./ci-relay-delivery.js";
import {
	loadRelayJoinedYards,
	loadRelayYard,
	RelayPlacementRefusal,
	resolveRelayPlacement,
} from "./ci-relay-yard.js";
import { gitHead } from "./ci-up-relay.js";
import {
	createVercelClient,
	isProjectNotFound,
	type VercelClient,
	type VercelFetch,
} from "./vercel-client.js";
import {
	createVercelDeployProvider,
	type VercelDeployProviderOptions,
} from "./vercel-deploy-provider.js";
import {
	checkoutHeadOf,
	promoteStagedBuild,
	repositoryRoot,
	stageVercelBuild,
	type VercelBuildRunner,
	vercelBuildEnvironment,
	vercelBuildRunnerFrom,
} from "./vercel-prebuilt.js";

// `hobo cd plan|up` place the CD project with this machine's providers plus
// the Yards `hobo cd up` makes for it (`@hobo/hobo-cd` `placement.ts`): the
// journal's fleet and the owner's config service. Neither is registered here,
// so a plan without them rejects `cd-journal` and `cd-config`.

/** `base` with each Yard's offerings added; the base's live view is kept. */
export function withYardOfferings(
	base: PlannerRegistry,
	yards: readonly Yard[],
): PlannerRegistry {
	const extra = createRegistryFromProviders(
		yards.map((yard) => relayYardRegistryProvider(yard)),
	);
	return {
		// A getter: a base that refreshes changes its hash.
		get catalogHash() {
			return createHash("sha256")
				.update(base.catalogHash)
				.update("\0")
				.update(extra.catalogHash)
				.digest("hex");
		},
		definitions: () => [...base.definitions(), ...extra.definitions()],
		providers: () => [...new Set([...base.providers(), ...extra.providers()])],
		...(base.refresh !== undefined
			? { refresh: () => base.refresh?.() ?? Promise.resolve() }
			: undefined),
		...(base.held !== undefined
			? { held: () => base.held?.() ?? [] }
			: undefined),
	};
}

/** The runtime `hobo cd plan|up` place the CD project with. */
export function cdPlacementRuntime<R extends YardRuntime>(runtime: R): R {
	return {
		...runtime,
		registry: withYardOfferings(runtime.registry, CD_PLACEMENT_YARDS),
	};
}

/** The specific resources the prepare step makes on its reserved Yards. */
const PREPARED_RESOURCES: ReadonlyMap<string, string> = new Map([
	[`yard:${cdJournalYard.name}`, "cd-journal"],
	[`yard:${cdConfigYard.name}`, "cd-config"],
]);

/**
 * `next`, except for a resource placed on a Yard `prepare` makes (the
 * journal's fleet, the owner's config service): `prepare` created it in this
 * run, before the plan, and refused the run if it could not. Applying it
 * records that; nothing is deployed for it. Destroying it does nothing: the
 * journal holds CD's history and the store is the owner's, so `hobo cd down`
 * never drops either.
 */
export function routePreparedPlacements(next: IacProvider): IacProvider {
	const prepared = (program: IacProgram) => {
		const resource = PREPARED_RESOURCES.get(program.provider);
		if (resource === undefined) return false;
		if (program.resourceId !== resource)
			throw new Error(
				`${program.resourceId} was not prepared for ${program.provider}`,
			);
		return true;
	};
	const outputs = (program: IacProgram) => ({
		provider: program.provider,
		realizedBy: "prepare",
	});
	return {
		id: next.id,
		preview: async (program) =>
			prepared(program)
				? {
						summary: `${program.resourceId} on ${program.provider}: made by hobo cd up's prepare step`,
						changes: 0,
					}
				: next.preview(program),
		apply: async (program) =>
			prepared(program) ? outputs(program) : next.apply(program),
		destroy: async (program) => {
			if (!prepared(program)) await next.destroy(program);
		},
		refresh: async (program) =>
			prepared(program)
				? { drift: false, observed: outputs(program) }
				: next.refresh(program),
	};
}

/** Keep prepared resources out of the generic teardown provider. */
export function retainPreparedOnDown(next: Executor): Executor {
	const unexpected = async () => {
		throw new Error("resource was not prepared by hobo cd up");
	};
	const retained = createInProcessExecutor({
		iac: routePreparedPlacements({
			id: "cd-prepared-retention",
			preview: unexpected,
			apply: unexpected,
			destroy: unexpected,
			refresh: unexpected,
		}),
	});
	return {
		run: (program, credential, options) =>
			program.action === "destroy" && PREPARED_RESOURCES.has(program.provider)
				? retained.run(program, credential, options)
				: next.run(program, credential, options),
	};
}

export function cdVercelDirFor(projectDir: string): string | undefined {
	for (const candidate of [
		projectDir,
		path.join(projectDir, "..", "cd-vercel"),
	])
		if (existsSync(path.join(candidate, "deploy", "yard.ts")))
			return path.resolve(candidate);
	return undefined;
}

export async function loadCdYards(
	dir: string,
): Promise<readonly Yard[] | undefined> {
	const yard = await loadRelayYard(dir);
	if (yard === undefined) return undefined;
	return [yard, ...(await loadRelayJoinedYards(dir, yard, "cdJunction"))];
}

export function yardsRegistry(yards: readonly Yard[]): PlannerRegistry {
	return createRegistryFromProviders(
		yards.map((yard) => relayYardRegistryProvider(yard)),
	);
}

function projectOf(input: Parameters<CommandModule["run"]>[0]): string {
	return input.context.projectDir ?? input.flags.cwd ?? input.context.cwd;
}

export function createCdPlanCommand<R extends YardRuntime>(
	runtime: R,
	planWith: (runtime: R) => CommandModule,
): CommandModule {
	return {
		implemented: true,
		async run(input) {
			const dir = cdVercelDirFor(projectOf(input));
			const yards = dir === undefined ? undefined : await loadCdYards(dir);
			if (yards === undefined)
				return planWith(cdPlacementRuntime(runtime)).run(input);
			input.emitProgress(
				`placing on CD's Yards: ${yards.map((yard) => yard.name).join(", ")}`,
			);
			return planWith({ ...runtime, registry: yardsRegistry(yards) }).run(
				input,
			);
		},
	};
}

function refusedUp(
	code: string,
	message: string,
	remediation: readonly string[],
): CommandResult {
	return {
		ok: false,
		status: "rejected",
		code,
		message,
		remediation,
		data: { command: "cd" },
	};
}

// public-contract: typed refusals of hobo cd up's prebuilt delivery.
export const CD_UP_REFUSAL = Object.freeze({
	storeSessionRequired: "HOBO_CD_UP_STORE_SESSION_REQUIRED",
	noCheckout: "HOBO_CD_UP_NO_CHECKOUT",
} as const);

export type CdPrebuiltDelivery = Readonly<{
	token: string;
	teamId?: string;
	project: string;
	rootDirectory?: string;
	repoRoot: string;
	sha: string;
	bundle: Readonly<{ file: string; text: string }>;
	emit: (message: string) => void;
}>;

export type CdPrebuiltDeps = Readonly<{
	env?: Readonly<Record<string, string | undefined>>;
	fetch?: VercelFetch;
	runVercelBuild?: (projectId: string) => VercelBuildRunner;
	checkoutHead?: (repoRoot: string) => Promise<string>;
}>;

export class CdPrebuiltRefusal extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CdPrebuiltRefusal";
		this.code = code;
	}
}

async function readOrCreateProject(
	client: VercelClient,
	delivery: CdPrebuiltDelivery,
): Promise<Readonly<{ id: string; created: boolean }>> {
	try {
		return {
			id: (await client.readProject(delivery.project)).id,
			created: false,
		};
	} catch (error) {
		if (!(error instanceof Error) || !isProjectNotFound(error)) throw error;
	}
	const made = await client.createProject(
		delivery.project,
		delivery.rootDirectory === undefined
			? {}
			: { rootDirectory: delivery.rootDirectory },
	);
	return {
		id: made.created
			? made.id
			: (await client.readProject(delivery.project)).id,
		created: made.created,
	};
}

export function createCdPrebuiltProvider(
	delivery: CdPrebuiltDelivery,
	deps: CdPrebuiltDeps = {},
): IacProvider {
	const teamId =
		delivery.teamId !== undefined && delivery.teamId !== ""
			? delivery.teamId
			: undefined;
	const client = createVercelClient({
		token: delivery.token,
		...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
		...(teamId !== undefined ? { teamId } : undefined),
	});
	const env = deps.env ?? {};
	const runnerFor =
		deps.runVercelBuild ??
		((projectId: string) =>
			vercelBuildRunnerFrom(
				env.HOBO_VERCEL_CLI || "vercel",
				vercelBuildEnvironment(env, {
					VERCEL_TOKEN: delivery.token,
					VERCEL_PROJECT_ID: projectId,
					...(teamId !== undefined ? { VERCEL_ORG_ID: teamId } : undefined),
				}),
			));
	const freightId = `hobo-cd-${delivery.sha.toLowerCase()}`;
	const delivered = new Map<string, IacOutputs>();
	const summary = `vercel prebuilt ${delivery.project} target=production sha=${delivery.sha} (store binding bundled into the build, no project variables)`;
	return {
		id: `vercel-prebuilt:${delivery.project}`,
		preview: async () => ({ summary, changes: 1 }),
		async apply(program) {
			const cached = delivered.get(program.deploymentId);
			if (cached !== undefined) return cached;
			const project = await readOrCreateProject(client, delivery);
			const staged = await stageVercelBuild({
				run: runnerFor(project.id),
				client,
				project: project.id,
				cwd: delivery.repoRoot,
				head: await (deps.checkoutHead ?? checkoutHeadOf)(delivery.repoRoot),
				freightId,
				sha: delivery.sha,
				emit: delivery.emit,
				bundle: delivery.bundle,
			});
			if (!staged.ok) throw new CdPrebuiltRefusal(staged.code, staged.message);
			const promoted = await promoteStagedBuild({
				client,
				project: project.id,
				freightId,
				sha: delivery.sha,
				emit: delivery.emit,
			});
			if (!promoted.ok)
				throw new CdPrebuiltRefusal(promoted.code, promoted.message);
			const outputs: IacOutputs = {
				url: promoted.deployment.url,
				deploymentId: promoted.deployment.id,
				provider: "vercel",
				target: "production",
				build: "prebuilt",
				projectCreated: String(project.created),
				scope: teamId ?? "token-default",
				gitSha: delivery.sha,
				...(promoted.previousDeploymentId !== undefined
					? { promotedFrom: promoted.previousDeploymentId }
					: undefined),
			};
			delivered.set(program.deploymentId, outputs);
			return outputs;
		},
		async destroy(program) {
			const receipt = delivered.get(program.deploymentId);
			const deploymentId = receipt?.deploymentId;
			if (deploymentId === undefined || deploymentId === "")
				throw new Error(
					"a prebuilt CD deployment is removed only with the receipt of the run that made it",
				);
			await client.deleteDeployment(deploymentId);
			delivered.delete(program.deploymentId);
		},
		async refresh(program) {
			const receipt = delivered.get(program.deploymentId);
			const deploymentId = receipt?.deploymentId;
			if (deploymentId === undefined || deploymentId === "")
				return { drift: true, observed: { contentVerified: "false" } };
			const observed = await client.getDeployment(deploymentId);
			return {
				drift: true,
				observed: {
					exists: String(observed !== undefined),
					contentVerified: "false",
				},
			};
		},
	};
}

export type CdVercelUpDeps<R extends YardRuntime> = Readonly<{
	credentials: TrustedVault;
	runtime: R;
	upWith: (runtime: R) => CommandModule;
	resolveGitHead?: (
		dir: string,
	) => Promise<{ ref: string; sha: string } | undefined>;
	vercelDeployProvider?: (
		options: Omit<VercelDeployProviderOptions, "fetch">,
	) => IacProvider;
	prebuiltProvider?: (delivery: CdPrebuiltDelivery) => IacProvider;
	prebuilt?: CdPrebuiltDeps;
}>;

function convergeCdUpWithoutBundledVercelYard<R extends YardRuntime>(
	deps: CdVercelUpDeps<R>,
	input: Parameters<CommandModule["run"]>[0],
): Promise<CommandResult> {
	const teamId = deps.credentials.reveal("VERCEL_TEAM_ID");
	return deps
		.upWith({
			...cdPlacementRuntime(deps.runtime),
			executor: createInProcessExecutor({
				iac: routePreparedPlacements(
					(deps.vercelDeployProvider ?? createVercelDeployProvider)({
						token: deps.credentials.reveal("VERCEL_TOKEN") ?? "",
						...(teamId !== undefined ? { teamId } : undefined),
						projectName: "hobo-cd",
					}),
				),
			}),
		})
		.run(input);
}

export function createCdVercelUpCommand<R extends YardRuntime>(
	deps: CdVercelUpDeps<R>,
): CommandModule {
	const token = () => deps.credentials.reveal("VERCEL_TOKEN") ?? "";
	const team = () => deps.credentials.reveal("VERCEL_TEAM_ID");
	return {
		implemented: true,
		async run(input) {
			const dir = cdVercelDirFor(projectOf(input));
			const yards = dir === undefined ? undefined : await loadCdYards(dir);
			if (dir === undefined || yards === undefined)
				return convergeCdUpWithoutBundledVercelYard(deps, input);
			const head = await (deps.resolveGitHead ?? gitHead)(dir);
			if (head === undefined)
				return refusedUp(
					"HOBO_CD_UP_NO_BRANCH",
					"hobo cd up deploys CD from the current branch, and this checkout is not on one.",
					["Check out the branch to deploy, pushed to GitHub, and run again."],
				);
			const [cdYard, ...joined] = yards;
			if (cdYard === undefined)
				return refusedUp("HOBO_CD_UP_NO_YARD", "CD declares no Yard.", []);
			let placement: ReturnType<typeof resolveRelayPlacement>;
			try {
				placement = resolveRelayPlacement(
					cdYard,
					CD_DEPLOY_ENVIRONMENT,
					joined,
				);
			} catch (error) {
				if (error instanceof RelayPlacementRefusal)
					return refusedUp(error.code, error.message, []);
				throw error;
			}
			const [org, repo] = (placement.repository ?? "").split("/");
			if (
				placement.project === undefined ||
				org === undefined ||
				repo === undefined ||
				org === "" ||
				repo === ""
			)
				return refusedUp(
					"HOBO_CD_UP_NO_PROJECT",
					`CD's Yard ${placement.yard} names no Vercel project and repository to deploy.`,
					[
						"Declare project and repository in the Yard's properties (packages/cd-vercel/deploy/yard.ts).",
					],
				);
			const coordinates = deps.credentials.reveal(CD_STORE_COORDINATES_HANDOFF);
			if (coordinates === undefined)
				return refusedUp(
					CD_UP_REFUSAL.storeSessionRequired,
					"HoBo.CD reads its journal with store coordinates that live only in the owner's secret store, and this run read none: hobo cd up bundles them into the build it makes and never sets them as Vercel variables.",
					[
						"Run hobo cd up --hand-off with the owner's store session (HoBo MCP's choose_secret_store) on an Infisical store the run can sign in to.",
					],
				);
			const repoRoot = repositoryRoot(dir);
			if (repoRoot === undefined)
				return refusedUp(
					CD_UP_REFUSAL.noCheckout,
					`${dir} is not inside a git checkout: hobo cd up builds the checkout of the commit it deploys.`,
					["Run hobo cd up from a git checkout of the commit to deploy."],
				);
			const teamId = team();
			const provider = (
				deps.prebuiltProvider ??
				((delivery: CdPrebuiltDelivery) =>
					createCdPrebuiltProvider(delivery, deps.prebuilt))
			)({
				token: token(),
				...(teamId !== undefined ? { teamId } : undefined),
				project: placement.project,
				...(placement.rootDirectory !== undefined
					? { rootDirectory: placement.rootDirectory }
					: undefined),
				repoRoot,
				sha: head.sha,
				bundle: {
					file: path.join(dir, BUNDLED_SECRET_STORE_BINDING_FILE),
					text: coordinates,
				},
				emit: input.emitProgress,
			});
			input.emitProgress(
				`building ${head.ref}@${head.sha.slice(0, 12)} with HoBo.CD's store binding bundled in, then promoting it to CD's ${CD_DEPLOY_ENVIRONMENT} on Vercel (project ${placement.project})`,
			);
			return deps
				.upWith({
					...deps.runtime,
					registry: yardsRegistry(yards),
					executor: createInProcessExecutor({
						iac: routePreparedPlacements(provider),
					}),
				})
				.run(input);
		},
	};
}
