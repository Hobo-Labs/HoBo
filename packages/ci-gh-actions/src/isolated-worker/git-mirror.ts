import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isCompleteGitMirror } from "./git-mirror-usability.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

export type BoxGitMirrorEnsureResult =
	| { readonly status: "hit"; readonly mirror: string }
	| { readonly status: "miss"; readonly reason: string };

export type BoxGitMirror = {
	readonly path: string;
	ensure(sha: string): Promise<BoxGitMirrorEnsureResult>;
};

export type GitRunner = (
	args: readonly string[],
	cwd?: string,
) => Promise<{ status: number; stdout: string; stderr: string }>;

/** Prefer a durable mirror root; fall back when the preferred path is not writable. */
export function resolveGitMirrorRoot(
	preferred: string,
	fallback: string,
	/** Creates a root; a test passes one that fails as an unprivileged user's would. */
	mkdir: (root: string) => void = (root) =>
		mkdirSync(root, { recursive: true, mode: 0o755 }),
): string {
	const tryRoot = (root: string) => {
		if (!isAbsolute(root) || root.split(/[\\/]+/).includes(".."))
			throw new Error(
				"git mirror root must be absolute and contain no '..' segments",
			);
		mkdir(root);
		return root;
	};
	try {
		return tryRoot(preferred);
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		if (!("code" in error)) throw error;
		// SAFETY: only `mkdirSync` is in try; its failures are Node system errors with string `code`.
		const code = (error as Error & { code: string }).code;
		if (code === "EACCES" || code === "EROFS" || code === "EPERM")
			return tryRoot(fallback);
		throw error;
	}
}

export function defaultGitMirrorFallbackRoot(): string {
	const base = process.env.HOBO_HOME?.trim() || homedir();
	return join(resolve(base), ".cache", "hobo-ci", "git");
}

/** Default mirror root on HoBo box workers (writable without `/var/lib`). */
export function defaultGitMirrorPreferredRoot(): string {
	const configured = process.env.HOBO_CI_GIT_MIRROR_ROOT?.trim();
	if (configured) return configured;
	const home = process.env.HOME?.trim() || homedir();
	const user = process.env.USER?.trim() || process.env.LOGNAME?.trim() || "";
	if (home === "/home/box" || user === "box") {
		return join(home, ".cache", "hobo-ci", "git");
	}
	return "/var/lib/hobo-ci/git";
}

const CORRUPT_PACK =
	/unresolved delta|index-pack failed|recoverable delta|bad packed object/i;

function isCorruptPackError(stderr: string): boolean {
	return CORRUPT_PACK.test(stderr);
}

export function boxGitMirrorPath(root: string, repository: string): string {
	if (
		!isAbsolute(root) ||
		root.includes("\0") ||
		root.split(/[\\/]+/).includes("..")
	)
		throw new Error(
			"git mirror root must be absolute and contain no '..' segments",
		);
	if (!REPOSITORY.test(repository))
		throw new Error("repository must have the form owner/name");
	return join(resolve(root), `${repository}.git`);
}

export function shaRef(sha: string): string {
	if (!SHA.test(sha)) throw new Error("invalid git object name");
	return `refs/hobo/sha/${sha.toLowerCase()}`;
}

export function runGit(
	args: readonly string[],
	cwd?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolveResult) => {
		const child = spawn("git", [...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			resolveResult({ status: 1, stdout, stderr: error.message });
		});
		child.on("close", (code) => {
			resolveResult({ status: code ?? 1, stdout, stderr });
		});
	});
}

function originUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

function formatGitFailure(stderr: string): string {
	return stderr.replace(/[\r\n]+/g, " ").trim();
}

export function createBoxGitMirror(options: {
	readonly root: string;
	readonly repository: string;
	readonly originUrl?: string;
	readonly git?: GitRunner;
}): BoxGitMirror {
	const path = boxGitMirrorPath(options.root, options.repository);
	const remote = options.originUrl ?? originUrl(options.repository);
	const git = options.git ?? runGit;
	let chain: Promise<unknown> = Promise.resolve();

	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = chain.then(work, work);
		chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async function hasCommit(sha: string): Promise<boolean> {
		const checked = await git([
			`--git-dir=${path}`,
			"cat-file",
			"-e",
			`${sha}^{commit}`,
		]);
		return checked.status === 0;
	}

	async function stripPartialCloneMarkers(): Promise<void> {
		await git([
			`--git-dir=${path}`,
			"config",
			"--unset-all",
			"remote.origin.promisor",
		]);
		await git([
			`--git-dir=${path}`,
			"config",
			"--unset-all",
			"extensions.partialclonefilter",
		]);
	}

	/**
	 * Whether the mirror holds every object of the commit's tree, so a job can
	 * check it out from here alone. Having the commit is not enough: a mirror
	 * that began as a blobless clone keeps its commits and lacks their files,
	 * and a job's fetch from it then dies reaching for blobs that are not there.
	 */
	async function servesCheckout(sha: string): Promise<boolean> {
		const walked = await git([
			`--git-dir=${path}`,
			"rev-list",
			"--objects",
			"--no-walk",
			"--missing=print",
			sha,
		]);
		return walked.status === 0 && !/^\?/m.test(walked.stdout);
	}

	/**
	 * `refetch` is for repairing a blobless mirror: without it the fetch is a
	 * no-op, because the mirror already has every commit, so the server sends
	 * nothing and the missing blobs never arrive.
	 */
	async function refreshMain(
		refetch = false,
	): Promise<BoxGitMirrorEnsureResult | undefined> {
		const fetched = await git([
			`--git-dir=${path}`,
			"-c",
			"gc.auto=0",
			"fetch",
			"--no-tags",
			"--no-filter",
			...(refetch ? ["--refetch"] : []),
			"origin",
			"+refs/heads/main:refs/heads/main",
		]);
		if (fetched.status !== 0) {
			return {
				status: "miss",
				reason: `main ref refresh failed: ${formatGitFailure(fetched.stderr)}`,
			};
		}
		return undefined;
	}

	async function ensureCompleteMirror(): Promise<
		BoxGitMirrorEnsureResult | undefined
	> {
		if (!existsSync(path) || isCompleteGitMirror(path)) return undefined;
		await stripPartialCloneMarkers();
		const repaired = await refreshMain(true);
		if (repaired) return repaired;
		if (!isCompleteGitMirror(path)) {
			return {
				status: "miss",
				reason: "mirror is incomplete after repair (promisor/partial clone)",
			};
		}
		return undefined;
	}

	async function cloneBare(): Promise<BoxGitMirrorEnsureResult | undefined> {
		mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
		const cloned = await git([
			"clone",
			"--bare",
			"--origin",
			"origin",
			remote,
			path,
		]);
		if (cloned.status !== 0) {
			return {
				status: "miss",
				reason: `clone failed: ${formatGitFailure(cloned.stderr)}`,
			};
		}
		await git([`--git-dir=${path}`, "config", "gc.auto", "0"]);
		return refreshMain();
	}

	async function recloneMirror(
		reason: string,
	): Promise<BoxGitMirrorEnsureResult | undefined> {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			return {
				status: "miss",
				reason: `re-clone failed after ${reason}: could not remove ${path}`,
			};
		}
		return cloneBare();
	}

	async function ensureMirror(): Promise<BoxGitMirrorEnsureResult | undefined> {
		if (existsSync(path)) {
			await git([`--git-dir=${path}`, "config", "gc.auto", "0"]);
			return ensureCompleteMirror();
		}
		return cloneBare();
	}

	async function fetchSha(sha: string): Promise<BoxGitMirrorEnsureResult> {
		const prepared = await ensureMirror();
		if (prepared?.status === "miss") return prepared;

		let refreshed = await refreshMain();
		if (refreshed?.status === "miss" && isCorruptPackError(refreshed.reason)) {
			const recloned = await recloneMirror("main ref refresh");
			if (recloned?.status === "miss") return recloned;
			refreshed = await refreshMain();
		}
		if (refreshed) return refreshed;

		if (!(await hasCommit(sha))) {
			const fetched = await git([
				`--git-dir=${path}`,
				"-c",
				"gc.auto=0",
				"fetch",
				"--no-tags",
				"--no-filter",
				"origin",
				`${sha}:${shaRef(sha)}`,
			]);
			if (fetched.status !== 0) {
				if (isCorruptPackError(fetched.stderr)) {
					const recloned = await recloneMirror("pack fetch");
					if (recloned?.status === "miss") return recloned;
					const retry = await git([
						`--git-dir=${path}`,
						"-c",
						"gc.auto=0",
						"fetch",
						"--no-tags",
						"--no-filter",
						"origin",
						`${sha}:${shaRef(sha)}`,
					]);
					if (retry.status !== 0) {
						return {
							status: "miss",
							reason: `fetch failed after re-clone: ${formatGitFailure(retry.stderr)}`,
						};
					}
				} else {
					return {
						status: "miss",
						reason: `fetch failed: ${formatGitFailure(fetched.stderr)}`,
					};
				}
			}
		}
		if (!(await hasCommit(sha))) {
			return {
				status: "miss",
				reason: `mirror does not contain the triggering commit: ${path}`,
			};
		}

		if (!(await servesCheckout(sha))) {
			// The commit is here but some of its files are not (finding 101): take
			// the commit again, whole, rather than hand a job a checkout that fails.
			await git([
				`--git-dir=${path}`,
				"-c",
				"gc.auto=0",
				"fetch",
				"--no-tags",
				"--no-filter",
				"--refetch",
				"origin",
				`+${sha}:${shaRef(sha)}`,
			]);
			if (!(await servesCheckout(sha))) {
				return {
					status: "miss",
					reason: `mirror is missing objects of the triggering commit: ${path}`,
				};
			}
		}
		await git([`--git-dir=${path}`, "update-ref", shaRef(sha), sha]);
		return { status: "hit", mirror: path };
	}

	return {
		path,
		ensure(sha) {
			if (!SHA.test(sha)) {
				return Promise.resolve({
					status: "miss",
					reason: "invalid or missing GITHUB_SHA",
				});
			}
			return enqueue(() => fetchSha(sha.toLowerCase()));
		},
	};
}
