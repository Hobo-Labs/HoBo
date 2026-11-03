#!/usr/bin/env node
/**
 * Publish allowlisted SDK packages to npm with OIDC provenance.
 * Requires NPM_TOKEN (hobodev publisher) and fails closed when missing on release.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { npmPublishArgs, parseReleaseRef } from "../lib/release-version.mts";
import { stageSdkArtifactsDir } from "./stage-sdk-artifacts.mts";

const root = join(import.meta.dirname, "..", "..");
const EXPECTED_PUBLISHER = "hobodev";

function run(
	cmd: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
): void {
	const result = spawnSync(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
	}
}

function assertPublisher(token: string): void {
	const whoami = spawnSync("npm", ["whoami"], {
		env: { ...process.env, NPM_TOKEN: token },
		encoding: "utf8",
	});
	if (whoami.status !== 0) {
		throw new Error("npm whoami failed; check NPM_TOKEN for hobodev publisher");
	}
	const user = whoami.stdout.trim();
	if (user !== EXPECTED_PUBLISHER) {
		throw new Error(
			`npm publisher must be ${EXPECTED_PUBLISHER}, got ${user || "(empty)"}`,
		);
	}
}

export function publishNpmSdkArtifacts(options: {
	stagingDir: string;
	token: string;
	releaseRef: string;
}): void {
	assertPublisher(options.token);
	const parsed = parseReleaseRef(options.releaseRef);
	stageSdkArtifactsDir(options.stagingDir);
	const tarballs = readdirSync(options.stagingDir).filter((name) =>
		name.endsWith(".tgz"),
	);
	if (tarballs.length === 0) {
		throw new Error("no staged npm tarballs to publish");
	}
	for (const file of tarballs.sort()) {
		run("npm", npmPublishArgs(file, parsed), options.stagingDir, {
			NPM_TOKEN: options.token,
		});
	}
}

function main(): void {
	const stagingDir = process.argv[2] ?? join(root, "/tmp/hobo-npm-release");
	const token = process.env.NPM_TOKEN ?? "";
	if (!token) {
		console.error(
			"::error::NPM_TOKEN missing; refusing npm publish (fail closed)",
		);
		process.exit(1);
	}
	if (!process.env.HOBO_RELEASE_VERSION) {
		console.error("::error::HOBO_RELEASE_VERSION required for npm publish");
		process.exit(1);
	}
	publishNpmSdkArtifacts({
		stagingDir,
		token,
		releaseRef: process.env.HOBO_RELEASE_VERSION,
	});
	const manifest = join(stagingDir, "MANIFEST.json");
	if (existsSync(manifest)) {
		console.log(readFileSync(manifest, "utf8"));
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
