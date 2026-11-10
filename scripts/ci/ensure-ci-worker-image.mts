#!/usr/bin/env node
/**
 * Resolve a digest-pinned hobo-ci-worker image for release OCI builds.
 * Prefers ghcr.io/hobo-ci-worker:${ciRunnerImageVersion}; falls back to build.sh.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ciRunnerImageVersion } from "../lib/ci-runner-contract.mts";

const root = join(import.meta.dirname, "..", "..");

function run(cmd: string, args: string[], allowFail = false): number {
	const result = spawnSync(cmd, args, {
		cwd: root,
		env: process.env,
		stdio: "inherit",
	});
	if (!allowFail && result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
	}
	return result.status ?? 1;
}

function dockerInspect(ref: string): boolean {
	return (
		spawnSync("docker", ["image", "inspect", ref], {
			cwd: root,
			stdio: "ignore",
		}).status === 0
	);
}

/** Fast HEAD against GHCR; avoids a long `docker pull` when the tag was never pushed. */
export function ghcrWorkerManifestPublished(
	repository: string,
	version: string,
	token: string,
): boolean {
	const repo = repository.toLowerCase();
	if (!repo.includes("/") || !version.trim() || !token.trim()) return false;
	const url = `https://ghcr.io/v2/${repo}/hobo-ci-worker/manifests/${version}`;
	const result = spawnSync(
		"curl",
		[
			"-fsS",
			"--max-time",
			"45",
			"-o",
			"/dev/null",
			"-H",
			`Authorization: Bearer ${token}`,
			"-H",
			"Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
			url,
		],
		{ stdio: "ignore" },
	);
	return result.status === 0;
}

export function publishedWorkerRequiredMessage(
	repository: string,
	version: string,
): string {
	const repo = repository.toLowerCase();
	return [
		`CI runner worker image ghcr.io/${repo}/hobo-ci-worker:${version} is not published.`,
		"Push or run the release workflow publish step for the current ciRunnerImageVersion before tag OCI builds.",
		"Refusing local build.sh (HOBO_CI_REQUIRE_PUBLISHED_WORKER=1).",
	].join(" ");
}

export function ensureCiWorkerImage(): string {
	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;
	if (dockerInspect(candidate)) {
		run("docker", ["tag", candidate, "hobo-ci-worker:local"]);
		console.log(`using pinned worker ${candidate}`);
		return candidate;
	}

	const repo = process.env.GITHUB_REPOSITORY?.toLowerCase();
	const event = process.env.GITHUB_EVENT_NAME ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	const mayPullFromGhcr =
		Boolean(repo) &&
		Boolean(token) &&
		event !== "pull_request" &&
		process.env.HOBO_CI_SKIP_GHCR_PULL !== "1";
	if (mayPullFromGhcr && repo) {
		const remote = `ghcr.io/${repo}/hobo-ci-worker:${version}`;
		if (
			process.env.HOBO_CI_REQUIRE_PUBLISHED_WORKER === "1" &&
			token &&
			!ghcrWorkerManifestPublished(repo, version, token)
		) {
			throw new Error(publishedWorkerRequiredMessage(repo, version));
		}
		if (run("docker", ["pull", remote], true) === 0) {
			run("docker", ["tag", remote, candidate]);
			run("docker", ["tag", remote, "hobo-ci-worker:local"]);
			console.log(`pulled worker ${remote}`);
			return candidate;
		}
	}

	if (process.env.HOBO_CI_REQUIRE_PUBLISHED_WORKER === "1") {
		throw new Error(
			`published ghcr.io hobo-ci-worker:${version} required; refusing local build.sh (HOBO_CI_SKIP_GHCR_PULL=${process.env.HOBO_CI_SKIP_GHCR_PULL ?? ""})`,
		);
	}

	run("bash", ["packages/ci-gh-actions/deploy/ci-runner/build.sh"]);
	if (!dockerInspect(candidate) && !dockerInspect("hobo-ci-worker:local")) {
		throw new Error("worker image build did not produce hobo-ci-worker:local");
	}
	if (dockerInspect(candidate)) {
		run("docker", ["tag", candidate, "hobo-ci-worker:local"]);
	}
	return candidate;
}

function main(): void {
	const image = ensureCiWorkerImage();
	console.log(image);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
