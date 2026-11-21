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
	sha256: string;
	runId?: string;
	runAttempt?: string;
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
		process.exitCode = 1;
		return;
	}
	rmSync(fixturesTarget, { recursive: true, force: true });
	cpSync(fixturesSource, fixturesTarget, { recursive: true });
	const sha256 = createHash("sha256")
		.update(readFileSync(outfile))
		.digest("hex");
	const runId = process.env.GITHUB_RUN_ID?.trim();
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
	const payload: BundleAttestationRecord = {
		sha256,
	};
	if (runId !== undefined && runId.length > 0) payload.runId = runId;
	if (runAttempt !== undefined && runAttempt.length > 0) {
		payload.runAttempt = runAttempt;
	}
	writeFileSync(
		path.join(pluginRoot, ".bundle-attestation.json"),
		`${JSON.stringify(payload)}\n`,
	);
}

await main();
