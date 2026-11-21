// Build once, promote the same build: HoBo.CD's Vercel delivery with no Git
// integration.
//
// Vercel's Git integration builds every push itself, so production is a
// second build of the commit preview verified, and a project with no Git
// connection is never deployed at all. Here the build is HoBo's:
//
// 1. stage: in the checkout of the Freight's commit, `vercel pull`, `vercel
//    build --prod` and `vercel deploy --prebuilt --prod --skip-domain`
//    upload a production build that serves no domain yet. Its `meta` names
//    the Freight (`hoboFreight`) and the commit (`hoboSha`).
// 2. promote: the production node finds that exact build by its meta and
//    points the production domains at it (POST
//    /v10/projects/{project}/promote/{deployment}): no rebuild, so what
//    production serves is the bytes the staging node verified.
// 3. roll back: when production verification fails, the domains go back to
//    the deployment they served before the promotion (POST
//    /v1/projects/{project}/rollback/{deployment}).
//
// The Vercel CLI runs without a shell. Its environment is the caller's minus
// every variable whose name looks like a credential, plus the deploy token
// and the project's coordinates; its output is read, never printed whole.

import { execFile } from "node:child_process";

import type { VercelClient, VercelProjectDeployment } from "./vercel-client.js";

// public-contract: the meta keys a HoBo-staged Vercel build carries.
export const VERCEL_PREBUILT_META = Object.freeze({
	freight: "hoboFreight",
	sha: "hoboSha",
} as const);

// public-contract: typed refusals of the prebuilt Vercel delivery.
export const VERCEL_PREBUILT_REFUSAL = Object.freeze({
	checkoutMismatch: "HOBO_CI_DEPLOY_CHECKOUT_MISMATCH",
	buildFailed: "HOBO_CI_DEPLOY_BUILD_FAILED",
	stageFailed: "HOBO_CI_DEPLOY_STAGE_FAILED",
	notStaged: "HOBO_CI_DEPLOY_NOT_STAGED",
	stagedNotReady: "HOBO_CI_DEPLOY_STAGED_NOT_READY",
	promoteFailed: "HOBO_CI_DEPLOY_PROMOTE_FAILED",
} as const);

export type VercelBuildResult = Readonly<{
	code: number;
	stdout: string;
	stderr: string;
}>;

/** One Vercel CLI invocation in `cwd`; injected in tests. */
export type VercelBuildRunner = (
	args: readonly string[],
	options: Readonly<{ cwd: string; timeoutMs: number }>,
) => Promise<VercelBuildResult>;

export type VercelPrebuiltFailure = Readonly<{
	ok: false;
	code: string;
	message: string;
}>;

// A name that may carry a credential: kept out of the CLI's environment, so
// a build script can read only what the project itself is given.
const CREDENTIAL_NAME =
	/(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH)/i;

/** The CLI's environment: the caller's, credentials removed, `extra` added. */
export function vercelBuildEnvironment(
	env: Readonly<Record<string, string | undefined>>,
	extra: Readonly<Record<string, string>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || CREDENTIAL_NAME.test(name)) continue;
		if (name.startsWith("VERCEL_") || name.startsWith("ACTIONS_ID_TOKEN"))
			continue;
		out[name] = value;
	}
	return { ...out, NO_COLOR: "1", CI: "1", ...extra };
}

/** The Vercel CLI the build runs: `executable`, no shell, bounded output. */
export function vercelBuildRunnerFrom(
	executable: string,
	env: Readonly<Record<string, string>>,
): VercelBuildRunner {
	return (args, options) =>
		new Promise((resolve) => {
			execFile(
				executable,
				[...args],
				{
					cwd: options.cwd,
					env,
					timeout: options.timeoutMs,
					maxBuffer: 32 * 1024 * 1024,
					encoding: "utf8",
				},
				(error, stdout, stderr) => {
					const code =
						error === null
							? 0
							: typeof error.code === "number"
								? error.code
								: 1;
					resolve({ code, stdout: String(stdout), stderr: String(stderr) });
				},
			);
		});
}

// The last lines of a CLI answer: enough to say why, never a whole log.
function tail(text: string, lines = 12): string {
	return text.trim().split("\n").slice(-lines).join("\n");
}

const BUILD_TIMEOUT_MS = 20 * 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const PULL_TIMEOUT_MS = 3 * 60_000;
const SHA = /^[0-9a-f]{40}$/;
// A Freight id as `vercel deploy --meta` carries it: no `=`, no space.
const META_VALUE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Stage the Freight's build: build the checkout `cwd` (which must be at
 * `sha`) for production and upload it as a production deployment that serves
 * no domain. Returns the staged deployment, found by its meta.
 */
export async function stageVercelBuild(
	input: Readonly<{
		run: VercelBuildRunner;
		client: VercelClient;
		project: string;
		/** The repository checkout the build runs in. */
		cwd: string;
		/** The checkout's HEAD, as `git rev-parse HEAD` reads it. */
		head: string;
		freightId: string;
		sha: string;
		emit: (message: string) => void;
	}>,
): Promise<
	| Readonly<{ ok: true; deployment: VercelProjectDeployment }>
	| VercelPrebuiltFailure
> {
	const sha = input.sha.toLowerCase();
	if (!SHA.test(sha) || input.head.trim().toLowerCase() !== sha)
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.checkoutMismatch,
			message: `The checkout at ${input.cwd} is at ${input.head.trim() || "no commit"}, not the Freight's commit ${input.sha}: HoBo builds only the commit the Freight pins. Check out ${input.sha} and run again.`,
		};
	if (!META_VALUE.test(input.freightId))
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.stageFailed,
			message: `Freight id ${input.freightId} cannot be carried as Vercel deployment meta.`,
		};
	const steps: readonly (readonly [string, readonly string[], number])[] = [
		[
			"pull the project's production settings",
			["pull", "--yes", "--environment=production"],
			PULL_TIMEOUT_MS,
		],
		["build for production", ["build", "--prod", "--yes"], BUILD_TIMEOUT_MS],
		[
			"upload the build as a staged production deployment",
			[
				"deploy",
				"--prebuilt",
				"--prod",
				"--skip-domain",
				"--yes",
				"--meta",
				`${VERCEL_PREBUILT_META.freight}=${input.freightId}`,
				"--meta",
				`${VERCEL_PREBUILT_META.sha}=${sha}`,
			],
			DEPLOY_TIMEOUT_MS,
		],
	];
	for (const [what, args, timeoutMs] of steps) {
		input.emit(`vercel ${args[0]}: ${what}`);
		const result = await input.run(args, { cwd: input.cwd, timeoutMs });
		if (result.code !== 0)
			return {
				ok: false,
				code:
					args[0] === "deploy"
						? VERCEL_PREBUILT_REFUSAL.stageFailed
						: VERCEL_PREBUILT_REFUSAL.buildFailed,
				message: `vercel ${args[0]} failed (exit ${result.code}) trying to ${what}:\n${tail(result.stderr || result.stdout)}`,
			};
	}
	const staged = await findStagedBuild(
		input.client,
		input.project,
		input.freightId,
	);
	if (staged === undefined)
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.stageFailed,
			message: `vercel deploy reported success, but project ${input.project} lists no production build with ${VERCEL_PREBUILT_META.freight}=${input.freightId}.`,
		};
	return { ok: true, deployment: staged };
}

/**
 * The newest production build of `project` whose meta names `freightId`: the
 * build `stageVercelBuild` uploaded for that Freight.
 */
export async function findStagedBuild(
	client: VercelClient,
	project: string,
	freightId: string,
): Promise<VercelProjectDeployment | undefined> {
	const builds = await client.listProjectDeployments({
		project,
		target: "production",
		limit: 100,
	});
	let newest: VercelProjectDeployment | undefined;
	for (const build of builds) {
		if (build.meta[VERCEL_PREBUILT_META.freight] !== freightId) continue;
		if (
			newest === undefined ||
			(build.createdAt ?? 0) > (newest.createdAt ?? 0)
		)
			newest = build;
	}
	return newest;
}

/**
 * Point production at the build staged for `freightId`, with no rebuild.
 * Answers the deployment production served before, the rollback target;
 * undefined when production served nothing or already served this build.
 */
export async function promoteStagedBuild(
	input: Readonly<{
		client: VercelClient;
		project: string;
		freightId: string;
		sha: string;
		emit: (message: string) => void;
	}>,
): Promise<
	| Readonly<{
			ok: true;
			deployment: VercelProjectDeployment;
			/** The project's canonical id: promote and rollback take it. */
			projectId: string;
			previousDeploymentId?: string;
	  }>
	| VercelPrebuiltFailure
> {
	const staged = await findStagedBuild(
		input.client,
		input.project,
		input.freightId,
	);
	if (staged === undefined)
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.notStaged,
			message: `Project ${input.project} has no build staged for Freight ${input.freightId}: production promotes only the build its staging node uploaded and verified. Run hobo ci deploy --target preview --build prebuilt for ${input.sha} first.`,
		};
	const stagedSha = staged.meta[VERCEL_PREBUILT_META.sha];
	if (stagedSha !== input.sha.toLowerCase())
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.notStaged,
			message: `The build staged for Freight ${input.freightId} (${staged.id}) names commit ${stagedSha ?? "none"}, not ${input.sha}: it is not promoted.`,
		};
	if (staged.readyState !== "READY")
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.stagedNotReady,
			message: `The build staged for Freight ${input.freightId} (${staged.id}) is ${staged.readyState ?? "of unknown state"}, not READY: only a ready build is promoted.`,
		};
	const read = await input.client.readProject(input.project);
	const previous = read.productionDeploymentId;
	if (previous === staged.id) {
		input.emit(`production already serves ${staged.id}; nothing to promote`);
		return { ok: true, deployment: staged, projectId: read.id };
	}
	input.emit(
		`promoting ${staged.id} (${staged.url}) to production${previous !== undefined ? `, replacing ${previous}` : ""}`,
	);
	try {
		await input.client.promoteDeployment(read.id, staged.id);
	} catch (error) {
		return {
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.promoteFailed,
			message: `Vercel refused to promote ${staged.id}: ${error instanceof Error ? error.message : "unknown error"}`,
		};
	}
	return {
		ok: true,
		deployment: staged,
		projectId: read.id,
		...(previous !== undefined
			? { previousDeploymentId: previous }
			: undefined),
	};
}

/**
 * Whether production now serves `deploymentId`: a promotion Vercel accepted
 * (202) finishes asynchronously, so readiness waits for the pointer to move.
 */
export async function servesProduction(
	client: VercelClient,
	project: string,
	deploymentId: string,
): Promise<boolean> {
	return (
		(await client.readProject(project)).productionDeploymentId === deploymentId
	);
}
