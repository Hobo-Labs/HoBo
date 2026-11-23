import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isJsonNumber } from "./json.js";

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

export type VercelBuildRunner = (
	args: readonly string[],
	options: Readonly<{ cwd: string; timeoutMs: number }>,
) => Promise<VercelBuildResult>;

export type VercelPrebuiltFailure = Readonly<{
	ok: false;
	code: string;
	message: string;
}>;

export interface VercelBuildEnvironment {
	readonly [name: string]: string;
}

export type StagedBuild = Readonly<{
	ok: true;
	deployment: VercelProjectDeployment;
}>;

export type PromotedBuild = Readonly<{
	ok: true;
	deployment: VercelProjectDeployment;
	projectId: string;
	alreadyLive: boolean;
	previousDeploymentId?: string;
}>;

type StageInput = Readonly<{
	run: VercelBuildRunner;
	client: VercelClient;
	project: string;
	cwd: string;
	head: string;
	freightId: string;
	sha: string;
	emit: (message: string) => void;
	removeOutput?: (directory: string) => void;
	bundle?: Readonly<{ file: string; text: string }>;
}>;

const CREDENTIAL_NAME =
	/(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH)/i;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const PULL_TIMEOUT_MS = 3 * 60_000;
const SHA = /^[0-9a-f]{40}$/;
const META_VALUE = /^[A-Za-z0-9._:-]{1,200}$/;
const VERCEL_OUTPUT_DIRECTORY = ".vercel";

export function vercelBuildEnvironment(
	env: Readonly<Record<string, string | undefined>>,
	extra: VercelBuildEnvironment,
): VercelBuildEnvironment {
	const kept: [string, string][] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || CREDENTIAL_NAME.test(name)) continue;
		if (name.startsWith("VERCEL_") || name.startsWith("ACTIONS_ID_TOKEN"))
			continue;
		kept.push([name, value]);
	}
	return Object.fromEntries([
		...kept,
		["NO_COLOR", "1"],
		["CI", "1"],
		...Object.entries(extra),
	]);
}

export function vercelBuildRunnerFrom(
	executable: string,
	env: VercelBuildEnvironment,
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
						error === null ? 0 : isJsonNumber(error.code) ? error.code : 1;
					resolve({ code, stdout: String(stdout), stderr: String(stderr) });
				},
			);
		});
}

function lastLines(text: string, lines = 12): string {
	return text.trim().split("\n").slice(-lines).join("\n");
}

function removeDirectory(directory: string): void {
	rmSync(directory, { recursive: true, force: true });
}

export async function stageVercelBuild(
	input: StageInput,
): Promise<StagedBuild | VercelPrebuiltFailure> {
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
	const output = path.join(input.cwd, VERCEL_OUTPUT_DIRECTORY);
	const removeOutput = input.removeOutput ?? removeDirectory;
	removeOutput(output);
	try {
		if (input.bundle !== undefined)
			writeFileSync(input.bundle.file, input.bundle.text, { mode: 0o600 });
		return await buildAndUpload(input, sha);
	} finally {
		if (input.bundle !== undefined) rmSync(input.bundle.file, { force: true });
		removeOutput(output);
	}
}

async function buildAndUpload(
	input: StageInput,
	sha: string,
): Promise<StagedBuild | VercelPrebuiltFailure> {
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
				message: `vercel ${args[0]} failed (exit ${result.code}) trying to ${what}:\n${lastLines(result.stderr || result.stdout)}`,
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

export async function promoteStagedBuild(
	input: Readonly<{
		client: VercelClient;
		project: string;
		freightId: string;
		sha: string;
		emit: (message: string) => void;
	}>,
): Promise<PromotedBuild | VercelPrebuiltFailure> {
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
		return {
			ok: true,
			deployment: staged,
			projectId: read.id,
			alreadyLive: true,
		};
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
		alreadyLive: false,
		...(previous !== undefined
			? { previousDeploymentId: previous }
			: undefined),
	};
}

export async function servesProduction(
	client: VercelClient,
	project: string,
	deploymentId: string,
): Promise<boolean> {
	return (
		(await client.readProject(project)).productionDeploymentId === deploymentId
	);
}
