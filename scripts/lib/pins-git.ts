/**
 * Git pins: a submodule whose pin is its gitlink.
 *
 * The gitlink in the index is the whole pin, so there is no second copy of the
 * commit id to drift. This module initialises a submodule at exactly that
 * commit (shallow, optionally borrowing objects from a local clone), reports
 * whether the checkout still matches, and moves the gitlink on request.
 *
 * Every git call is an argument vector (no shell), paths and refs follow `--`
 * or are screened first, and nothing here ever prompts for a credential.
 *
 * Erasable TypeScript with node builtins only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type GitPin, PINS_FILE, PinsError } from "./pins.ts";
import {
	git,
	gitlinkOf,
	isDirty,
	isShallow,
	keepPin,
	must,
	Refusal,
	short,
} from "./pins-git-core.ts";
import {
	assertCoherent,
	assertNotAbandoning,
	coherence,
	type GitOptions,
} from "./pins-git-guard.ts";
import { headOf } from "./pins-git-head.ts";
import { terminalHint } from "./pins-git-hint.ts";
import { type NetOptions, netGit, remoteTip } from "./pins-git-net.ts";
import { remoteHas } from "./pins-git-probe.ts";
import { netGitWatched, progressArgs } from "./pins-git-stream.ts";

export { type Bump, bumpPin } from "./pins-git-bump.ts";
export {
	type GitResult,
	git,
	gitlinkOf,
	isDirty,
	MIN_GIT,
	requireGit,
	SPARSE_GIT,
	sameRepo,
	short,
} from "./pins-git-core.ts";
export type { GitOptions } from "./pins-git-guard.ts";
export { headOf } from "./pins-git-head.ts";
export { modulesUrl } from "./pins-gitmodules.ts";

async function updateSubmodule(
	root: string,
	pin: GitPin,
	options: GitOptions,
): Promise<void> {
	const refArgs =
		options.reference === undefined ? [] : ["--reference", options.reference];
	// A person at a terminal sees git's progress as it arrives.
	const progress = progressArgs();
	const update = (depth: boolean) =>
		netGitWatched(
			root,
			[
				"submodule",
				"update",
				"--init",
				...progress,
				...(depth ? ["--depth", "1"] : []),
				...refArgs,
				"--",
				pin.path,
			],
			options,
		);
	const sub = join(root, pin.path);
	// A new clone, or one already shallow, takes only the pinned commit; a full
	// clone a developer made stays full (a depth fetch would make it shallow).
	const shallow = !existsSync(join(sub, ".git")) || isShallow(root, pin.path);
	const first = await update(shallow);
	if (first.status === 0) return;
	// A server that refuses a fetch of an unadvertised commit leaves a shallow
	// clone of the tip: take the full history, then check out the pin.
	if (existsSync(join(sub, ".git"))) {
		const unshallow = isShallow(root, pin.path) ? ["--unshallow"] : [];
		const full = netGit(
			sub,
			[
				"fetch",
				"--no-tags",
				...unshallow,
				pin.repo,
				"+refs/heads/*:refs/remotes/origin/*",
			],
			options,
		);
		if (full.status !== 0) {
			throw new PinsError(
				"GIT_FAILED",
				`full fetch failed:\n${full.stderr}${terminalHint(full.stderr)}`,
			);
		}
	}
	const second = await update(false);
	if (second.status !== 0) {
		throw new PinsError(
			"GIT_FAILED",
			`git submodule update failed for ${pin.path}, shallow and full${terminalHint(`${first.stderr}\n${second.stderr}`)}`,
		);
	}
}

/** The submodule's sparse-checkout paths, or null when it is checked out in full. */
function sparsePaths(sub: string): readonly string[] | null {
	const enabled = git(sub, ["config", "--bool", "core.sparseCheckout"]);
	if (enabled.status !== 0 || enabled.stdout.trim() !== "true") return null;
	const current = git(sub, ["sparse-checkout", "list"]);
	return current.status === 0
		? current.stdout.split("\n").filter(Boolean)
		: null;
}

function sameSet(have: readonly string[], want: readonly string[]): boolean {
	return (
		have.length === want.length && want.every((path) => have.includes(path))
	);
}

/** Cone-mode sparse checkout of exactly the pin's paths; false when already so. */
function applySparse(root: string, pin: GitPin): boolean {
	if (pin.sparse === null) return false;
	const sub = join(root, pin.path);
	const current = git(sub, ["sparse-checkout", "list"]);
	const have =
		current.status === 0 ? current.stdout.split("\n").filter(Boolean) : [];
	const want = [...pin.sparse];
	if (sameSet(have, want)) return false;
	must(
		sub,
		["sparse-checkout", "set", "--cone", "--", ...want],
		"sparse-checkout",
	);
	return true;
}

export interface InitResult {
	readonly kind: "initialised" | "updated" | "already pinned";
	readonly head: string;
	/** The commit HEAD was moved off, when it was moved. */
	readonly was: string | null;
	readonly shallow: boolean;
	readonly sparseChanged: boolean;
}

/** Make the submodule's HEAD the gitlink, fetching only that commit when it can. */
export async function initPin(
	root: string,
	pin: GitPin,
	options: GitOptions,
): Promise<InitResult> {
	const want = gitlinkOf(root, pin.path);
	assertCoherent(root, pin, options.allowLocal);
	const before = headOf(root, pin.path);
	if (before !== null && before !== want && isDirty(root, pin.path)) {
		throw new PinsError(
			"SUBMODULE_STATE",
			`${pin.path} has uncommitted changes; commit or discard them before moving it to ${short(want)}`,
		);
	}
	if (before !== null && before !== want) {
		assertNotAbandoning(root, pin, before, want, options.force);
	}
	if (before !== want) await updateSubmodule(root, pin, options);
	const head = headOf(root, pin.path);
	if (head !== want) {
		throw new PinsError(
			"SUBMODULE_STATE",
			`${pin.path} is at ${head === null ? "nothing" : short(head)} after update; the pin is ${short(want)}`,
		);
	}
	keepPin(root, pin.path, head);
	const sparseChanged = applySparse(root, pin);
	const kind =
		before === want
			? "already pinned"
			: before === null
				? "initialised"
				: "updated";
	return {
		kind,
		head,
		was: before !== null && before !== want ? before : null,
		shallow: isShallow(root, pin.path),
		sparseChanged,
	};
}

export interface GitStatus {
	readonly commit: string;
	readonly problems: readonly string[];
	readonly fixes: readonly string[];
	/** What works but is not what pins:fetch makes: reported, never a failure. */
	readonly warnings: readonly string[];
	readonly warningFixes: readonly string[];
	/** Online only: the tip of the pin's branch. */
	readonly tip: string | null;
}

/** Whether the submodule's HEAD commit has a directory at `path`. */
function inHead(sub: string, path: string): boolean {
	const listed = git(sub, ["ls-tree", "-d", "--name-only", "HEAD", "--", path]);
	return listed.status === 0 && listed.stdout.trim() === path;
}

interface SparseReport {
	readonly kind: "problem" | "warning";
	readonly text: string;
	readonly fix: string;
}

/**
 * The checkout against the pin's sparse cone. A full checkout has every
 * directory (a hosted CI checkout is full), and so has a cone wider than the
 * pin's: each is a warning. A directory of the pin's cone that is not checked
 * out is a failure, because the workspace links what is in it.
 */
function sparseReport(
	root: string,
	name: string,
	pin: GitPin,
): SparseReport | null {
	if (pin.sparse === null) return null;
	const sub = join(root, pin.path);
	const want = pin.sparse.join(" ");
	const fix = `pnpm run pins:fetch ${name}   (checks out the pin's sparse cone: ${want})`;
	const missing = pin.sparse.filter((path) => !existsSync(join(sub, path)));
	// Fetching again checks out the same commit: a directory it does not
	// have is the cone's to drop, or the pin's to move.
	const absent = missing.filter((path) => !inHead(sub, path));
	if (absent.length > 0) {
		return {
			kind: "problem",
			text: `${pin.path} does not have ${absent.join(", ")}, which the pin's sparse cone names, and neither does the pinned commit`,
			fix: `drop ${absent.join(", ")} from ${name}'s "sparse" list in ${PINS_FILE}, or move the pin to a commit that has it: pnpm run pins:bump ${name} <ref>`,
		};
	}
	if (missing.length > 0) {
		return {
			kind: "problem",
			text: `${pin.path} does not have ${missing.join(", ")}, which the pin's sparse cone names`,
			fix,
		};
	}
	const have = sparsePaths(sub);
	if (have === null) {
		return {
			kind: "warning",
			text: `${pin.path} is checked out in full, not as the pin's sparse cone (${want})`,
			fix,
		};
	}
	if (sameSet(have, pin.sparse)) return null;
	return {
		kind: "warning",
		text: `${pin.path} is a sparse checkout of ${have.join(" ")}, not the pin's cone (${want})`,
		fix,
	};
}

/** Offline: gitlink against HEAD, a clean tree, and the repository named the same everywhere. */
export async function statusPin(
	root: string,
	name: string,
	pin: GitPin,
	online: boolean,
	options: NetOptions,
): Promise<GitStatus> {
	const commit = gitlinkOf(root, pin.path);
	const { problems, fixes } = coherence(root, pin, options.allowLocal);
	let head: string | null;
	try {
		head = headOf(root, pin.path);
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			commit,
			problems: [...problems, error.problem],
			fixes: [...fixes, error.fix],
			warnings: [],
			warningFixes: [],
			tip: null,
		};
	}
	const warnings: string[] = [];
	const warningFixes: string[] = [];
	if (head === null) {
		problems.push(`${pin.path} is not fetched`);
		fixes.push(`pnpm run pins:fetch ${name}`);
	} else {
		if (head !== commit) {
			problems.push(
				`${pin.path} is at ${short(head)}, the pin is ${short(commit)}`,
			);
			fixes.push(`pnpm run pins:fetch ${name}   (back to the pin)`);
			fixes.push(
				`pnpm run pins:bump ${name} ${short(head)}   (move the pin to what is checked out)`,
			);
		}
		if (isDirty(root, pin.path)) {
			problems.push(`${pin.path} has uncommitted changes to tracked files`);
			fixes.push(
				`git -C ${pin.path} stash   (keeps them; or commit them there)`,
			);
		}
		const sparse = sparseReport(root, name, pin);
		if (sparse?.kind === "problem") {
			problems.push(sparse.text);
			fixes.push(sparse.fix);
		} else if (sparse?.kind === "warning") {
			warnings.push(sparse.text);
			warningFixes.push(sparse.fix);
		}
	}
	const tip = online ? remoteTip(root, pin.repo, pin.branch, options) : null;
	if (
		online &&
		tip !== commit &&
		!(await remoteHas(pin.repo, commit, options))
	) {
		problems.push(
			`the pinned commit ${short(commit)} is not available from ${pin.repo}`,
		);
		fixes.push(
			`push it, or move the pin to a pushed commit: pnpm run pins:bump ${name} <a pushed ref>`,
		);
	}
	return { commit, problems, fixes, warnings, warningFixes, tip };
}
