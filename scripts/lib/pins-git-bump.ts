import { join } from "node:path";
import { type GitPin, isSafeRef, PinsError } from "./pins.ts";
import {
	git,
	gitlinkOf,
	isDirty,
	keepPin,
	must,
	short,
} from "./pins-git-core.ts";
import {
	assertCoherent,
	assertNotAbandoning,
	type GitOptions,
} from "./pins-git-guard.ts";
import { headOf } from "./pins-git-head.ts";
import { terminalHint } from "./pins-git-hint.ts";
import { NOT_SERVED, netGit } from "./pins-git-net.ts";
import { remoteHas } from "./pins-git-probe.ts";

const HEX_REF = /^[0-9a-f]{4,40}$/iu;

function peel(cwd: string, value: string): string | null {
	const result = git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${value}^{commit}`,
	]);
	return result.status === 0 ? result.stdout : null;
}

interface Resolved {
	readonly commit: string;
	readonly served: boolean;
	readonly from: string;
}

function depthFor(sub: string): string[] {
	return git(sub, ["rev-parse", "--is-shallow-repository"]).stdout === "true"
		? ["--depth", "1"]
		: [];
}

function localCommit(
	sub: string,
	ref: string,
	options: GitOptions,
): Resolved | null {
	const local = peel(sub, ref);
	if (local !== null) {
		return {
			commit: local,
			served: false,
			from: "this submodule's objects (which include any --reference clone)",
		};
	}
	const borrowed =
		options.reference === undefined ? null : peel(options.reference, ref);
	if (borrowed === null || options.reference === undefined) return null;
	const lent = netGit(
		sub,
		["fetch", ...depthFor(sub), "--no-tags", options.reference, borrowed],
		options,
		true,
	);
	if (lent.status !== 0) {
		throw new PinsError(
			"GIT_FAILED",
			`fetch from the reference clone failed:\n${lent.stderr}`,
		);
	}
	return {
		commit: borrowed,
		served: false,
		from: `the --reference clone ${options.reference}`,
	};
}

function fetchFromPin(
	sub: string,
	pin: GitPin,
	what: string,
	options: GitOptions,
): Resolved | null {
	const fetched = netGit(
		sub,
		["fetch", ...depthFor(sub), "--no-tags", pin.repo, "--", what],
		options,
	);
	if (fetched.status !== 0) {
		if (NOT_SERVED.test(fetched.stderr)) return null;
		throw new PinsError(
			"GIT_FAILED",
			`fetch of ${what} failed:\n${fetched.stderr}${terminalHint(fetched.stderr)}`,
		);
	}
	const commit = peel(sub, "FETCH_HEAD");
	if (commit === null)
		throw new PinsError("GIT_FAILED", `${what} did not resolve to a commit`);
	return { commit, served: true, from: pin.repo };
}

function resolveCommit(
	sub: string,
	pin: GitPin,
	ref: string,
	options: GitOptions,
): Resolved {
	if (HEX_REF.test(ref)) {
		const here = localCommit(sub, ref, options);
		if (here !== null) return here;
		if (ref.length === 40) {
			const byId = fetchFromPin(sub, pin, ref, options);
			if (byId !== null) return byId;
			throw new PinsError("GIT_FAILED", `${pin.repo} does not serve ${ref}`);
		}
	}
	const names = ref.startsWith("refs/")
		? [ref]
		: [`refs/tags/${ref}`, `refs/heads/${ref}`];
	for (const name of names) {
		const found = fetchFromPin(sub, pin, name, options);
		if (found !== null) return found;
	}
	throw new PinsError(
		"GIT_FAILED",
		HEX_REF.test(ref)
			? `cannot resolve ${ref} to a commit: give a full 40-character id, a branch or a tag, or --reference <a local clone that has it>`
			: `${pin.repo} has no tag or branch named ${ref}`,
	);
}

export interface Bump {
	readonly from: string;
	readonly to: string;
}

export async function bumpPin(
	root: string,
	name: string,
	pin: GitPin,
	ref: string,
	options: GitOptions,
): Promise<Bump> {
	if (!isSafeRef(ref)) {
		throw new PinsError("USAGE", `${ref} is not a commit, branch or tag name`);
	}
	const from = gitlinkOf(root, pin.path);
	assertCoherent(root, pin, options.allowLocal);
	if (headOf(root, pin.path) === null) {
		throw new PinsError(
			"SUBMODULE_STATE",
			`${pin.path} is not fetched; run pnpm run pins:fetch ${name} first`,
		);
	}
	if (isDirty(root, pin.path)) {
		throw new PinsError(
			"SUBMODULE_STATE",
			`${pin.path} has uncommitted changes; commit or discard them first`,
		);
	}
	const sub = join(root, pin.path);
	const here = headOf(root, pin.path);
	const resolved = resolveCommit(sub, pin, ref, options);
	const to = resolved.commit;
	if (!resolved.served && !(await remoteHas(pin.repo, to, options))) {
		throw new PinsError(
			"NOT_PUSHED",
			`${short(to)} exists here (in ${resolved.from}) but ${pin.repo} does not serve it. Push it first, then bump to it`,
		);
	}
	if (here !== null && here !== to) {
		assertNotAbandoning(root, pin, here, to, options.force);
	}
	must(
		sub,
		["checkout", "--quiet", "--detach", to],
		`checkout of ${short(to)}`,
	);
	keepPin(root, pin.path, to);
	must(root, ["add", "--", pin.path], "staging the gitlink");
	return { from, to };
}
