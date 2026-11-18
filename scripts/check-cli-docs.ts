import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CANONICAL_VERBS,
	CLI_IMPLEMENTATION_REFERENCES,
	RETIRED_CLI_ALIASES,
} from "../packages/cli/src/shell/verbs.js";

const DEFAULT_SCAN_PATHS = ["docs", "README.md", "CLAUDE.md"];

type CliSpec = {
	verbs: ReadonlyArray<{
		name: string;
		role: string;
		summary: string;
		implementationIssues: readonly string[];
	}>;
	retiredAliases: ReadonlyArray<{ name: string; replacement: string }>;
};

type CliDocProblem = {
	file: string;
	line: number;
	command: string;
	message: string;
};

type CheckCliDocsOptions = {
	root: string;
	files?: string[] | undefined;
};

export async function loadCliSpec(_root: string): Promise<CliSpec> {
	return {
		verbs: CANONICAL_VERBS.map((verb) => ({
			...verb,
			implementationIssues: CLI_IMPLEMENTATION_REFERENCES[verb.name],
		})),
		retiredAliases: RETIRED_CLI_ALIASES,
	};
}

export async function checkCliDocs(
	{ root, files }: CheckCliDocsOptions = {} as CheckCliDocsOptions,
) {
	const spec = await loadCliSpec(root);
	const targetFiles = files ?? (await collectMarkdownFiles(root));
	const problems: CliDocProblem[] = [];

	for (const file of targetFiles) {
		const absolute = path.isAbsolute(file) ? file : path.join(root, file);
		const content = await readFile(absolute, "utf8");
		problems.push(
			...lintMarkdownContent(path.relative(root, absolute), content, spec),
		);
	}

	return { problems };
}

export function lintMarkdownContent(
	file: string,
	content: string,
	spec: CliSpec,
) {
	const allowed = new Set(spec.verbs.map((verb) => verb.name));
	const retired = new Map(
		spec.retiredAliases.map((alias): [string, string] => [
			alias.name,
			alias.replacement,
		]),
	);
	const problems: CliDocProblem[] = [];
	let inFence = false;

	content.split(/\r?\n/).forEach((line, index) => {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			return;
		}

		const commandLines = inFence
			? [line]
			: [
					...[...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
					...(/^\s*(?:[-*+]\s+)?(?:[$>]\s*)?(?:npx\s+)?hobo\s/u.test(line)
						? [line]
						: []),
				];
		for (const commandLine of commandLines)
			problems.push(
				...lintCommandsInLine(file, index + 1, commandLine, allowed, retired),
			);

		if (/^\s*cli\/\s+@hobo\/cli\s+hobo\s+/u.test(line)) {
			const [, summary] = line.match(/@hobo\/cli\s+hobo\s+([^`\r\n]+)/u) ?? [];
			if (summary) {
				const commands = summary
					.split("|")
					.map((part) => part.trim().split(/\s+/)[0]!)
					.filter(Boolean);

				for (const command of commands) {
					addProblemIfInvalid({
						problems,
						file,
						line: index + 1,
						command: `hobo ${command}`,
						verb: command,
						allowed,
						retired,
					});
				}
			}
		}
	});

	return problems;
}

function lintCommandsInLine(
	file: string,
	lineNumber: number,
	line: string,
	allowed: Set<string>,
	retired: Map<string, string>,
) {
	const problems: CliDocProblem[] = [];
	const commandPattern = /(?:^|[\s;&|])(?:npx\s+)?hobo\s+([a-z][a-z-]*)\b/g;
	let match;

	while ((match = commandPattern.exec(line)) !== null) {
		const verb = match[1]!;
		addProblemIfInvalid({
			problems,
			file,
			line: lineNumber,
			command: `hobo ${verb}`,
			verb,
			allowed,
			retired,
		});
	}

	return problems;
}

function addProblemIfInvalid({
	problems,
	file,
	line,
	command,
	verb,
	allowed,
	retired,
}: {
	problems: CliDocProblem[];
	file: string;
	line: number;
	command: string;
	verb: string;
	allowed: Set<string>;
	retired: Map<string, string>;
}) {
	if (retired.has(verb)) {
		problems.push({
			file,
			line,
			command,
			message: `retired command; use hobo ${retired.get(verb)}`,
		});
		return;
	}

	if (!allowed.has(verb)) {
		problems.push({
			file,
			line,
			command,
			message: "unknown hobo command",
		});
	}
}

async function collectMarkdownFiles(root: string) {
	const files: string[] = [];

	for (const scanPath of DEFAULT_SCAN_PATHS) {
		const absolute = path.join(root, scanPath);
		if (scanPath.endsWith(".md")) {
			files.push(scanPath);
			continue;
		}

		files.push(...(await walkMarkdown(root, absolute)));
	}

	return files;
}

async function walkMarkdown(root: string, dir: string): Promise<string[]> {
	const found: string[] = [];

	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "archive") continue;
			found.push(...(await walkMarkdown(root, absolute)));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			found.push(path.relative(root, absolute));
		}
	}

	return found;
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const result = await checkCliDocs({ root });

	if (result.problems.length > 0) {
		for (const problem of result.problems) {
			console.error(
				`${problem.file}:${problem.line} ${problem.command} - ${problem.message}`,
			);
		}
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
