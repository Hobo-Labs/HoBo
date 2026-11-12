#!/usr/bin/env node
/**
 * Push the content-keyed hobo-ci-worker image to GHCR when it is present on
 * this host. Materializes the version tag from :local, pulls, or runs build.sh
 * so fleet-routed jobs do not fail when the build step ran on another box.
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
	const remote = `ghcr.io/${repository}/hobo-ci-worker:${version}`;
	const latest = `ghcr.io/${repository}/hobo-ci-worker:latest`;

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
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exit(pushCiRunnerImageGhcr());
}
