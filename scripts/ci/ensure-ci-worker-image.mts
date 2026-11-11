#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Resolve a digest-pinned hobo-ci-worker image for release OCI builds.
 * Prefers ghcr.io/hobo-ci-worker:${ciRunnerImageVersion}; avoids build.sh on release.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ciRunnerImageVersion } from "../lib/ci-runner-contract.mts";

const root = join(import.meta.dirname, "..", "..");

export type RunResult = Readonly<{ status: number | null }>;

export function run(cmd: string, args: string[], allowFail = false): number {
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

export function releaseWorkerEnsurePath(): boolean {
	if (process.env.HOBO_RELEASE_VERSION?.trim()) return true;
	const ref = process.env.GITHUB_REF ?? "";
	return ref.startsWith("refs/tags/");
}

function ghcrAuthToken(): string {
	return (
		process.env.GITHUB_TOKEN?.trim() || process.env.GHCR_TOKEN?.trim() || ""
	);
}

export function dockerLoginGhcr(actor: string, token: string): boolean {
	if (!token) return false;
	const login = spawnSync(
		"docker",
		["login", "ghcr.io", "-u", actor, "--password-stdin"],
		{ input: token, stdio: ["pipe", "inherit", "inherit"] },
	);
	return login.status === 0;
}

export function remoteWorkerTag(repo: string, version: string): string {
	return `ghcr.io/${repo.toLowerCase()}/hobo-ci-worker:${version}`;
}

export function pullWorkerFromGhcr(
	remote: string,
	options?: Readonly<{
		attempts?: number;
		perPullTimeoutSec?: number;
	}>,
): boolean {
	const attempts = options?.attempts ?? 3;
	const perPull = options?.perPullTimeoutSec ?? 120;
	for (let i = 1; i <= attempts; i++) {
		const result =
			perPull > 0
				? spawnSync("timeout", [String(perPull), "docker", "pull", remote], {
						cwd: root,
						stdio: "inherit",
					})
				: spawnSync("docker", ["pull", remote], {
						cwd: root,
						stdio: "inherit",
					});
		if (result.status === 0) return true;
		if (i < attempts) {
			const backoff = Math.min(30, 2 ** i);
			spawnSync("sleep", [String(backoff)], { stdio: "ignore" });
		}
	}
	return false;
}

export function ghcrWorkerManifestReachable(
	repo: string,
	version: string,
	token: string,
): boolean {
	if (!token) return false;
	// GHCR's registry API refuses the raw GITHUB_TOKEN as a bearer, so a curl probe
	// read "absent" for a tag `docker pull` fetched two seconds later (run
	// 43043419831). Ask the Docker CLI, which holds the login made just before.
	const result = spawnSync(
		"timeout",
		["45", "docker", "manifest", "inspect", remoteWorkerTag(repo, version)],
		{ stdio: "ignore" },
	);
	return result.status === 0;
}

export function materializeCiWorkerImageOnly(): string | null {
	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;
	if (dockerImagePresent(candidate)) {
		run("docker", ["tag", candidate, "hobo-ci-worker:local"]);
		console.log(`using pinned worker ${candidate}`);
		return candidate;
	}

	const repo = process.env.GITHUB_REPOSITORY?.trim();
	const event = process.env.GITHUB_EVENT_NAME ?? "";
	const token = ghcrAuthToken();
	const actor = process.env.GITHUB_ACTOR?.trim() || "github-actions";
	const mayPullFromGhcr =
		Boolean(repo) &&
		Boolean(token) &&
		(event !== "pull_request" || sameRepositoryPullRequest()) &&
		process.env.HOBO_CI_SKIP_GHCR_PULL !== "1";

	if (mayPullFromGhcr && repo) {
		dockerLoginGhcr(actor, token);
		const remote = remoteWorkerTag(repo, version);
		const manifestOk = ghcrWorkerManifestReachable(repo, version, token);
		if (!manifestOk) {
			console.log(`GHCR manifest absent for ${remote}`);
			return null;
		}
		console.log(`GHCR manifest present for ${remote}`);
		if (pullWorkerFromGhcr(remote)) {
			run("docker", ["tag", remote, candidate]);
			run("docker", ["tag", remote, "hobo-ci-worker:local"]);
			console.log(`pulled worker ${remote}`);
			return candidate;
		}
		console.error(`GHCR pull failed for ${remote}`);
	}
	return null;
}

export function ensureCiWorkerImage(): string {
	const materialized = materializeCiWorkerImageOnly();
	if (materialized) {
		return materialized;
	}

	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;

	if (releaseWorkerEnsurePath()) {
		throw new Error(
			`release path requires published ghcr.io worker ${version}; refusing build.sh (avoids playwright CDN rebuild)`,
		);
	}

	const buildBudgetSec = Number(
		process.env.HOBO_CI_WORKER_BUILD_BUDGET_SEC ?? "600",
	);
	const build = spawnSync(
		"timeout",
		[
			String(buildBudgetSec),
			"bash",
			"packages/ci-gh-actions/deploy/ci-runner/build.sh",
		],
		{ cwd: root, env: process.env, stdio: "inherit" },
	);
	if (build.status !== 0) {
		throw new Error(
			`packages/ci-gh-actions/deploy/ci-runner/build.sh failed or timed out (${build.status})`,
		);
	}
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

/**
 * Whether this tree's worker image (by content key) is on this host and in GHCR.
 * A main push asks this instead of diffing its own commits: a push that waited
 * behind a running one and was dropped carried image-input changes no later
 * push lists, and an image a pull request built on this box was never
 * published. Either way the image this tree needs would be missing.
 */
/** Where this tree's worker image is present. */
export interface CiWorkerImagePresence {
	readonly version: string;
	readonly host: boolean;
	readonly ghcr: boolean;
}

export function ciWorkerImagePublished(): CiWorkerImagePresence {
	const version = ciRunnerImageVersion(root);
	const host = dockerImagePresent(`hobo-ci-worker:${version}`);
	const repo = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	const token = ghcrAuthToken();
	let ghcr = false;
	if (repo && token) {
		const actor = process.env.GITHUB_ACTOR?.trim() || "github-actions";
		ghcr =
			dockerLoginGhcr(actor, token) &&
			ghcrWorkerManifestReachable(repo, version, token);
	}
	return { version, host, ghcr };
}

function main(): void {
	if (process.argv.includes("--published-status")) {
		const status = ciWorkerImagePublished();
		console.log(
			`worker ${status.version}: host=${status.host} ghcr=${status.ghcr}`,
		);
		const out = process.env.GITHUB_OUTPUT;
		if (out) {
			appendFileSync(
				out,
				`needed=${status.host && status.ghcr ? "false" : "true"}\nghcr=${status.ghcr}\n`,
			);
		}
		return;
	}
	if (process.argv.includes("--materialize-only")) {
		const image = materializeCiWorkerImageOnly();
		if (!image) {
			process.exit(2);
		}
		console.log(image);
		return;
	}
	const image = ensureCiWorkerImage();
	console.log(image);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
