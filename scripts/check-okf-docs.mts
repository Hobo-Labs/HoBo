import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoots = [
	path.join(root, "docs"),
	path.join(root, ".agents", "skills", "repo", "references"),
	path.join(root, ".claude", "skills", "repo", "references"),
	path.join(root, ".agents", "skills", "draft", "references"),
	path.join(root, ".claude", "skills", "draft", "references"),
];
const problems: string[] = [];

function walk(dir: string) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(absolute);
		if (entry.isFile() && entry.name.endsWith(".md")) checkFile(absolute);
	}
}

function rel(file: string) {
	return path.relative(root, file).split(path.sep).join("/");
}

function checkFile(file: string) {
	const name = path.basename(file);
	const content = fs.readFileSync(file, "utf8");

	if (name === "index.md") {
		if (/^---\r?\n/.test(content))
			problems.push(
				`${rel(file)}: OKF index files must not use concept frontmatter`,
			);
		return;
	}

	if (name === "log.md") {
		if (/^---\r?\n/.test(content))
			problems.push(
				`${rel(file)}: OKF log files must not use concept frontmatter`,
			);
		for (const [index, line] of content.split(/\r?\n/).entries()) {
			if (line.startsWith("## ") && !/^## \d{4}-\d{2}-\d{2}$/.test(line)) {
				problems.push(
					`${rel(file)}:${index + 1}: OKF log date headings must use YYYY-MM-DD`,
				);
			}
		}
		return;
	}

	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!match) {
		problems.push(`${rel(file)}: OKF concept documents need YAML frontmatter`);
		return;
	}

	if (!/^type:\s*\S/m.test(match[1]!)) {
		problems.push(`${rel(file)}: OKF concept frontmatter needs non-empty type`);
	}
}

for (const bundleRoot of bundleRoots) {
	if (!fs.existsSync(bundleRoot)) {
		problems.push(`${rel(bundleRoot)}/: OKF bundle root is missing`);
	} else {
		walk(bundleRoot);
	}
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log("OKF conformance ok");
