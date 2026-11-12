#!/usr/bin/env node
/**
 * Publish allowlisted SDK packages to npm with OIDC provenance.
 * Non-empty NPM_TOKEN → NODE_AUTH_TOKEN + hobodev whoami check.
 * Empty token → npm trusted publishing (GitHub-hosted runners + id-token: write only).
 * Every tarball is recorded as release Freight and promoted into
 * hobo-release/npm-candidate through `hobo deploy`, whose realizer is
 * @hobo/provider-npm. That realizer cannot realize this target as the release
 * declares it: the Freight carries no Sigstore bundle for the provenance the
 * Camp requires (npm-provenance-bundle-missing), and @hobo/provider-npm refuses
 * OIDC trusted publishing of scoped @hobo-labs names
 * (npm-oidc-scoped-unsupported). Only on exactly those typed codes, the
 * `impedance` verdict, does `npm publish --provenance` below publish: an unmet
 * requirement (release-channels.md), not a realized publish. A qualified
 * verdict means the realizer published; anything else, including a
 * misdeclared npm Camp or Freight (catalog-binding-invalid), stops before npm.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmPublishArgs, parseReleaseRef } from "../lib/release-version.mts";
import { qualifyReleaseCandidate } from "./create-github-release.mts";
import {
	orderedSdkTarballPaths,
	type SdkArtifactManifest,
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

/** Seams for tests; production staging, Freight and npm by default. */
export type NpmPublishDeps = {
	readonly stage?: (dir: string) => SdkArtifactManifest;
	readonly tarballs?: (dir: string) => string[];
	readonly read?: (path: string) => Uint8Array;
	readonly qualify?: (
		input: Parameters<typeof qualifyReleaseCandidate>[0],
	) => Promise<Awaited<ReturnType<typeof qualifyReleaseCandidate>>>;
	readonly npm?: (args: string[]) => void;
};

/**
 * Stage the SDK tarballs, record them as release Freight and promote it into
 * `hobo-release/npm-candidate` through `hobo deploy`
 * (scripts/ci/create-github-release.mts). `qualified`: the realizer published,
 * nothing more runs. `impedance`: `npm publish --provenance` publishes. A
 * blocked verdict throws before any `npm publish`.
 */
export async function publishNpmSdkArtifacts(
	options: {
		stagingDir: string;
		token: string;
		releaseRef: string;
		/** HOBO_HOME of the release Freight journal (HOBO_RELEASE_CD_HOME). */
		freightHome?: string;
	},
	deps: NpmPublishDeps = {},
): Promise<void> {
	const mode = resolveNpmPublishAuthMode(options.token);
	const parsed = parseReleaseRef(options.releaseRef);
	if (parsed.npmDistTag === "latest") {
		throw new Error("refusing npm dist-tag latest on release train");
	}
	if (!options.freightHome?.trim()) {
		throw new Error(
			"npm publish needs release Freight: set HOBO_RELEASE_CD_HOME to the hobo deploy journal directory",
		);
	}
	if (mode === "token" && !deps.npm) {
		assertPublisher(options.token);
	}
	const authEnv = npmPublishAuthEnv(mode, options.token);
	const manifest = (deps.stage ?? stageSdkArtifactsDir)(options.stagingDir);
	const tarballs = (deps.tarballs ?? orderedSdkTarballPaths)(
		options.stagingDir,
	);
	if (tarballs.length !== manifest.packages.length) {
		throw new Error("SDK tarball manifest count mismatch");
	}
	const read =
		deps.read ?? ((path: string) => new Uint8Array(readFileSync(path)));
	const { verdict } = await (deps.qualify ?? qualifyReleaseCandidate)({
		home: options.freightHome,
		family: "npm",
		stored: manifest.packages.map((entry, index) => ({
			name: `${entry.public}@${manifest.version}`,
			kind: "ARTIFACT_KIND_PACKAGE",
			mediaType: "application/gzip",
			bytes: read(tarballs[index] ?? ""),
		})),
		labels: {
			"hobo.release/ref": options.releaseRef,
			"hobo.cd/npm.dist-tag": parsed.npmDistTag,
		},
	});
	if (verdict.outcome === "qualified") return;
	if (verdict.outcome !== "impedance")
		throw new Error(
			`release Freight npm is ${verdict.outcome} (${verdict.codes.join(", ")}); nothing is published`,
		);
	const npm =
		deps.npm ?? ((args: string[]) => runNpm(args, options.stagingDir, authEnv));
	for (const tarball of tarballs) {
		const file = tarball.slice(tarball.lastIndexOf("/") + 1);
		npm(npmPublishArgs(file, parsed));
	}
}

async function main(): Promise<void> {
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
	await publishNpmSdkArtifacts({
		stagingDir,
		token,
		releaseRef: process.env.HOBO_RELEASE_VERSION,
		freightHome: process.env.HOBO_RELEASE_CD_HOME ?? "",
	});
	const manifest = join(stagingDir, "MANIFEST.json");
	if (existsSync(manifest)) {
		console.log(readFileSync(manifest, "utf8"));
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(
			`::error::${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
