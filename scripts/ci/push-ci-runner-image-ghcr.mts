#!/usr/bin/env node
/**
 * Push the content-keyed hobo-ci-worker image to GHCR when it is present on
 * this host. Materializes the version tag from :local, pulls, or runs build.sh
 * so fleet-routed jobs do not fail when the build step ran on another box.
 *
 * A version GHCR did not have before also gets a release tag,
 * `release-<UTC yyyymmddHHMMSS>-<version>`: HoBo CD's runner-fleet Freight
 * source polls GHCR for those (packages/ci-gh-actions/deploy/runner-fleet),
 * and their lexical order is publish order, which the content key is not.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ciRunnerImageVersion } from "../lib/ci-runner-contract.mts";
import {
	dockerImagePresent,
	ensureCiWorkerImage,
} from "./ensure-ci-worker-image.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(cmd: string, args: string[]): number {
	return (
		spawnSync(cmd, args, {
			cwd: root,
			env: process.env,
			stdio: "inherit",
		}).status ?? 1
	);
}

function dockerLogin(actor: string, token: string): number {
	return (
		spawnSync("docker", ["login", "ghcr.io", "-u", actor, "--password-stdin"], {
			cwd: root,
			env: process.env,
			input: token,
			stdio: ["pipe", "inherit", "inherit"],
		}).status ?? 1
	);
}

type MaterializeWorkerImageHooks = Readonly<{
	inspect?: (ref: string) => boolean;
	tagLocalToVersion?: (candidate: string) => number;
}>;

/** Ensure `hobo-ci-worker:${version}` exists locally (from version tag or :local). */
export function materializeWorkerImageVersionTag(
	version: string,
	hooks: MaterializeWorkerImageHooks = {},
): boolean {
	const inspect = hooks.inspect ?? dockerImagePresent;
	const candidate = `hobo-ci-worker:${version}`;
	if (inspect(candidate)) return true;
	if (!inspect("hobo-ci-worker:local")) return false;
	if (hooks.tagLocalToVersion) return hooks.tagLocalToVersion(candidate) === 0;
	return (
		spawnSync("docker", ["tag", "hobo-ci-worker:local", candidate], {
			cwd: root,
			stdio: "inherit",
		}).status === 0
	);
}

const CONTENT_KEY = /^v[0-9a-f]{12}$/u;

/** The release tag HoBo CD's runner-fleet source selects (newest lexically). */
export function runnerImageReleaseTag(
	version: string,
	publishedAt: Date,
): string {
	if (!CONTENT_KEY.test(version))
		throw new Error(
			`${version} is not a content-keyed runner image version (v + 12 hex)`,
		);
	const stamp = publishedAt.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
	return `release-${stamp}-${version}`;
}

export type ReleaseTagOutcome =
	| Readonly<{ published: string }>
	| Readonly<{ skipped: "already-released" | "push-failed" }>;

/**
 * Tag and push the release tag once per version: only when GHCR did not
 * have the version before this push, so one version is one Freight.
 */
export function publishRunnerImageReleaseTag(
	input: Readonly<{
		image: string;
		remoteRepository: string;
		version: string;
		versionWasPublished: boolean;
		now: Date;
		run: (cmd: string, args: string[]) => number;
	}>,
): ReleaseTagOutcome {
	if (input.versionWasPublished) return { skipped: "already-released" };
	const remote = `${input.remoteRepository}:${runnerImageReleaseTag(input.version, input.now)}`;
	if (
		input.run("docker", ["tag", input.image, remote]) !== 0 ||
		input.run("docker", ["push", remote]) !== 0
	)
		return { skipped: "push-failed" };
	return { published: remote };
}

function remoteTagExists(ref: string): boolean {
	return (
		spawnSync("docker", ["manifest", "inspect", ref], {
			cwd: root,
			stdio: "ignore",
		}).status === 0
	);
}

export function pushCiRunnerImageGhcr(): number {
	const token =
		process.env.GITHUB_TOKEN?.trim() ?? process.env.GHCR_TOKEN?.trim() ?? "";
	if (!token) {
		console.log("GHCR token unavailable; skipping runner image push");
		return 0;
	}
	const repository = (
		process.env.GITHUB_REPOSITORY ?? "Hobo-Labs/HoBo"
	).toLowerCase();
	const actor = process.env.GITHUB_ACTOR ?? "github-actions";
	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;
	const remoteRepository = `ghcr.io/${repository}/hobo-ci-worker`;
	const remote = `${remoteRepository}:${version}`;
	const latest = `${remoteRepository}:latest`;

	let ready = materializeWorkerImageVersionTag(version);
	if (!ready) {
		console.log(
			`${candidate} is not on this host; pulling ${remote} or building before push`,
		);
		try {
			ensureCiWorkerImage();
			ready = materializeWorkerImageVersionTag(version);
		} catch (error) {
			console.log(
				`::notice title=Runner image push skipped::Could not materialize ${candidate} on this runner (${error instanceof Error ? error.message : "build failed"}); another box may publish it.`,
			);
			return 0;
		}
	}
	if (!ready || !dockerImagePresent(candidate)) {
		console.log(
			`::notice title=Runner image push skipped::${candidate} is still absent on this runner after pull/build; skipping GHCR push.`,
		);
		return 0;
	}
	if (dockerLogin(actor, token) !== 0) {
		console.log("::notice title=Runner image push skipped::GHCR login failed");
		return 0;
	}
	// Read before the push: whether GHCR already had this version decides its release tag.
	const versionWasPublished = remoteTagExists(remote);
	if (run("docker", ["tag", candidate, remote]) !== 0) {
		console.log(
			`::notice title=Runner image push skipped::docker tag ${candidate} failed`,
		);
		return 0;
	}
	if (run("docker", ["push", remote]) !== 0) {
		console.log(
			`::notice title=Runner image push skipped::docker push ${remote} failed`,
		);
		return 0;
	}
	if (
		// From the image just pushed, not :local, which any job's build on the box moves.
		run("docker", ["tag", candidate, latest]) !== 0 ||
		run("docker", ["push", latest]) !== 0
	) {
		console.log(
			`::notice title=Runner image push skipped::docker push ${latest} failed after ${remote} succeeded`,
		);
		return 0;
	}
	console.log(`Published ${remote} and ${latest}`);
	const release = publishRunnerImageReleaseTag({
		image: candidate,
		remoteRepository,
		version,
		versionWasPublished,
		now: new Date(),
		run,
	});
	if ("published" in release)
		console.log(`Published ${release.published} for HoBo CD`);
	else if (release.skipped === "push-failed")
		console.log(
			`::notice title=Runner image release tag skipped::the release tag for ${version} was not pushed; HoBo CD discovers this version only once a later version is released`,
		);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exit(pushCiRunnerImageGhcr());
}
