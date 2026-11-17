import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCliDocs } from "./check-cli-docs.ts";
import { checkCompetitorDocs } from "./check-competitor-docs.ts";
import {
	checkDocumentationLinks,
	isMaintainedDocumentation,
} from "./check-documentation-links.ts";
import { reachRemedy } from "./lib/base-ref.ts";
import { GIT_OUTPUT_MAX_BUFFER } from "./lib/git-output.ts";

type Problem = {
	file: string;
	line: number;
	code?: string;
	command?: string;
	message: string;
};

const args = new Set(process.argv.slice(2));
const baseArg = process.argv.find((arg) => arg.startsWith("--base="));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base =
	baseArg?.slice("--base=".length) ??
	process.env.HOBO_LINT_BASE ??
	"origin/main";
const staged = args.has("--staged");
const all = args.has("--all");

function tryCapture(
	command: string,
	commandArgs: string[],
): string | undefined {
	const result = spawnSync(command, commandArgs, {
		encoding: "utf8",
		shell: false,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

function splitFiles(output: string) {
	return output
		.split(/\r?\n/)
		.map((file) => file.trim().split(path.sep).join("/"))
		.filter(Boolean);
}

function listing(
	commandArgs: string[],
	failure: string,
	remedy = "",
): string[] {
	const listed = tryCapture("git", commandArgs);
	if (listed !== undefined) return splitFiles(listed);
	console.error(
		`fail  lint:docs — ${failure}, so no docs linter ran.${remedy && ` ${remedy}`}`,
	);
	process.exit(2);
}

function changedFiles() {
	if (all) return listing(["ls-files"], "git could not list the tracked files");
	if (staged) {
		return listing(
			["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
			"git could not list the staged files",
		);
	}
	const mergeBase = tryCapture("git", ["merge-base", base, "HEAD"]) || base;
	return listing(
		["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"],
		`git could not diff against ${base}`,
		reachRemedy(base),
	);
}

function isMarkdown(file: string) {
	return file.endsWith(".md") && !file.includes("/node_modules/");
}

function cliFiles(markdownFiles: string[]) {
	if (markdownFiles.includes("docs/design/cli-spec.md")) return undefined;
	return markdownFiles.filter((file) => {
		return (
			file === "README.md" ||
			file === "CLAUDE.md" ||
			file.startsWith("docs/design/")
		);
	});
}

function competitorTouched(markdownFiles: string[]) {
	return markdownFiles.some((file) => file.startsWith("docs/competitors/"));
}

function printProblems(label: string, problems: Problem[]) {
	for (const problem of problems) {
		const target = problem.command ?? problem.code ?? label;
		console.error(
			`${problem.file}:${problem.line} ${target} - ${problem.message}`,
		);
	}
}

const files = changedFiles();
const markdownFiles = [...new Set(files.filter(isMarkdown))].sort();

if (markdownFiles.length === 0) {
	console.log("lint: no changed markdown files; skipping docs linters.");
	process.exit(0);
}

const cliTargets = cliFiles(markdownFiles);
const documentationTargets = markdownFiles.filter(isMaintainedDocumentation);
const cliProblems =
	cliTargets?.length === 0
		? []
		: (await checkCliDocs({ root, files: cliTargets })).problems;
const documentationProblems =
	documentationTargets.length === 0
		? []
		: (await checkDocumentationLinks({ root, files: documentationTargets }))
				.problems;
const competitorProblems = competitorTouched(markdownFiles)
	? (await checkCompetitorDocs({ root })).problems
	: [];

console.log(
	[
		`lint: markdown changed=${markdownFiles.length}`,
		`cli=${cliTargets ? cliTargets.length : "full"}`,
		`links=${documentationTargets.length}`,
		`competitors=${competitorTouched(markdownFiles) ? "full" : "skipped"}`,
	].join(" "),
);

printProblems("cli-docs", cliProblems);
printProblems("documentation-links", documentationProblems);
printProblems("competitor-docs", competitorProblems);

if (
	cliProblems.length > 0 ||
	documentationProblems.length > 0 ||
	competitorProblems.length > 0
) {
	process.exit(1);
}
