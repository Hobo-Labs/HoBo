import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { agentPluginCiActive } from "./check-agent-plugin.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(repoRoot, "plugins", "hobo");
const entry = path.join(repoRoot, "packages/hobo/src/bin/hobo-mcp.ts");
const outdir = path.join(pluginRoot, "bin");
const outfile = path.join(outdir, "hobo-mcp.mjs");
const fixturesSource = path.join(repoRoot, "packages/hobo/fixtures/deploy");
const fixturesTarget = path.join(pluginRoot, "fixtures/deploy");

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

type BundleAttestationRecord = {
	scope: "job-local";
	sha256: string;
	runId?: string;
	runAttempt?: string;
	commitSha?: string;
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

async function main(): Promise<void> {
	const attestationPath = path.join(pluginRoot, ".bundle-attestation.json");
	const porcelainBeforeBuild = spawnSync(
		"git",
		["status", "--porcelain", "--untracked-files=all"],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);
	const checkoutCleanBeforeBuild =
		porcelainBeforeBuild.status === 0 &&
		(porcelainBeforeBuild.stdout ?? "").trim().length === 0;
	rmSync(attestationPath, { force: true });
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
		rmSync(attestationPath, { force: true });
		rmSync(outfile, { force: true });
		process.exitCode = 1;
		return;
	}
	rmSync(fixturesTarget, { recursive: true, force: true });
	cpSync(fixturesSource, fixturesTarget, { recursive: true });
	const sha256 = createHash("sha256")
		.update(readFileSync(outfile))
		.digest("hex");
	const inActions = process.env.GITHUB_ACTIONS === "true";
	if (!inActions) {
		if (agentPluginCiActive()) {
			console.error(
				"agent-plugin:build: refuse to ship a bundle without attestation when CI is active; run on a GitHub Actions runner (GITHUB_ACTIONS=true)",
			);
			rmSync(attestationPath, { force: true });
			rmSync(outfile, { force: true });
			rmSync(fixturesTarget, { recursive: true, force: true });
			process.exitCode = 1;
			return;
		}
		rmSync(attestationPath, { force: true });
		return;
	}
	const runId = process.env.GITHUB_RUN_ID?.trim() ?? "";
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
	const commitSha = process.env.GITHUB_SHA?.trim() ?? "";
	const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	const discardBundleOutput = (): void => {
		rmSync(attestationPath, { force: true });
		rmSync(outfile, { force: true });
		rmSync(fixturesTarget, { recursive: true, force: true });
	};
	if (
		headSha.status !== 0 ||
		!checkoutCleanBeforeBuild ||
		headSha.stdout?.trim() !== commitSha
	) {
		console.error(
			"agent-plugin:build: refuse attestation unless the checkout was clean before the build and HEAD matches GITHUB_SHA",
		);
		discardBundleOutput();
		process.exitCode = 1;
		return;
	}
	if (runId.length === 0 || commitSha.length === 0) {
		console.error(
			"agent-plugin:build: GITHUB_RUN_ID and GITHUB_SHA are required in GitHub Actions",
		);
		discardBundleOutput();
		process.exitCode = 1;
		return;
	}
	if (runAttempt !== undefined && runAttempt.length === 0) {
		console.error(
			"agent-plugin:build: GITHUB_RUN_ATTEMPT must be non-empty when set",
		);
		discardBundleOutput();
		process.exitCode = 1;
		return;
	}
	const payload: BundleAttestationRecord = {
		scope: "job-local",
		sha256,
		runId,
		commitSha,
	};
	if (runAttempt !== undefined && runAttempt.length > 0) {
		payload.runAttempt = runAttempt;
	}
	writeFileSync(
		path.join(pluginRoot, ".bundle-attestation.json"),
		`${JSON.stringify(payload)}\n`,
	);
}

await main();
