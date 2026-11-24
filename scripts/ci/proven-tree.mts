#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;

export type Git = (
	args: readonly string[],
	env?: Readonly<Record<string, string>>,
) => string | undefined;

export type ProvenTreeBase = Readonly<{ base: string; reason: string }>;

const DESCENDANT_IDENTITY = {
	GIT_AUTHOR_NAME: "HoBo CI",
	GIT_AUTHOR_EMAIL: "ci@hobo.invalid",
	GIT_AUTHOR_DATE: "@0 +0000",
	GIT_COMMITTER_NAME: "HoBo CI",
	GIT_COMMITTER_EMAIL: "ci@hobo.invalid",
	GIT_COMMITTER_DATE: "@0 +0000",
};

export function provenTreeBase(
	input: Readonly<{ proven: string; tree: string; base: string; git: Git }>,
): ProvenTreeBase {
	const { proven, tree, base, git } = input;
	const fallBack = (reason: string): ProvenTreeBase => ({ base, reason });
	if (!SHA.test(proven) || !SHA.test(tree))
		return fallBack("no proven tree was named");
	if (!SHA.test(base)) return fallBack("the merge group base is not known");
	if (
		git(["cat-file", "-e", `${proven}^{commit}`]) === undefined &&
		(git(["fetch", "--no-tags", "--quiet", "origin", proven]) === undefined ||
			git(["cat-file", "-e", `${proven}^{commit}`]) === undefined)
	)
		return fallBack(`the proven commit ${proven} could not be fetched`);
	if (git(["rev-parse", `${proven}^{tree}`]) !== tree)
		return fallBack("the proven commit's tree is not the recorded tree");
	if (git(["merge-base", "--is-ancestor", `${proven}^1`, base]) === undefined)
		return fallBack("the proven commit's base is not in the merge group base");
	const headTree = git(["rev-parse", "HEAD^{tree}"]);
	const head = git(["rev-parse", "HEAD"]);
	if (headTree === undefined || head === undefined)
		return fallBack("the checked-out commit could not be read");
	const descendant = git(
		[
			"commit-tree",
			"--no-gpg-sign",
			headTree,
			"-p",
			head,
			"-p",
			proven,
			"-m",
			`proven-tree delta from ${proven}`,
		],
		DESCENDANT_IDENTITY,
	);
	if (descendant === undefined || !SHA.test(descendant))
		return fallBack("the descendant of the proven commit could not be made");
	if (git(["checkout", "--quiet", "--detach", descendant]) === undefined)
		return fallBack(
			"the descendant of the proven commit could not be checked out",
		);
	return {
		base: proven,
		reason: `HEAD is ${descendant}: the tree of ${head} over ${proven}`,
	};
}

export const runGit: Git = (args, env) => {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: env ? { ...process.env, ...env } : process.env,
		}).trim();
	} catch {
		return undefined;
	}
};

function argument(argv: readonly string[], name: string): string {
	const prefix = `--${name}=`;
	return (
		argv
			.find((entry) => entry.startsWith(prefix))
			?.slice(prefix.length)
			.trim()
			.toLowerCase() ?? ""
	);
}

export function main(argv: readonly string[], git: Git = runGit): string {
	const chosen = provenTreeBase({
		proven: argument(argv, "proven"),
		tree: argument(argv, "tree"),
		base: argument(argv, "base"),
		git,
	});
	console.error(`proven-tree base ${chosen.base || "none"}: ${chosen.reason}`);
	return chosen.base;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.stdout.write(`${main(process.argv.slice(2))}\n`);
}
