#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

export function planReason(
	file: string,
	read: () => string,
): string | undefined {
	if (file.startsWith("plans/") || file.startsWith("docs/plans/"))
		return "it is in a plans directory, and the repository keeps none";
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

export function committedPlans(staged: boolean): CommittedPlan[] {
	const files = Array.from(
		new Set(
			git(
				staged
					? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
					: ["ls-files", "-z"],
			)
				.split("\0")
				.filter(Boolean),
		),
	);
	const deleted = staged
		? new Set<string>()
		: new Set(git(["ls-files", "--deleted", "-z"]).split("\0").filter(Boolean));
	return files
		.filter((file) => !deleted.has(file))
		.flatMap((file) => {
			const reason = planReason(file, () =>
				staged || !existsSync(file)
					? git(["show", `:./${file}`])
					: readFileSync(file, "utf8"),
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
	console.error("Finish the work and remove planning or design documents.");
	return 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	process.exit(main(process.argv.slice(2)));
