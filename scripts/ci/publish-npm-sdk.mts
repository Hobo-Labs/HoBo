#!/usr/bin/env node
/**
 * Publish allowlisted SDK packages to npm with OIDC provenance.
 * Non-empty NPM_TOKEN → NODE_AUTH_TOKEN + hobodev whoami check.
 * Empty token → npm trusted publishing (GitHub-hosted runners + id-token: write only).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmPublishArgs, parseReleaseRef } from "../lib/release-version.mts";
import {
	orderedSdkTarballPaths,
	stageSdkArtifactsDir,
} from "./stage-sdk-artifacts.mts";

const root = join(import.meta.dirname, "..", "..");
const EXPECTED_PUBLISHER = "hobodev";
export const PINNED_NPM_CLI = "npm@11.21.1";

export type NpmPublishAuthMode = "oidc" | "token";

export type NpmPublishAuthEnv = {
	NODE_AUTH_TOKEN?: string;
};

export function resolveNpmPublishAuthMode(
	token: string | undefined,
): NpmPublishAuthMode {
	return token?.trim() ? "token" : "oidc";
}

export function npmPublishCliPrefix(): readonly string[] {
	return ["npx", "-y", PINNED_NPM_CLI];
}

export function npmPublishAuthEnv(
	mode: NpmPublishAuthMode,
	token: string,
): NpmPublishAuthEnv {
	if (mode === "token") {
		return {
			NODE_AUTH_TOKEN: token.trim(),
		};
	}
	return {};
}

function mergePublishEnv(base: NpmPublishAuthEnv): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = { ...process.env };
	delete merged.NPM_TOKEN;
	delete merged.NODE_AUTH_TOKEN;
	if (base.NODE_AUTH_TOKEN !== undefined) {
		merged.NODE_AUTH_TOKEN = base.NODE_AUTH_TOKEN;
	}
	return merged;
}

function runNpm(args: string[], cwd: string, env: NpmPublishAuthEnv): void {
	const result = spawnSync(
		npmPublishCliPrefix()[0]!,
		[...npmPublishCliPrefix().slice(1), ...args],
		{
			cwd,
			env: mergePublishEnv(env),
			encoding: "utf8",
			stdio: "inherit",
		},
	);
	if (result.status !== 0) {
		throw new Error(`npm ${args.join(" ")} failed (${result.status})`);
	}
}

function assertPublisher(token: string): void {
	const authEnv = npmPublishAuthEnv("token", token);
	const result = spawnSync(
		npmPublishCliPrefix()[0]!,
		[...npmPublishCliPrefix().slice(1), "whoami"],
		{
			env: mergePublishEnv(authEnv),
			encoding: "utf8",
		},
	);
	if (result.status !== 0) {
		throw new Error("npm whoami failed; check NPM_TOKEN for hobodev publisher");
	}
	const user = (result.stdout ?? "").trim();
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
	const mode = resolveNpmPublishAuthMode(options.token);
	if (mode === "token") {
		assertPublisher(options.token);
	}
	const parsed = parseReleaseRef(options.releaseRef);
	if (parsed.npmDistTag === "latest") {
		throw new Error("refusing npm dist-tag latest on release train");
	}
	const authEnv = npmPublishAuthEnv(mode, options.token);
	const manifest = stageSdkArtifactsDir(options.stagingDir);
	const tarballs = orderedSdkTarballPaths(options.stagingDir);
	if (tarballs.length !== manifest.packages.length) {
		throw new Error("SDK tarball manifest count mismatch");
	}
	for (const tarball of tarballs) {
		const file = tarball.slice(tarball.lastIndexOf("/") + 1);
		runNpm(npmPublishArgs(file, parsed), options.stagingDir, authEnv);
	}
}

function main(): void {
	const stagingDir = process.argv[2] ?? join(root, "/tmp/hobo-npm-release");
	const token = process.env.NPM_TOKEN ?? "";
	if (!process.env.HOBO_RELEASE_VERSION) {
		console.error("::error::HOBO_RELEASE_VERSION required for npm publish");
		process.exit(1);
	}
	const mode = resolveNpmPublishAuthMode(token);
	if (mode === "oidc") {
		console.log(
			"NPM_TOKEN empty; publishing via npm trusted publishing (OIDC + --provenance)",
		);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
