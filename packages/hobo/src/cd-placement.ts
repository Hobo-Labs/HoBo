import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type { CommandModule, CommandResult, YardRuntime } from "@hobo/cli";
import {
	createInProcessExecutor,
	createRegistryFromProviders,
	type IacProgram,
	type IacProvider,
	type PlannerRegistry,
} from "@hobo/cloud";
import type { TrustedVault } from "@hobo/core";
import { CD_DEPLOY_SETTINGS, CD_PLACEMENT_YARDS } from "@hobo/hobo-cd";
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
	createVercelDeployProvider,
	type VercelDeployProviderOptions,
} from "./vercel-deploy-provider.js";

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

/** The providers the plan names for resources placed on those Yards. */
const PREPARED_PROVIDERS: ReadonlySet<string> = new Set(
	CD_PLACEMENT_YARDS.map((yard) => `yard:${yard.name}`),
);

/**
 * `next`, except for a resource placed on a Yard `prepare` makes (the
 * journal's fleet, the owner's config service): `prepare` created it in this
 * run, before the plan, and refused the run if it could not. Applying it
 * records that; nothing is deployed for it. Destroying it does nothing: the
 * journal holds CD's history and the store is the owner's, so `hobo cd down`
 * never drops either.
 */
export function routePreparedPlacements(next: IacProvider): IacProvider {
	const prepared = (program: IacProgram) =>
		PREPARED_PROVIDERS.has(program.provider);
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

/**
 * The directory of CD's Vercel deployable (`packages/cd-vercel`) for a CD
 * project: itself when it declares a Yard, else the bundled one beside it.
 */
export function cdVercelDirFor(projectDir: string): string | undefined {
	for (const candidate of [
		projectDir,
		path.join(projectDir, "..", "cd-vercel"),
	])
		if (existsSync(path.join(candidate, "deploy", "yard.ts")))
			return path.resolve(candidate);
	return undefined;
}

/** CD's Vercel Yard and the Yards its junction (`cdJunction`) joins to it. */
export async function loadCdYards(
	dir: string,
): Promise<readonly Yard[] | undefined> {
	const yard = await loadRelayYard(dir);
	if (yard === undefined) return undefined;
	return [yard, ...(await loadRelayJoinedYards(dir, yard, "cdJunction"))];
}

/** A registry of exactly these Yards' offerings. */
export function yardsRegistry(yards: readonly Yard[]): PlannerRegistry {
	return createRegistryFromProviders(
		yards.map((yard) => relayYardRegistryProvider(yard)),
	);
}

function projectOf(input: Parameters<CommandModule["run"]>[0]): string {
	return input.context.projectDir ?? input.flags.cwd ?? input.context.cwd;
}

/**
 * `hobo cd plan`: place CD on its own Yards (CD on Vercel, joined to the
 * journal and config Yards), whatever this machine has registered, as `hobo
 * ci plan` places the relay. A CD project with no Vercel deployable beside it
 * plans with this machine's providers plus the journal and config Yards.
 */
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

export type CdVercelUpDeps<R extends YardRuntime> = Readonly<{
	/** The run's trusted vault: the Vercel token prepare put there. */
	credentials: TrustedVault;
	runtime: R;
	/** Converge with a runtime (the broker-aware `up`). */
	upWith: (runtime: R) => CommandModule;
	/** Test seam: the checkout's branch and commit. */
	head?: (dir: string) => Promise<{ ref: string; sha: string } | undefined>;
	/** Test seam: the Vercel deploy provider. */
	deployProvider?: (
		options: Omit<VercelDeployProviderOptions, "fetch">,
	) => IacProvider;
}>;

/**
 * `hobo cd up` once prepare has connected Vercel: place CD on its own Yards
 * and converge, with an executor that delivers CD's Vercel deployable
 * (`packages/cd-vercel`) as a git deployment of the current commit to CD's
 * preview, as `hobo ci up` delivers the relay. One Vercel deployment realizes
 * the API and the tick; the journal and config are recorded as prepare made
 * them. Production stays an explicit promotion.
 */
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
			if (dir === undefined || yards === undefined) {
				// No Vercel deployable beside this CD project: converge as before.
				const teamId = team();
				return deps
					.upWith({
						...cdPlacementRuntime(deps.runtime),
						executor: createInProcessExecutor({
							iac: routePreparedPlacements(
								(deps.deployProvider ?? createVercelDeployProvider)({
									token: token(),
									...(teamId !== undefined ? { teamId } : undefined),
									projectName: "hobo-cd",
								}),
							),
						}),
					})
					.run(input);
			}
			const head = await (deps.head ?? gitHead)(dir);
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
				placement = resolveRelayPlacement(cdYard, "preview", joined);
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
			const teamId = team();
			// The store coordinates prepare put in the vault with the CD workload
			// identity (ids only): the deployment signs in with them.
			const configuration = Object.fromEntries(
				Object.entries(CD_DEPLOY_SETTINGS).flatMap(([setting, held]) => {
					const value = deps.credentials.reveal(held);
					return value === undefined ? [] : [[setting, value]];
				}),
			);
			const provider = (deps.deployProvider ?? createVercelDeployProvider)({
				token: token(),
				...(teamId !== undefined ? { teamId } : undefined),
				projectName: placement.project,
				target: "preview",
				createMissingProject: true,
				...(Object.keys(configuration).length > 0
					? { configuration }
					: undefined),
				gitArtifact: {
					org,
					repo,
					ref: head.ref,
					sha: head.sha,
					...(placement.rootDirectory !== undefined
						? { rootDirectory: placement.rootDirectory }
						: undefined),
				},
			});
			input.emitProgress(
				`delivering ${head.ref}@${head.sha.slice(0, 12)} to CD's preview on Vercel (project ${placement.project})`,
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
