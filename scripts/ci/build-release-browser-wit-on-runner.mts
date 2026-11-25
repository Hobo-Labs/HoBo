#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { parseBrowserWitComponentizeProof } from "../lib/browser-wit-componentize-proof.mts";
import { browserWitComponentizeProofPath } from "../lib/browser-wit-work-root.mts";
import { assertReleasePagesBrowserRuntimeWit } from "../lib/release-pages-wit.mts";
import { exitSpawnFailClosed } from "../lib/spawn-sync-fail-closed.mts";
import { releaseSitePrebuildTurboArgs } from "./build-release-site-prebuild.mts";

const root = path.join(import.meta.dirname, "..", "..");

const SITE_RUNTIME_OUTPUT = path.join(
	root,
	"site",
	"public",
	"examples",
	"runtime",
);

function purgeColdComponentizeState(repoRoot: string): void {
	rmSync(SITE_RUNTIME_OUTPUT, { recursive: true, force: true });
	rmSync(browserWitComponentizeProofPath(repoRoot), { force: true });
	process.stderr.write(
		"browser-wit: purged site runtime output and componentize proof for cold smoke\n",
	);
}

function assertComponentizeProof(repoRoot: string): void {
	const proofPath = browserWitComponentizeProofPath(repoRoot);
	if (!existsSync(proofPath)) {
		process.stderr.write(
			`browser-wit: missing componentize proof at ${proofPath} (build may have used runtime cache)\n`,
		);
		process.exit(1);
	}
	let proof;
	try {
		proof = parseBrowserWitComponentizeProof(readFileSync(proofPath, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		process.stderr.write(`browser-wit: ${detail}\n`);
		process.exit(1);
	}
	process.stderr.write(
		`browser-wit: componentize proof ok workRoot=${proof.workRoot} digest=${proof.componentDigest}\n`,
	);
}

function main(): void {
	const checkoutRef = process.env.HOBO_RELEASE_CHECKOUT_REF?.trim() || "HEAD";
	process.stderr.write(
		`browser-wit: release runner smoke HOBO_RELEASE_CHECKOUT_REF=${checkoutRef}\n`,
	);
	assertReleasePagesBrowserRuntimeWit(root, checkoutRef);
	purgeColdComponentizeState(root);
	const childEnv = {
		...process.env,
		HOBO_BROWSER_WIT_FORCE_COMPONENTIZE: "1",
	};
	const prebuild = spawnSync("pnpm", releaseSitePrebuildTurboArgs(), {
		cwd: root,
		stdio: "inherit",
		env: childEnv,
	});
	exitSpawnFailClosed("browser-wit prebuild", prebuild);
	const build = spawnSync(
		"pnpm",
		["--filter", "hobo-site", "run", "examples:runtime"],
		{ cwd: root, stdio: "inherit", env: childEnv },
	);
	exitSpawnFailClosed("browser-wit examples:runtime", build);
	assertComponentizeProof(root);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
