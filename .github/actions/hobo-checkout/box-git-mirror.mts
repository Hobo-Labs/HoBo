import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	INCOMPLETE_MIRROR_REASON,
	isCompleteGitMirror,
} from "../../../scripts/ci/git-mirror-usability.mts";

export type BoxGitMirrorResolution =
	| {
			readonly status: "hit";
			readonly mirror: string;
			readonly insteadOfConfig: string;
	  }
	| { readonly status: "miss"; readonly reason: string };

function validRepository(repository: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

function absoluteCandidate(path: string): string | undefined {
	if (!isAbsolute(path) || path.includes("\0")) return undefined;
	const parts = path.split(/[\\/]+/);
	if (parts.includes("..")) return undefined;
	return resolve(path);
}

function git(path: string, args: readonly string[]): boolean {
	const result = spawnSync("git", [`--git-dir=${path}`, ...args], {
		stdio: "ignore",
	});
	return result.status === 0;
}

function usableMirror(path: string, sha: string): boolean {
	try {
		if (!statSync(path).isDirectory()) return false;
	} catch {
		return false;
	}
	if (!isCompleteGitMirror(path)) return false;
	const bareCheck = spawnSync(
		"git",
		[`--git-dir=${path}`, "rev-parse", "--is-bare-repository"],
		{ encoding: "utf8" },
	);
	const bare =
		(bareCheck.status === 0 && bareCheck.stdout.trim() === "true") ||
		(existsSync(join(path, "objects")) && existsSync(join(path, "HEAD")));
	return bare && git(path, ["cat-file", "-e", `${sha}^{commit}`]);
}

export function boxGitMirrorInsteadOfConfig(
	mirror: string,
	repository: string,
): string {
	const absolute = absoluteCandidate(mirror);
	if (!absolute) {
		throw new Error("mirror must be an absolute path without '..' segments");
	}
	if (!validRepository(repository)) {
		throw new Error("repository must have the form owner/name");
	}
	const mirrorUrl = pathToFileURL(absolute).href;
	return `[url "${mirrorUrl}"]\n    insteadOf = https://github.com/${repository}\n    insteadOf = https://github.com/${repository}.git\n`;
}

function mirrorCandidates(
	env: NodeJS.ProcessEnv,
	repository: string,
): readonly string[] {
	const configured = env.HOBO_CI_GIT_MIRROR?.trim();
	const root = env.HOBO_CI_GIT_MIRROR_ROOT?.trim();
	const fromRoot = root ? join(root, `${repository}.git`) : undefined;
	if (configured || fromRoot) {
		return [...(configured ? [configured] : []), ...(fromRoot ? [fromRoot] : [])];
	}
	return [
		`/var/lib/hobo-ci/git/${repository}.git`,
		`/opt/hobo/ci/git/${repository}.git`,
	];
}

export function resolveBoxGitMirror(
	env: NodeJS.ProcessEnv = process.env,
	extraSearchPaths: readonly string[] = [],
): BoxGitMirrorResolution {
	const repository = env.GITHUB_REPOSITORY ?? "";
	const sha = env.GITHUB_SHA ?? "";
	if (!validRepository(repository)) {
		return { status: "miss", reason: "invalid or missing GITHUB_REPOSITORY" };
	}
	if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(sha)) {
		return { status: "miss", reason: "invalid or missing GITHUB_SHA" };
	}

	const configured = env.HOBO_CI_GIT_MIRROR?.trim();
	if (configured && !absoluteCandidate(configured)) {
		return {
			status: "miss",
			reason: "HOBO_CI_GIT_MIRROR must be absolute and contain no '..' segments",
		};
	}
	const candidates = [...mirrorCandidates(env, repository), ...extraSearchPaths];
	let lastReason = "no candidate mirror exists";
	for (const candidate of candidates) {
		const absolute = absoluteCandidate(candidate);
		if (!absolute) {
			lastReason = `rejected non-absolute or traversing candidate ${candidate}`;
			continue;
		}
		if (!existsSync(absolute)) continue;
		let canonical: string;
		try {
			canonical = realpathSync(absolute);
		} catch {
			lastReason = `cannot resolve mirror ${absolute}`;
			continue;
		}
		if (!isCompleteGitMirror(canonical)) {
			lastReason = `${INCOMPLETE_MIRROR_REASON}: ${canonical}`;
			continue;
		}
		if (!usableMirror(canonical, sha)) {
			lastReason = `mirror does not contain the triggering commit: ${canonical}`;
			continue;
		}
		return {
			status: "hit",
			mirror: canonical,
			insteadOfConfig: boxGitMirrorInsteadOfConfig(canonical, repository),
		};
	}
	return { status: "miss", reason: lastReason };
}

function runCli(args: readonly string[]): void {
	const writeConfigIndex = args.indexOf("--write-config");
	const configPath =
		writeConfigIndex >= 0 ? args[writeConfigIndex + 1] : undefined;
	if (writeConfigIndex >= 0 && !configPath) {
		console.log("hobo_ci_git_mirror=miss reason=--write-config requires a path");
		return;
	}
	try {
		const resolution = resolveBoxGitMirror();
		if (resolution.status === "miss") {
			console.log(
				`hobo_ci_git_mirror=miss reason=${resolution.reason.replace(/[\r\n]+/g, " ")}`,
			);
			return;
		}
		if (configPath) writeFileSync(configPath, resolution.insteadOfConfig, "utf8");
		console.log(`hobo_ci_git_mirror=hit mirror=${resolution.mirror}`);
		console.log(resolution.insteadOfConfig.trimEnd());
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.log(
			`hobo_ci_git_mirror=miss reason=${reason.replace(/[\r\n]+/g, " ")}`,
		);
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	runCli(process.argv.slice(2));
}
