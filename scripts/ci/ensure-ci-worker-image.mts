#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Resolve a digest-pinned hobo-ci-worker image for release OCI builds.
 * Prefers ghcr.io/hobo-ci-worker:${ciRunnerImageVersion}; falls back to build.sh.
 */
import { readFileSync } from "node:fs";
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

export function dockerImagePresent(ref: string): boolean {
	return (
		spawnSync("docker", ["image", "inspect", ref], {
			cwd: root,
			stdio: "ignore",
		}).status === 0
	);
}

export function sameRepositoryPullRequest(): boolean {
	if (process.env.GITHUB_EVENT_NAME !== "pull_request") return false;
	const path = process.env.GITHUB_EVENT_PATH;
	if (!path) return false;
	try {
		// SAFETY: GitHub Actions event payload is JSON with optional pull_request head/base repos.
		const payload = JSON.parse(readFileSync(path, "utf8")) as {
			pull_request?: {
				head?: { repo?: { full_name?: string } };
				base?: { repo?: { full_name?: string } };
			};
		};
		const head = payload.pull_request?.head?.repo?.full_name;
		const base = payload.pull_request?.base?.repo?.full_name;
		return Boolean(head && base && head === base);
	} catch {
		return false;
	}
}

export function ensureCiWorkerImage(): string {
	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;
	if (dockerImagePresent(candidate)) {
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
		(event !== "pull_request" || sameRepositoryPullRequest()) &&
		process.env.HOBO_CI_SKIP_GHCR_PULL !== "1";
	if (mayPullFromGhcr) {
		const remote = `ghcr.io/${repo}/hobo-ci-worker:${version}`;
		if (run("docker", ["pull", remote], true) === 0) {
			run("docker", ["tag", remote, candidate]);
			run("docker", ["tag", remote, "hobo-ci-worker:local"]);
			console.log(`pulled worker ${remote}`);
			return candidate;
		}
	}

	run("bash", ["packages/ci-gh-actions/deploy/ci-runner/build.sh"]);
	if (
		!dockerImagePresent(candidate) &&
		!dockerImagePresent("hobo-ci-worker:local")
	) {
		throw new Error("worker image build did not produce hobo-ci-worker:local");
	}
	if (dockerImagePresent(candidate)) {
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
