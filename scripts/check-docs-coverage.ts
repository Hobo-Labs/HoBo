import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_FILES = [
	"README.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	"CODE_OF_CONDUCT.md",
	"SUPPORT.md",
	"AGENTS.md",
	"docs/index.md",
	"docs/design/index.md",
	"docs/agent-tooling.md",
	"src/draft/README.md",
	".github/pull_request_template.md",
];

const REQUIRED_README_PATTERNS: [RegExp, string][] = [
	[/## Why HoBo exists/, "README must explain why the project exists"],
	[/## Repository map/, "README must include a repository map"],
	[/## How to work in this repo/, "README must include local workflow"],
	[
		/## Documentation maintenance policy/,
		"README must document docs maintenance policy",
	],
	[/## CI and gates/, "README must describe CI and gates"],
	[/## AI agent workflow/, "README must describe agent workflow"],
];

const REQUIRED_CONTRIBUTING_PATTERNS: [RegExp, string][] = [
	[/## Required local checks/, "CONTRIBUTING must list required local checks"],
	[/## Documentation rule/, "CONTRIBUTING must state docs-update rule"],
	[/## Pull request expectations/, "CONTRIBUTING must state PR expectations"],
];

function read(root: string, file: string) {
	return fs.readFileSync(path.join(root, file), "utf8");
}

function checkPatterns({
	problems,
	file,
	content,
	patterns,
}: {
	problems: string[];
	file: string;
	content: string;
	patterns: [RegExp, string][];
}) {
	for (const [pattern, message] of patterns) {
		if (!pattern.test(content)) {
			problems.push(`${file}: ${message}`);
		}
	}
}

export function checkDocsCoverage(root: string) {
	const problems: string[] = [];

	for (const file of REQUIRED_FILES) {
		const absolute = path.join(root, file);
		if (!fs.existsSync(absolute)) {
			problems.push(`${file}: required maintenance/community doc is missing`);
		}
	}

	if (fs.existsSync(path.join(root, "README.md"))) {
		checkPatterns({
			problems,
			file: "README.md",
			content: read(root, "README.md"),
			patterns: REQUIRED_README_PATTERNS,
		});
	}

	if (fs.existsSync(path.join(root, "CONTRIBUTING.md"))) {
		checkPatterns({
			problems,
			file: "CONTRIBUTING.md",
			content: read(root, "CONTRIBUTING.md"),
			patterns: REQUIRED_CONTRIBUTING_PATTERNS,
		});
	}

	return problems;
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const problems = checkDocsCoverage(root);

	for (const problem of problems) {
		console.error(problem);
	}

	if (problems.length > 0) {
		process.exitCode = 1;
	} else {
		console.log("docs coverage ok");
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
