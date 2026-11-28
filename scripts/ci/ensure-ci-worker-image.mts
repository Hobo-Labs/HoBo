#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Resolve a digest-pinned hobo-ci-worker image for release OCI builds.
 * Prefers ghcr.io/hobo-ci-worker:${ciRunnerImageVersion}; avoids build.sh on release.
 */
import {
	appendFileSync,
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

type PullRequestEvent = Readonly<{
	pull_request?: Readonly<{
		number?: number;
		head?: Readonly<{ repo?: Readonly<{ full_name?: string }> }>;
		base?: Readonly<{ repo?: Readonly<{ full_name?: string }> }>;
	}>;
}>;

function pullRequestEvent(): PullRequestEvent | null {
	if (process.env.GITHUB_EVENT_NAME !== "pull_request") return null;
	const path = process.env.GITHUB_EVENT_PATH;
	if (!path) return null;
	try {
		const payload: PullRequestEvent | null = JSON.parse(
			readFileSync(path, "utf8"),
		);
		return payload;
	} catch {
		return null;
	}
}

export function sameRepositoryPullRequest(): boolean {
	const pullRequest = pullRequestEvent()?.pull_request;
	const head = pullRequest?.head?.repo?.full_name;
	const base = pullRequest?.base?.repo?.full_name;
	return Boolean(head && base && head === base);
}

export function sameRepositoryPullRequestNumber(): number | null {
	if (!sameRepositoryPullRequest()) return null;
	const number = pullRequestEvent()?.pull_request?.number;
	return number !== undefined && Number.isSafeInteger(number) && number > 0
		? number
		: null;
}

export function pullRequestWorkerTag(
	repo: string,
	pullRequest: number,
	version: string,
): string {
	return `ghcr.io/${repo.toLowerCase()}/hobo-ci-worker:pr-${pullRequest}-${version}`;
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

export function dockerLoginGhcr(
	actor: string,
	token: string,
	timeoutMs?: number,
): boolean {
	if (!token) return false;
	const login = spawnSync(
		"docker",
		["login", "ghcr.io", "-u", actor, "--password-stdin"],
		{ input: token, stdio: ["pipe", "inherit", "inherit"], timeout: timeoutMs },
	);
	return login.status === 0;
}

export function remoteWorkerTag(repo: string, version: string): string {
	return `ghcr.io/${repo.toLowerCase()}/hobo-ci-worker:${version}`;
}

export const DEFAULT_WORKER_PULL_BUDGET_SEC = 540;

export const WORKER_PULL_EXTRACT_BUDGET_SEC = 150;

function pullLogHasFetchedLayers(logPath: string): boolean {
	let fd: number;
	try {
		fd = openSync(logPath, "r");
	} catch {
		return false;
	}
	const buf = Buffer.alloc(64 * 1024);
	let carry = "";
	try {
		while (true) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			const window = carry + buf.toString("utf8", 0, n);
			if (
				window.includes("Download complete") ||
				window.includes("Pull complete")
			) {
				return true;
			}
			carry = window.slice(-"Download complete".length);
		}
		return false;
	} finally {
		closeSync(fd);
	}
}

type TimedDockerPull = Readonly<{
	status: number | null;
	downloaded: boolean;
}>;

function runTimedDockerPull(
	remote: string,
	budgetSec: number,
): TimedDockerPull {
	const dir = mkdtempSync(join(tmpdir(), "hobo-worker-pull-"));
	const logPath = join(dir, "pull.log");
	try {
		const status = spawnSync(
			"bash",
			[
				"-c",
				'set -o pipefail; timeout "$1" docker pull "$2" 2>&1 | tee "$3"',
				"bash",
				String(budgetSec),
				remote,
				logPath,
			],
			{ cwd: root, stdio: "inherit" },
		).status;
		return {
			status,
			downloaded: status === 124 && pullLogHasFetchedLayers(logPath),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function resumeLeftoverWorkerLayers(remote: string): boolean {
	const pinned = /@sha256:[a-f0-9]{64}$/u.test(remote);
	if (pinned && dockerImagePresent(remote)) return true;
	console.log(
		`GHCR pull killed at the shared budget (timeout 124); resuming leftover layers for ${WORKER_PULL_EXTRACT_BUDGET_SEC}s`,
	);
	const pull = runTimedDockerPull(remote, WORKER_PULL_EXTRACT_BUDGET_SEC);
	return pull.status === 0 || (pinned && dockerImagePresent(remote));
}

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

export function selectWorkerRepoDigest(
	repo: string,
	repoDigests: readonly string[],
): string {
	const matches = repoDigests
		.map((entry) => validatedWorkerDigestRef(repo, entry.trim()))
		.filter((ref): ref is string => ref !== null);
	const image = `ghcr.io/${repo.toLowerCase()}/hobo-ci-worker`;
	const [match] = matches;
	if (matches.length === 1 && match !== undefined) return match;
	if (matches.length === 0) {
		throw new Error(
			`local worker digest unavailable for ${image}; no matching RepoDigests entry`,
		);
	}
	throw new Error(
		`local worker digest ambiguous for ${image}; found ${matches.length} matching RepoDigests entries`,
	);
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
		const pull = runTimedDockerPull(remote, Math.ceil(remainingMs / 1000));
		if (pull.status === 0) return true;
		if (pull.status === 124 && pull.downloaded) {
			return resumeLeftoverWorkerLayers(remote);
		}
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function workerManifestLineIsMissing(line: string, remote: string): boolean {
	if (line === "") return false;
	const ref = escapeRegExp(remote);
	if (new RegExp(`^no such manifest:\\s*${ref}\\s*$`, "iu").test(line)) {
		return true;
	}
	if (/^manifest unknown\b/iu.test(line)) return true;
	if (/^Error response from daemon: manifest unknown\b/iu.test(line)) {
		return true;
	}
	if (
		new RegExp(
			`^(?:Error response from daemon: )?manifest for ${ref} not found: manifest unknown\\b`,
			"iu",
		).test(line)
	) {
		return true;
	}
	if (
		new RegExp(
			`^(?:Error response from daemon: )?failed to resolve reference "${ref}": ${ref}: not found\\b`,
			"iu",
		).test(line)
	) {
		return true;
	}
	return (
		/\bMANIFEST_UNKNOWN\b/u.test(line) &&
		!/\b(?:DENIED|UNAUTHORIZED)\b/iu.test(line)
	);
}

export function classifyWorkerManifestInspect(
	status: number | null,
	stderr: string,
	remote: string,
): "present" | "missing" | "unknown" {
	if (status === 0) return "present";
	if (status !== 1 || remote.trim() === "") return "unknown";
	return stderr
		.split(/\r?\n/u)
		.some((line) => workerManifestLineIsMissing(line.trim(), remote))
		? "missing"
		: "unknown";
}

function workerManifestStatus(
	remote: string,
	token: string,
	budgetSec = 45,
): "present" | "missing" | "unknown" {
	if (!token || budgetSec <= 0) return "unknown";
	// GHCR's registry API refuses the raw GITHUB_TOKEN as a bearer, so a curl probe
	// read "absent" for a tag `docker pull` fetched two seconds later (run
	// 43043419831). Ask the Docker CLI, which holds the login made just before.
	const result = spawnSync(
		"timeout",
		[String(budgetSec), "docker", "manifest", "inspect", remote],
		{ encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	return classifyWorkerManifestInspect(
		result.status,
		result.stderr ?? "",
		remote,
	);
}

function workerManifestReachable(remote: string, token: string): boolean {
	return workerManifestStatus(remote, token) === "present";
}

export function ghcrWorkerManifestReachable(
	repo: string,
	version: string,
	token: string,
): boolean {
	return workerManifestReachable(remoteWorkerTag(repo, version), token);
}

const WORKER_PUBLISH_PROBE_BUDGET_SEC = 120;
const PUBLISHED_WORKER_PULL_BUDGET_SEC = DEFAULT_WORKER_PULL_BUDGET_SEC;
const WORKER_DIGEST_CONFIRM_MIN_SEC = 1;

type WorkerPublicationProbe =
	| "pullable"
	| "missing"
	| "manifest-unavailable"
	| "pull-failed"
	| "login-failed"
	| "budget-exhausted";

function probeWorkerPull(
	remote: string,
	budgetSec: number,
): "pullable" | "missing" | "unknown" {
	const result = spawnSync(
		"timeout",
		[String(budgetSec), "docker", "pull", remote],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] },
	);
	if (result.status === 0) return "pullable";
	return classifyWorkerManifestInspect(
		result.status,
		result.stderr ?? "",
		remote,
	) === "missing"
		? "missing"
		: "unknown";
}

function probeWorkerPublication(
	repo: string,
	version: string,
	token: string,
	options?: Readonly<{ deadline?: number; now?: () => number }>,
): WorkerPublicationProbe {
	const now = options?.now ?? Date.now;
	const deadline =
		options?.deadline ?? now() + WORKER_PUBLISH_PROBE_BUDGET_SEC * 1000;
	const actor = process.env.GITHUB_ACTOR?.trim() || "github-actions";
	const loginMs = Math.floor(deadline - now());
	if (loginMs <= 0) return "budget-exhausted";
	if (!dockerLoginGhcr(actor, token, loginMs)) return "login-failed";
	const remote = remoteWorkerTag(repo, version);
	const remainingSec = () => Math.max(0, Math.floor((deadline - now()) / 1000));
	const manifestBudget = Math.min(45, remainingSec());
	if (manifestBudget <= 0) return "budget-exhausted";
	const manifestStatus = workerManifestStatus(remote, token, manifestBudget);
	const pullBudget = options
		? remainingSec()
		: manifestStatus === "present"
			? PUBLISHED_WORKER_PULL_BUDGET_SEC
			: remainingSec();
	if (pullBudget <= 0) return "budget-exhausted";
	const pullStatus = probeWorkerPull(remote, pullBudget);
	if (pullStatus === "pullable") return "pullable";
	if (manifestStatus === "missing" && pullStatus === "missing")
		return "missing";
	return manifestStatus === "unknown" ? "manifest-unavailable" : "pull-failed";
}

export function ghcrWorkerPullable(
	repo: string,
	version: string,
	token: string,
): boolean {
	return probeWorkerPublication(repo, version, token) === "pullable";
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

export function resolveWorkerDigestRefFromPulledImage(
	repo: string,
	version: string,
): string {
	const remote = remoteWorkerTag(repo, version);
	const inspected = spawnSync(
		"docker",
		["image", "inspect", remote, "--format", "{{json .RepoDigests}}"],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	if (inspected.status !== 0) {
		throw new Error(
			`local worker inspect failed for ${remote} (status ${inspected.status ?? "unknown"})`,
		);
	}
	let repoDigests: unknown;
	try {
		repoDigests = JSON.parse(inspected.stdout.trim() || "[]");
	} catch {
		throw new Error(
			`local worker inspect returned invalid RepoDigests JSON for ${remote}`,
		);
	}
	if (!Array.isArray(repoDigests)) {
		throw new Error(
			`local worker inspect returned non-array RepoDigests for ${remote}`,
		);
	}
	return selectWorkerRepoDigest(repo, repoDigests);
}

function workerDigestWaitSleepSec(
	attempt: number,
	remainingSec: number,
	random: () => number,
): number {
	if (remainingSec <= 0) return 0;
	const backoffCap = Math.min(60, 5 * 2 ** Math.min(attempt - 1, 4));
	return Math.min(Math.floor(random() * (backoffCap + 1)) + 5, remainingSec);
}

export function resolveWorkerDigestRefWhenPullable(
	repo: string,
	version: string,
	options?: Readonly<{
		budgetSec?: number;
		now?: () => number;
		random?: () => number;
	}>,
): string {
	const token = ghcrAuthToken();
	if (!repo || !token) {
		throw new Error(
			"resolving the GHCR worker digest requires repository and token",
		);
	}
	const budgetSec = options?.budgetSec ?? workerPullBudgetSec();
	const now = options?.now ?? Date.now;
	const random = options?.random ?? Math.random;
	const deadline = now() + budgetSec * 1000;
	let lastError = "worker image not yet pullable";
	let lastLoginFailure = false;
	let attempt = 0;
	while (now() < deadline) {
		attempt += 1;
		const probe = probeWorkerPublication(repo, version, token, {
			deadline,
			now,
		});
		if (probe === "pullable") {
			lastLoginFailure = false;
			try {
				const imageRef = resolveWorkerDigestRefFromPulledImage(repo, version);
				const digestBudgetSec = Math.min(
					WORKER_PUBLISH_PROBE_BUDGET_SEC,
					Math.max(
						WORKER_DIGEST_CONFIRM_MIN_SEC,
						Math.floor((deadline - now()) / 1000),
					),
				);
				if (
					pullWorkerFromGhcr(imageRef, {
						attempts: 1,
						budgetSec: digestBudgetSec,
						now,
						random,
					})
				) {
					return imageRef;
				}
				lastError = `GHCR pull failed for digest-pinned ref ${imageRef}`;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
		} else if (probe === "login-failed") {
			lastLoginFailure = true;
			lastError = "GHCR login failed while resolving the worker digest";
		} else {
			lastLoginFailure = false;
			lastError = `${remoteWorkerTag(repo, version)} not pullable yet`;
		}
		const remainingSec = Math.floor((deadline - now()) / 1000);
		if (remainingSec <= 0) break;
		const sleepFor = workerDigestWaitSleepSec(attempt, remainingSec, random);
		console.log(
			`worker image wait attempt ${attempt}: ${lastError}; retrying in ${sleepFor}s`,
		);
		spawnSync("sleep", [String(sleepFor)], { stdio: "ignore" });
	}
	if (lastLoginFailure) {
		throw new Error("GHCR login failed while resolving the worker digest");
	}
	throw new Error(
		`timed out after ${budgetSec}s waiting for pullable worker image ${version}: ${lastError}`,
	);
}

export type WorkerMaterializeFailure =
	| Readonly<{
			kind: "pull_failed";
			remote: string;
			budgetSec: number;
	  }>
	| Readonly<{
			kind: "manifest_unavailable";
			remote: string;
			budgetSec: number;
	  }>
	| Readonly<{
			kind: "login_failed";
	  }>;

export type WorkerMaterializeResult =
	| Readonly<{ ok: true; image: string }>
	| Readonly<{ ok: false; failure: WorkerMaterializeFailure | null }>;

function preferWorkerMaterializeFailure(
	current: WorkerMaterializeFailure | null,
	next: WorkerMaterializeFailure,
): WorkerMaterializeFailure {
	if (current?.kind === "pull_failed") return current;
	if (next.kind === "pull_failed" || current === null) return next;
	return current;
}

function tagWorkerImage(remote: string, candidate: string): void {
	run("docker", ["tag", remote, candidate]);
	run("docker", ["tag", remote, "hobo-ci-worker:local"]);
}

export function materializeCiWorkerImageResult(): WorkerMaterializeResult {
	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;
	const repo = process.env.GITHUB_REPOSITORY?.trim();
	const requestedRef = process.env.HOBO_CI_WORKER_IMAGE_REF;
	if (requestedRef !== undefined && !repo)
		throw new Error(
			"GITHUB_REPOSITORY is required with HOBO_CI_WORKER_IMAGE_REF",
		);
	const suppliedDigest =
		requestedRef !== undefined && repo
			? resolveWorkerRemoteRef(repo, version)
			: null;
	if (!suppliedDigest && dockerImagePresent(candidate)) {
		run("docker", ["tag", candidate, "hobo-ci-worker:local"]);
		console.log(`using pinned worker ${candidate}`);
		return { ok: true, image: candidate };
	}

	if (suppliedDigest && dockerImagePresent(suppliedDigest)) {
		tagWorkerImage(suppliedDigest, candidate);
		console.log(`using local worker digest ${suppliedDigest}`);
		return { ok: true, image: candidate };
	}

	const event = process.env.GITHUB_EVENT_NAME ?? "";
	const token = ghcrAuthToken();
	const actor = process.env.GITHUB_ACTOR?.trim() || "github-actions";
	const mayPullFromGhcr =
		Boolean(repo) &&
		Boolean(token) &&
		(event !== "pull_request" || sameRepositoryPullRequest()) &&
		process.env.HOBO_CI_SKIP_GHCR_PULL !== "1";

	if (mayPullFromGhcr && repo) {
		const sources = [resolveWorkerRemoteRef(repo, version)];
		const pullRequest = sameRepositoryPullRequestNumber();
		if (
			pullRequest !== null &&
			process.env.HOBO_CI_WORKER_IMAGE_REF === undefined
		)
			sources.push(pullRequestWorkerTag(repo, pullRequest, version));
		if (!dockerLoginGhcr(actor, token))
			return { ok: false, failure: { kind: "login_failed" } };
		let failure: WorkerMaterializeFailure | null = null;
		for (const remote of sources) {
			const manifestReachable = workerManifestReachable(remote, token);
			console.log(
				`GHCR manifest ${manifestReachable ? "present" : "absent or unreadable"} for ${remote}`,
			);
			const shortenForNextSource = !manifestReachable && sources.length > 1;
			const budgetSec = shortenForNextSource
				? Math.min(workerPullBudgetSec(), 45)
				: workerPullBudgetSec();
			if (
				pullWorkerFromGhcr(
					remote,
					shortenForNextSource ? { attempts: 1, budgetSec } : undefined,
				)
			) {
				tagWorkerImage(remote, candidate);
				console.log(`pulled worker ${remote}`);
				return { ok: true, image: candidate };
			}
			console.error(`GHCR pull failed for ${remote}`);
			failure = preferWorkerMaterializeFailure(failure, {
				kind: manifestReachable ? "pull_failed" : "manifest_unavailable",
				remote,
				budgetSec,
			});
		}
		return { ok: false, failure };
	}
	return { ok: false, failure: null };
}

export function materializeCiWorkerImageOnly(): string | null {
	const result = materializeCiWorkerImageResult();
	return result.ok ? result.image : null;
}

export function ensureCiWorkerImage(): string {
	const materialized = materializeCiWorkerImageResult();
	if (materialized.ok) return materialized.image;

	const version = ciRunnerImageVersion(root);
	const candidate = `hobo-ci-worker:${version}`;

	if (
		releaseWorkerEnsurePath() ||
		process.env.HOBO_CI_WORKER_IMAGE_REF !== undefined
	) {
		const { failure } = materialized;
		const reason = releaseWorkerEnsurePath()
			? `release path requires published ghcr.io worker ${version}`
			: "supplied worker digest requires a matching published image";
		if (failure?.kind === "login_failed") {
			throw new Error(`GHCR login failed; ${reason}; refusing build.sh`);
		}
		if (failure?.kind === "pull_failed") {
			throw new Error(
				`GHCR manifest present for ${failure.remote} but pull failed (budgetSec=${failure.budgetSec}); ${reason}; refusing build.sh (avoids playwright CDN rebuild)`,
			);
		}
		if (failure?.kind === "manifest_unavailable") {
			throw new Error(
				`GHCR manifest absent or unreadable for ${failure.remote} and pull failed (budgetSec=${failure.budgetSec}); ${reason}; refusing build.sh (avoids playwright CDN rebuild)`,
			);
		}
		throw new Error(
			`${reason}; refusing build.sh (avoids playwright CDN rebuild)`,
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
	readonly ghcrProbe: WorkerPublicationProbe;
}

/**
 * Whether this tree's worker image (by content key) is on this host and in GHCR.
 * The publisher in ci-deps-publish.yml asks this after every green main run,
 * because a main push whose CI run was dropped never built or published the
 * image its commits needed (finding 113).
 */
export function ciWorkerImagePublished(options?: {
	now?: () => number;
}): CiWorkerImagePresence {
	const version = ciRunnerImageVersion(root);
	const host = dockerImagePresent(`hobo-ci-worker:${version}`);
	const repo = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	const token = ghcrAuthToken();
	const ghcrProbe =
		repo && token
			? probeWorkerPublication(
					repo,
					version,
					token,
					options?.now === undefined ? undefined : { now: options.now },
				)
			: "login-failed";
	return { version, host, ghcr: ghcrProbe === "pullable", ghcrProbe };
}

function main(): void {
	if (process.argv.includes("--resolve-digest")) {
		const repo = process.env.GITHUB_REPOSITORY?.trim() ?? "";
		const version = ciRunnerImageVersion(root);
		const imageRef = resolveWorkerDigestRefWhenPullable(repo, version);
		console.log(imageRef);
		const out = process.env.GITHUB_OUTPUT;
		if (out) {
			appendFileSync(out, `image_ref=${imageRef}\nversion=${version}\n`);
		}
		return;
	}
	if (process.argv.includes("--published-status")) {
		const status = ciWorkerImagePublished();
		if (
			status.ghcrProbe === "pull-failed" ||
			status.ghcrProbe === "login-failed" ||
			status.ghcrProbe === "manifest-unavailable" ||
			status.ghcrProbe === "budget-exhausted"
		) {
			throw new Error(
				`worker image publication check inconclusive (${status.ghcrProbe}); refusing to rebuild`,
			);
		}
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
