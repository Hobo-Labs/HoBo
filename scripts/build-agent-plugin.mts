import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { agentPluginCiActive } from "./check-agent-plugin.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(repoRoot, "plugins", "hobo");
const entry = path.join(repoRoot, "packages/hobo/src/bin/hobo-mcp.ts");
const fixturesSource = path.join(repoRoot, "packages/hobo/fixtures/deploy");
const buildLockPath = path.join(pluginRoot, ".agent-plugin-build.lock");
const nonPublishingMarker = ".agent-plugin-nonpublishing.json";

async function withBuildLock(run: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + 600_000;
	while (Date.now() < deadline) {
		try {
			const fd = openSync(buildLockPath, "wx");
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			try {
				await run();
			} finally {
				unlinkSync(buildLockPath);
			}
			return;
		} catch (error) {
			const lockHeld =
				error instanceof Error && "code" in error && error.code === "EEXIST";
			if (!lockHeld) throw error;
			let ownerAlive = false;
			try {
				const owner = Number(readFileSync(buildLockPath, "utf8").trim());
				if (Number.isInteger(owner) && owner > 0) {
					process.kill(owner, 0);
					ownerAlive = true;
				}
			} catch {}
			if (!ownerAlive) {
				rmSync(buildLockPath, { force: true });
				continue;
			}
			await delay(100);
		}
	}
	console.error(
		"agent-plugin:build: timed out waiting for another agent-plugin:build",
	);
	process.exitCode = 1;
}

type EsbuildBuildOptions = {
	entryPoints: readonly string[];
	bundle: boolean;
	platform: "node";
	format: "esm";
	target: string;
	outfile: string;
	allowOverwrite: boolean;
	sourcemap: boolean;
	legalComments: "none";
	logLevel: "info";
	alias: Readonly<Record<string, string>>;
	external: readonly string[];
	banner: { readonly js: string };
};

type EsbuildModule = {
	build: (
		options: EsbuildBuildOptions,
	) => Promise<{ readonly errors: readonly unknown[] }>;
};

const requireFromHoboPackage = createRequire(
	path.join(repoRoot, "packages/hobo/package.json"),
);
const esbuild: EsbuildModule = requireFromHoboPackage("esbuild");

export function agentPluginLocalBuildAllowed(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.HOBO_AGENT_PLUGIN_LOCAL_BUILD === "1" && !agentPluginCiActive(env);
}

export function agentPluginBuildIsNonPublishing(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const eventName = env.GITHUB_EVENT_NAME?.trim();
	return eventName === "pull_request" || eventName === "merge_group";
}

export function agentPluginBuildAttestationIssue(
	env: NodeJS.ProcessEnv = process.env,
	headSha: string | undefined,
): string | undefined {
	if (agentPluginLocalBuildAllowed(env)) return undefined;
	if (!agentPluginCiActive(env)) {
		return "agent-plugin:build requires trusted CI or HOBO_AGENT_PLUGIN_LOCAL_BUILD=1 for an explicitly local build";
	}
	if (env.GITHUB_ACTIONS !== "true") {
		return "CI bundle builds require GitHub Actions";
	}
	const eventName = env.GITHUB_EVENT_NAME?.trim();
	const nonPublishing = agentPluginBuildIsNonPublishing(env);
	const nonPublishingRef =
		eventName === "pull_request"
			? /^refs\/pull\/[1-9][0-9]*\/(?:merge|head)$/u.test(
					env.GITHUB_REF?.trim() ?? "",
				)
			: eventName === "merge_group"
				? /^refs\/heads\/gh-readonly-queue\/.+\/pr-[1-9][0-9]*-[0-9a-f]{40}$/u.test(
						env.GITHUB_REF?.trim() ?? "",
					)
				: false;
	const runIdentity = [
		"GITHUB_RUN_ID",
		"GITHUB_RUN_ATTEMPT",
		"GITHUB_SHA",
		"GITHUB_SERVER_URL",
	] as const;
	const identityComplete = runIdentity.every(
		(name) => (env[name]?.trim() ?? "").length > 0,
	);
	if (
		env.GITHUB_REPOSITORY?.toLowerCase() !== "hobo-labs/hobo" ||
		env.GITHUB_SERVER_URL?.trim().replace(/\/$/u, "") !==
			"https://github.com" ||
		!identityComplete ||
		(nonPublishing
			? !nonPublishingRef
			: (eventName !== "push" &&
					eventName !== "schedule" &&
					eventName !== "workflow_dispatch") ||
				env.GITHUB_REF !== "refs/heads/main")
	) {
		return nonPublishing
			? "non-publishing PR bundle builds require the HoBo repository, the event's GitHub pull-request or merge-group ref, and complete run, attempt, commit, and server identity"
			: "CI bundle builds require non-publishing PR validation or the HoBo repository's trusted main ref with complete run, attempt, commit, and server identity";
	}
	const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
	if (!commitPattern.test(env.GITHUB_SHA?.trim() ?? "")) {
		return "GITHUB_SHA must be a full commit ID";
	}
	if (headSha === undefined || !commitPattern.test(headSha)) {
		return "could not resolve the checked-out HEAD commit";
	}
	if (headSha.toLowerCase() !== env.GITHUB_SHA?.trim().toLowerCase()) {
		return "GITHUB_SHA does not match the checked-out commit";
	}
	if (nonPublishing) return undefined;
	if (env.GITHUB_JOB === "main-gate") return undefined;
	const publishesProvenance =
		env.GITHUB_JOB === "agent-plugin-provenance" &&
		(env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() ?? "").length > 0 &&
		(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim() ?? "").length > 0;
	if (!publishesProvenance) {
		return "trusted main bundle builds require the main-gate verification job or the isolated provenance job's OIDC capability";
	}
	return undefined;
}

function gitOutput(args: readonly string[]): string | undefined {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return result.status === 0 ? (result.stdout?.trim() ?? "") : undefined;
}

function trustedBuildFromDirtyTree(): boolean {
	if (agentPluginLocalBuildAllowed()) return false;
	const status = gitOutput(["status", "--porcelain", "--untracked-files=all"]);
	return status === undefined || status.length > 0;
}

function removeStaleOutputs(
	targetPluginRoot: string,
	targetOutfile: string,
	targetFixtures: string,
): void {
	for (const stale of [
		path.join(targetPluginRoot, ".bundle-attestation.json"),
		path.join(targetPluginRoot, nonPublishingMarker),
		targetOutfile,
		targetFixtures,
	]) {
		rmSync(stale, { recursive: true, force: true });
		if (existsSync(stale)) {
			throw new Error(
				`agent-plugin:build: could not remove stale output ${path.relative(repoRoot, stale)}`,
			);
		}
	}
}

export async function buildAgentPlugin(
	targetPluginRoot = pluginRoot,
): Promise<void> {
	const targetOutdir = path.join(targetPluginRoot, "bin");
	const targetOutfile = path.join(targetOutdir, "hobo-mcp.mjs");
	const targetFixtures = path.join(targetPluginRoot, "fixtures/deploy");
	const attestationIssue = agentPluginBuildAttestationIssue(
		process.env,
		gitOutput(["rev-parse", "HEAD"]),
	);
	if (attestationIssue !== undefined) {
		console.error(`agent-plugin:build: ${attestationIssue}`);
		process.exitCode = 1;
		return;
	}
	if (trustedBuildFromDirtyTree()) {
		console.error(
			"agent-plugin:build: refuse to bundle a dirty tree in CI; commit or clean all tracked changes",
		);
		process.exitCode = 1;
		return;
	}
	removeStaleOutputs(targetPluginRoot, targetOutfile, targetFixtures);
	mkdirSync(targetOutdir, { recursive: true });
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile: targetOutfile,
		allowOverwrite: true,
		sourcemap: false,
		legalComments: "none",
		logLevel: "info",
		alias: {
			"@bitwarden/sdk-napi": path.join(
				repoRoot,
				"plugins/hobo/src/bitwarden-sdk-napi.mts",
			),
		},
		external: ["typescript"],
		banner: {
			js: 'import { createRequire as __hoboCreateRequire } from "node:module";const require = __hoboCreateRequire(import.meta.url);',
		},
	});
	if (result.errors.length > 0) {
		rmSync(targetOutfile, { force: true });
		process.exitCode = 1;
		return;
	}
	cpSync(fixturesSource, targetFixtures, { recursive: true });
	if (agentPluginBuildIsNonPublishing()) {
		const marker = {
			publishable: false,
			reason: process.env.GITHUB_EVENT_NAME?.trim(),
			runId: process.env.GITHUB_RUN_ID?.trim(),
			runAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim(),
			commitSha: process.env.GITHUB_SHA?.trim(),
			digest: createHash("sha256")
				.update(readFileSync(targetOutfile))
				.digest("hex"),
		};
		writeFileSync(
			path.join(targetPluginRoot, nonPublishingMarker),
			`${JSON.stringify(marker, null, 2)}\n`,
			{ flag: "wx" },
		);
		console.error(
			"agent-plugin:build: untrusted PR bundle marked non-publishing; it must not be attested or shipped",
		);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await withBuildLock(buildAgentPlugin);
}
