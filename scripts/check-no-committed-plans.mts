#!/usr/bin/env node
/**
 * Plans are working documents and are never committed (AGENTS.md, "Plans are
 * not committed"). This gate refuses one that is.
 *
 * A plan is a Markdown file whose frontmatter `type` names a plan, or any file
 * under the root `plans/` folder, which is where planning tools write and which
 * git ignores. A record of what was decided or found (an ADR, a design
 * document, review findings, delivery state) is not a plan.
 *
 * `--staged` checks what is staged for the commit, read from the index, so a
 * forced `git add` is caught. With no flag it checks every tracked file, so a
 * plan committed with the hook skipped still fails the pull request.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { GIT_OUTPUT_MAX_BUFFER } from "./lib/git-output.ts";

function planTypes(): ReadonlySet<string> {
	return new Set([
		"plan",
		"implementation plan",
		"delivery plan",
		"one-shot agent instruction",
	]);
}

/** The frontmatter `type` of a Markdown document, lower-cased, if it has one. */
export function frontmatterType(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") return undefined;
		const match = /^type:\s*(.*?)\s*$/.exec(line);
		if (match?.[1] !== undefined)
			return match[1].replace(/^["']|["']$/g, "").toLowerCase();
	}
	return undefined;
}

/** Why this file is a plan, or undefined when it is not one. */
export function planReason(
	file: string,
	read: () => string,
): string | undefined {
	if (file.startsWith("plans/"))
		return "it is under plans/, the local folder planning tools write to";
	if (!/\.mdx?$/i.test(file)) return undefined;
	const type = frontmatterType(read());
	return type !== undefined && planTypes().has(type)
		? `its frontmatter type is "${type}"`
		: undefined;
}

function git(args: readonly string[]): string {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	if (result.status !== 0)
		throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

export type CommittedPlan = Readonly<{ file: string; reason: string }>;

/** Plans among the staged files (`staged`) or among every tracked file. */
export function committedPlans(staged: boolean): CommittedPlan[] {
	const files = git(
		staged
			? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
			: ["ls-files", "-z"],
	)
		.split("\0")
		.filter(Boolean);
	return files.flatMap((file) => {
		const reason = planReason(file, () =>
			staged ? git(["show", `:${file}`]) : readFileSync(file, "utf8"),
		);
		return reason === undefined ? [] : [{ file, reason }];
	});
}

function main(argv: readonly string[]): number {
	const staged = argv.includes("--staged");
	const found = committedPlans(staged);
	if (found.length === 0) return 0;
	console.error(
		`plans:guard: ${found.length} plan document(s) ${staged ? "staged for commit" : "tracked by git"}. Plans are never committed.`,
	);
	for (const { file, reason } of found) console.error(`  ${file}: ${reason}`);
	console.error(
		"Keep a plan in plans/ (ignored by git) or outside the repository. Commit what was decided as an ADR or design document, not the plan.",
	);
	return 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	process.exit(main(process.argv.slice(2)));
