import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_PATH = path.join("docs", "design", "cli-spec.md");
const DEFAULT_SCAN_PATHS = [
	path.join("docs", "design"),
	"README.md",
	"CLAUDE.md",
];

type CliSpec = Awaited<ReturnType<typeof loadCliSpec>>;

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

export async function loadCliSpec(root: string) {
	const text = await readFile(path.join(root, SPEC_PATH), "utf8");

	const verbs = parseTableSection(text, "Canonical CLI Verbs").map((row) => ({
		name: cleanCell(row[0]!),
		role: cleanCell(row[1]!),
		implementationIssues: extractIssues(row[3]!),
	}));

	const retiredAliases = parseTableSection(
		text,
		"Retired or Rejected Commands",
	).map((row) => ({
		name: cleanCell(row[0]!),
		replacement: cleanCell(row[1]!),
	}));

	return { verbs, retiredAliases };
}

export async function checkCliDocs(
	// SAFETY: assertion to `{} as CheckCliDocsOptions` is required at this boundary.
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

	content.split(/\r?\n/).forEach((line, index) => {
		if (/^\s*```/.test(line)) {
			return;
		}

		problems.push(
			...lintCommandsInLine(file, index + 1, line, allowed, retired),
		);

		if (line.includes("@hobo/cli") && line.includes("hobo ")) {
			const [, summary] = line.match(/\bhobo\s+([^`\r\n]+)/) ?? [];
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
			found.push(...(await walkMarkdown(root, absolute)));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			found.push(path.relative(root, absolute));
		}
	}

	return found;
}

function parseTableSection(text: string, heading: string) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start === -1) {
		throw new Error(`Missing section: ${heading}`);
	}

	const rows: string[][] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s+/.test(line)) break;
		if (!line.trim().startsWith("|")) continue;
		if (/^\|\s*-+/.test(line)) continue;
		if (/^\|\s*(Verb|Command)\s*\|/.test(line)) continue;
		rows.push(line.split("|").slice(1, -1));
	}

	return rows;
}

function cleanCell(value: string) {
	return value.replace(/`/g, "").trim();
}

function extractIssues(value: string) {
	return [...value.matchAll(/HOBO-\d+/g), ...value.matchAll(/ADR-\d+/g)].map(
		(match) => match[0],
	);
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
