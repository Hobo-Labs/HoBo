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

export const DEFAULT_WORKER_PULL_BUDGET_SEC = 540;

export function workerPullBudgetSec(
	raw: string | undefined = process.env.HOBO_CI_WORKER_PULL_BUDGET_SEC,
): number {
	if (!raw || !/^\d+$/u.test(raw.trim())) {
		return DEFAULT_WORKER_PULL_BUDGET_SEC;
	}
	const parsed = Number(raw.trim());
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_WORKER_PULL_BUDGET_SEC;
}

export function validatedWorkerDigestRef(
	repo: string,
	ref: string | undefined,
): string | null {
	if (!ref) return null;
	const prefix = `ghcr.io/${repo.toLowerCase()}/hobo-ci-worker@`;
	if (!ref.startsWith(prefix)) return null;
	return /^sha256:[a-f0-9]{64}$/u.test(ref.slice(prefix.length)) ? ref : null;
}

export function resolveWorkerRemoteRef(
	repo: string,
	version: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const suppliedImageRef = env.HOBO_CI_WORKER_IMAGE_REF;
	if (suppliedImageRef === undefined) return remoteWorkerTag(repo, version);
	const validatedDigestRef = validatedWorkerDigestRef(repo, suppliedImageRef);
	if (!validatedDigestRef) {
		throw new Error(
			`HOBO_CI_WORKER_IMAGE_REF must be ghcr.io/${repo.toLowerCase()}/hobo-ci-worker@sha256:<64 lowercase hex>; refusing to fall back to the mutable version tag`,
		);
	}
	return validatedDigestRef;
}

export function pullWorkerFromGhcr(
	remote: string,
	options?: Readonly<{
		attempts?: number;
		budgetSec?: number;
		now?: () => number;
		random?: () => number;
	}>,
): boolean {
	const attempts = Math.max(1, Math.floor(options?.attempts ?? 4));
	const budgetSec = options?.budgetSec ?? workerPullBudgetSec();
	const now = options?.now ?? Date.now;
	const random = options?.random ?? Math.random;
	const deadline = now() + budgetSec * 1000;
	for (let i = 1; i <= attempts; i++) {
		const remainingMs = deadline - now();
		if (remainingMs <= 0) break;
		const result = spawnSync(
			"timeout",
			[String(Math.ceil(remainingMs / 1000)), "docker", "pull", remote],
			{
				cwd: root,
				stdio: "inherit",
			},
		);
		if (result.status === 0) return true;
		if (i < attempts) {
			const backoffCap = Math.min(30, 5 * 2 ** (i - 1));
			const backoff = Math.floor(random() * (backoffCap + 1));
			const remainingBeforeSleep = deadline - now();
			const sleepSec = Math.min(
				backoff,
				Math.floor(remainingBeforeSleep / 1000),
			);
			if (sleepSec > 0) {
				console.log(
					`GHCR pull attempt ${i}/${attempts} failed; retrying in ${sleepSec}s`,
				);
				spawnSync("sleep", [String(sleepSec)], { stdio: "ignore" });
			}
		}
	}
	return false;
}

function workerManifestReachable(remote: string, token: string): boolean {
	if (!token) return false;
	// GHCR's registry API refuses the raw GITHUB_TOKEN as a bearer, so a curl probe
	// read "absent" for a tag `docker pull` fetched two seconds later (run
	// 43043419831). Ask the Docker CLI, which holds the login made just before.
	const result = spawnSync(
		"timeout",
		["45", "docker", "manifest", "inspect", remote],
		{ stdio: "ignore" },
	);
	return result.status === 0;
}

export function ghcrWorkerManifestReachable(
	repo: string,
	version: string,
	token: string,
): boolean {
	return workerManifestReachable(remoteWorkerTag(repo, version), token);
}

export function digestFromVerboseManifest(stdout: string): string | null {
	const digests = new Set<string>();
	for (const match of stdout.matchAll(
		/"Descriptor"\s*:\s*\{[^}]*"digest"\s*:\s*"(sha256:[a-f0-9]{64})"/gu,
	)) {
		if (match[1]) digests.add(match[1]);
	}
	const [digest] = digests.size === 1 ? [...digests] : [];
	return digest ?? null;
}

export function resolveWorkerDigestRef(repo: string, version: string): string {
	const token = ghcrAuthToken();
	if (!repo || !token) {
		throw new Error(
			"resolving the GHCR worker digest requires repository and token",
		);
	}
	const actor = process.env.GITHUB_ACTOR?.trim() || "github-actions";
	if (!dockerLoginGhcr(actor, token)) {
		throw new Error("GHCR login failed while resolving the worker digest");
	}
	const remote = remoteWorkerTag(repo, version);
	const inspected = spawnSync(
		"timeout",
		["60", "docker", "manifest", "inspect", "-v", remote],
		{ cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
	);
	if (inspected.status !== 0) {
		throw new Error(
			`GHCR manifest absent or unreadable for ${remote} (inspect status ${inspected.status ?? "unknown"})`,
		);
	}
	const digest = digestFromVerboseManifest(inspected.stdout);
	if (!digest) {
		throw new Error(
			`GHCR manifest digest unavailable for ${remote}; expected one verbose Descriptor digest`,
		);
	}
	return `${remote.slice(0, remote.lastIndexOf(":"))}@${digest}`;
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
		const remote = resolveWorkerRemoteRef(repo, version);
		dockerLoginGhcr(actor, token);
		const manifestOk = workerManifestReachable(remote, token);
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

/** Where this tree's worker image is present. */
export interface CiWorkerImagePresence {
	readonly version: string;
	readonly host: boolean;
	/** False when GHCR said no, and also when the check could not run (no token, login failed). */
	readonly ghcr: boolean;
}

/**
 * Whether this tree's worker image (by content key) is on this host and in GHCR.
 * The publisher in ci-deps-publish.yml asks this after every green main run,
 * because a main push whose CI run was dropped never built or published the
 * image its commits needed (finding 113).
 */
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
	if (process.argv.includes("--resolve-digest")) {
		const repo = process.env.GITHUB_REPOSITORY?.trim() ?? "";
		const version = ciRunnerImageVersion(root);
		const imageRef = resolveWorkerDigestRef(repo, version);
		console.log(imageRef);
		const out = process.env.GITHUB_OUTPUT;
		if (out) {
			appendFileSync(out, `image_ref=${imageRef}\nversion=${version}\n`);
		}
		return;
	}
	if (process.argv.includes("--published-status")) {
		const status = ciWorkerImagePublished();
		console.log(
			`worker ${status.version}: host=${status.host} ghcr=${status.ghcr}`,
		);
		const out = process.env.GITHUB_OUTPUT;
		if (out) {
			appendFileSync(
				out,
				`version=${status.version}\nneeded=${status.host && status.ghcr ? "false" : "true"}\nghcr=${status.ghcr}\n`,
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
