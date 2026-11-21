import {
	closeSync,
	cpSync,
	mkdirSync,
	openSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { agentPluginCiActive } from "./check-agent-plugin.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(repoRoot, "plugins", "hobo");
const entry = path.join(repoRoot, "packages/hobo/src/bin/hobo-mcp.ts");
const outdir = path.join(pluginRoot, "bin");
const outfile = path.join(outdir, "hobo-mcp.mjs");
const fixturesSource = path.join(repoRoot, "packages/hobo/fixtures/deploy");
const fixturesTarget = path.join(pluginRoot, "fixtures/deploy");
const buildLockPath = path.join(pluginRoot, ".agent-plugin-build.lock");

async function withBuildLock(run: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + 600_000;
	while (Date.now() < deadline) {
		try {
			const fd = openSync(buildLockPath, "wx");
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

export function agentPluginBuildAttestationIssue(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!agentPluginCiActive(env)) return undefined;
	if (env.GITHUB_ACTIONS !== "true") {
		return "CI bundle builds require GitHub Actions";
	}
	const eventName = env.GITHUB_EVENT_NAME?.trim();
	if (eventName === "pull_request" || eventName === "merge_group") {
		return undefined;
	}
	const runIdentity = [
		"GITHUB_RUN_ID",
		"GITHUB_RUN_ATTEMPT",
		"GITHUB_SHA",
		"GITHUB_SERVER_URL",
	] as const;
	if (
		env.GITHUB_REPOSITORY?.toLowerCase() !== "hobo-labs/hobo" ||
		env.GITHUB_REF !== "refs/heads/main" ||
		(eventName !== "push" &&
			eventName !== "schedule" &&
			eventName !== "workflow_dispatch") ||
		runIdentity.some((name) => (env[name]?.trim() ?? "").length === 0)
	) {
		return "CI bundle builds require non-publishing PR validation or the HoBo repository's trusted main ref with complete run, attempt, commit, and server identity";
	}
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

async function buildAgentPlugin(): Promise<void> {
	rmSync(path.join(pluginRoot, ".bundle-attestation.json"), { force: true });
	mkdirSync(outdir, { recursive: true });
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile,
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
		rmSync(outfile, { force: true });
		process.exitCode = 1;
		return;
	}
	rmSync(fixturesTarget, { recursive: true, force: true });
	cpSync(fixturesSource, fixturesTarget, { recursive: true });
	const attestationIssue = agentPluginBuildAttestationIssue();
	if (attestationIssue !== undefined) {
		console.error(`agent-plugin:build: ${attestationIssue}`);
		rmSync(outfile, { force: true });
		rmSync(fixturesTarget, { recursive: true, force: true });
		process.exitCode = 1;
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await withBuildLock(buildAgentPlugin);
}
