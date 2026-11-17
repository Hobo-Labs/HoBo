import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCUMENTATION_PATHS = [
	"docs/index.md",
	"docs/agent-tooling.md",
	"README.md",
	"CLAUDE.md",
	"docs/technologies",
	"docs/competitors",
	"docs/standards",
	"docs/patterns",
];

export function isMaintainedDocumentation(file: string) {
	return DOCUMENTATION_PATHS.some((scanPath) =>
		scanPath.endsWith(".md")
			? file === scanPath
			: file.startsWith(`${scanPath}/`),
	);
}

type DocumentationLinkProblem = {
	code: string;
	file: string;
	line: number;
	message: string;
	target?: string;
};

type CheckDocumentationLinksOptions = {
	root: string;
	files?: string[] | undefined;
};

export async function checkDocumentationLinks({
	root,
	files,
}: CheckDocumentationLinksOptions) {
	const targetFiles = files ?? (await collectMarkdownFiles(root));
	const markdownByFile = new Map<string, string>();
	const anchorsByFile = new Map<string, Set<string>>();
	const problems: DocumentationLinkProblem[] = [];

	for (const file of targetFiles) {
		const absolute = path.isAbsolute(file) ? file : path.join(root, file);
		const relative = normalizePath(path.relative(root, absolute));
		const content = await readFile(absolute, "utf8");
		markdownByFile.set(relative, content);
		anchorsByFile.set(relative, extractAnchors(content));
	}

	for (const [file, content] of markdownByFile) {
		problems.push(
			...checkRelativeLinks({ root, file, content, anchorsByFile }),
		);
	}

	return { problems };
}

function checkRelativeLinks({
	root,
	file,
	content,
	anchorsByFile,
}: {
	root: string;
	file: string;
	content: string;
	anchorsByFile: Map<string, Set<string>>;
}) {
	const problems: DocumentationLinkProblem[] = [];
	const linkPattern =
		/!?\[[^\]]*]\((?!https?:\/\/|mailto:|#)([^)\s]+)(#[^)]+)?\)/g;
	const localAnchorPattern = /!?\[[^\]]*]\(#([^)]+)\)/g;
	let match;

	while ((match = localAnchorPattern.exec(content)) !== null) {
		const expectedAnchor = match[1]!.toLowerCase();
		const fileAnchors = anchorsByFile.get(file) ?? extractAnchors(content);

		if (!fileAnchors.has(expectedAnchor)) {
			problems.push({
				code: "broken-anchor",
				file,
				line: lineNumberAt(content, match.index),
				target: match[0],
				message: `missing anchor #${expectedAnchor} in ${file}`,
			});
		}
	}

	while ((match = linkPattern.exec(content)) !== null) {
		const [raw, target, anchor = ""] = match;
		const line = lineNumberAt(content, match.index);
		const cleanTargetWithFragment = decodeURI(target!.replace(/^<|>$/g, ""));
		const [cleanTarget = "", inlineFragment = ""] =
			cleanTargetWithFragment.split("#");
		const linkAnchor = anchor || (inlineFragment ? `#${inlineFragment}` : "");

		if (!cleanTarget.endsWith(".md")) {
			continue;
		}

		const absoluteTarget = path.resolve(
			path.dirname(path.join(root, file)),
			cleanTarget,
		);
		const relativeTarget = normalizePath(path.relative(root, absoluteTarget));

		if (!fs.existsSync(absoluteTarget)) {
			problems.push({
				code: "broken-link",
				file,
				line,
				target: cleanTarget,
				message: `missing markdown link target: ${cleanTarget}`,
			});
			continue;
		}

		if (linkAnchor) {
			const targetAnchors =
				anchorsByFile.get(relativeTarget) ??
				extractAnchors(fs.readFileSync(absoluteTarget, "utf8"));
			const expectedAnchor = linkAnchor.slice(1).toLowerCase();

			if (!targetAnchors.has(expectedAnchor)) {
				problems.push({
					code: "broken-anchor",
					file,
					line,
					target: raw,
					message: `missing anchor ${linkAnchor} in ${cleanTarget}`,
				});
			}
		}
	}

	return problems;
}

function extractAnchors(markdown: string) {
	const anchors = new Set<string>();

	markdown.split(/\r?\n/).forEach((line) => {
		const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (!heading) return;
		const text = heading[2]!;
		const explicit = text.match(/\{#([^}]+)\}\s*$/);
		if (explicit) {
			anchors.add(explicit[1]!.toLowerCase());
		}
		anchors.add(slugifyHeading(text.replace(/\s*\{#[^}]+\}\s*$/, "")));
	});

	return anchors;
}

function slugifyHeading(heading: string) {
	return heading
		.replace(/`([^`]+)`/g, "$1")
		.toLowerCase()
		.replace(/&/g, "")
		.replace(/[^a-z0-9\s_-]/g, "")
		.trim()
		.replace(/\s/g, "-");
}

function lineNumberAt(content: string, offset: number) {
	return content.slice(0, offset).split(/\r?\n/).length;
}

async function collectMarkdownFiles(root: string) {
	const files: string[] = [];

	for (const scanPath of DOCUMENTATION_PATHS) {
		const absolute = path.join(root, scanPath);
		if (!fs.existsSync(absolute)) continue;
		if (scanPath.endsWith(".md")) {
			files.push(scanPath);
		} else {
			files.push(...(await walkMarkdown(root, absolute)));
		}
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
			found.push(normalizePath(path.relative(root, absolute)));
		}
	}

	return found;
}

function normalizePath(value: string) {
	return value.split(path.sep).join("/");
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const result = await checkDocumentationLinks({ root });

	for (const problem of result.problems) {
		console.error(
			`${problem.file}:${problem.line} ${problem.code} - ${problem.message}`,
		);
	}

	if (result.problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
