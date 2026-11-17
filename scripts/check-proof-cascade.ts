import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { z } from "zod";

import { commentsIn, commentViolations } from "./check-source-policy.mts";
import { workspaceForDraftFile } from "./lib/proof-manifest.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function changedFiles(argv: string[]): string[] {
	const staged = argv.includes("--staged");
	const baseArg = argv.find((arg) => arg.startsWith("--base="));
	const base = baseArg ? baseArg.slice("--base=".length) : "HEAD~1";
	const args = staged
		? ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"]
		: ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`];
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\n")
		.filter(Boolean);
}

const notebookSchema = z
	.object({
		cells: z.array(
			z
				.object({
					cell_type: z.string(),
					source: z.union([z.string(), z.array(z.string())]).optional(),
				})
				.passthrough(),
		),
		metadata: z
			.object({
				language_info: z
					.object({ name: z.string().optional() })
					.passthrough()
					.optional(),
				kernelspec: z
					.object({ language: z.string().optional() })
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

function normalizedNotebook(text: string): string | undefined {
	let json: ReturnType<typeof JSON.parse>;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = notebookSchema.safeParse(json);
	if (!parsed.success) return undefined;
	const notebook = parsed.data;
	const language =
		notebook.metadata?.language_info?.name ??
		notebook.metadata?.kernelspec?.language;
	if (language !== "typescript" && language !== "javascript") return undefined;
	for (const cell of notebook.cells) {
		if (cell.cell_type !== "code") continue;
		if (cell.source === undefined) return undefined;
		const source = Array.isArray(cell.source)
			? cell.source.join("")
			: cell.source;
		const diagnostics =
			ts.transpileModule(source, {
				reportDiagnostics: true,
				compilerOptions: { module: ts.ModuleKind.ESNext },
			}).diagnostics ?? [];
		if (
			diagnostics.some(
				(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
			)
		)
			return undefined;
		let normalized = source;
		for (const comment of [...commentsIn("cell.ts", source)].reverse()) {
			if (/\b(?:TODO|FIXME|HACK|XXX|TBD)\b/iu.test(comment.text)) continue;
			if (
				/^\/\*\*[\s\S]*?@(?:type|typedef|param|returns?|property|template|satisfies|implements|extends|import|deprecated|internal|public|override|readonly|enum|constant|this|generated)\b/iu.test(
					comment.text,
				)
			)
				continue;
			const lines = new Set(
				comment.text.split("\n").map((_, index) => index + 1),
			);
			if (
				commentViolations(
					"cell.ts",
					`${comment.text}\nconst marker = 0;`,
					lines,
				).length === 0
			)
				continue;
			const lineBreaks = source
				.slice(comment.start, comment.end)
				.replace(/[^\r\n]/gu, "");
			normalized =
				normalized.slice(0, comment.start) +
				(lineBreaks || " ") +
				normalized.slice(comment.end);
		}
		const file = ts.createSourceFile(
			"cell.ts",
			normalized,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		cell.source = ts.createPrinter().printFile(file);
	}
	return JSON.stringify(notebook);
}

export function sameNotebookExecution(before: string, after: string): boolean {
	const left = normalizedNotebook(before);
	return left !== undefined && left === normalizedNotebook(after);
}

function fileAt(revision: string, file: string): string | undefined {
	try {
		return execFileSync("git", ["show", `${revision}:${file}`], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return undefined;
	}
}

function cascadeFiles(files: string[], argv: string[]): string[] {
	const staged = argv.includes("--staged");
	const base =
		argv.find((arg) => arg.startsWith("--base="))?.slice("--base=".length) ??
		"HEAD~1";
	const before = staged
		? "HEAD"
		: execFileSync("git", ["merge-base", base, "HEAD"], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim();
	const after = staged ? "" : "HEAD";
	return files.filter((file) => {
		if (!file.endsWith(".ipynb")) return true;
		const left = fileAt(before, file);
		const right = fileAt(after, file);
		return (
			left === undefined ||
			right === undefined ||
			!sameNotebookExecution(left, right)
		);
	});
}

type Aggregator = { workspace: string; references: Set<string> };

function loadAggregators(root: string): Aggregator[] {
	const aggregators: Aggregator[] = [];
	const roots = ["src/draft/epic-proofs", "src/draft/projects"];
	for (const kindRoot of roots) {
		const absKind = path.join(root, kindRoot);
		if (!existsSync(absKind)) continue;
		for (const entry of readdirSync(absKind, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
			const workspace = `${kindRoot}/${entry.name}`;
			const references = new Set<string>();
			const manifestPath = path.join(root, workspace, "proof.json");
			if (existsSync(manifestPath)) {
				try {
					const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
						references?: {
							technicalProofs?: string[];
							expProofs?: string[];
							epicProofs?: string[];
						};
					};
					for (const list of [
						manifest.references?.technicalProofs,
						manifest.references?.expProofs,
						manifest.references?.epicProofs,
					]) {
						for (const ref of list ?? [])
							references.add(ref.replace(/\/+$/u, ""));
					}
				} catch {}
			}
			for (const file of scanFiles(path.join(root, workspace))) {
				const content = readFileSync(file, "utf8");
				for (const match of content.matchAll(
					/src\/draft\/((?:technical-proofs|projects)\/[a-z0-9-]+|exp-proofs\/(?:dx|ux|cx|ax|api)\/[a-z0-9-]+)/gu,
				)) {
					references.add(`src/draft/${match[1]}`);
				}
				for (const match of content.matchAll(
					/from\s+"(?:\.\.\/)+((?:technical-proofs\/[a-z0-9-]+|exp-proofs\/(?:dx|ux|cx|ax|api)\/[a-z0-9-]+))\//gu,
				)) {
					references.add(`src/draft/${match[1]}`);
				}
			}
			references.delete(workspace);
			aggregators.push({ workspace, references });
		}
	}
	return aggregators;
}

function scanFiles(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...scanFiles(abs));
		else if (/\.(ts|mts|mjs|md|json|yaml)$/u.test(entry.name)) out.push(abs);
	}
	return out;
}

function cascadeWaived(workspace: string): boolean {
	const manifestPath = path.join(repoRoot, workspace, "proof.json");
	if (!existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			waivers?: Array<{ requirement?: string }>;
		};
		return (manifest.waivers ?? []).some(
			(waiver) => waiver.requirement === "cascade",
		);
	} catch {
		return false;
	}
}

function main() {
	const argv = process.argv.slice(2);
	const files = cascadeFiles(changedFiles(argv), argv);
	const changedWorkspaces = new Set(
		files.map(workspaceForDraftFile).filter((w): w is string => Boolean(w)),
	);
	const changedLeaves = [...changedWorkspaces].filter((w) =>
		/^src\/draft\/(technical-proofs|exp-proofs)\//u.test(w),
	);
	if (changedLeaves.length === 0) {
		console.log("proof cascade OK: no changed technical/exp proofs.");
		return;
	}

	const grandfathered = new Set(
		(
			JSON.parse(
				readFileSync(
					path.join(repoRoot, "src/draft/_grandfathered.json"),
					"utf8",
				),
			) as { packages: string[] }
		).packages,
	);
	const aggregators = loadAggregators(repoRoot);

	let failures = 0;
	for (const leaf of changedLeaves) {
		const referencing = aggregators.filter((aggregator) =>
			aggregator.references.has(leaf),
		);
		const stale = referencing.filter(
			(aggregator) => !changedWorkspaces.has(aggregator.workspace),
		);
		if (stale.length === 0) continue;
		if (cascadeWaived(leaf)) {
			console.log(`waived cascade: ${leaf} (proof.json waiver)`);
			continue;
		}
		for (const aggregator of stale) {
			if (grandfathered.has(aggregator.workspace)) {
				console.log(
					`advisory: ${leaf} changed but grandfathered ${aggregator.workspace} references it and was not updated`,
				);
			} else {
				failures += 1;
				console.error(
					`FAIL: ${leaf} changed but ${aggregator.workspace} references it and was not updated in this diff`,
				);
			}
		}
	}

	if (failures > 0) {
		console.error(
			"\nproof-cascade gate failed: update and test the affected referencing packages.",
		);
		process.exit(1);
	}
	console.log(
		`proof cascade OK: ${changedLeaves.length} changed leaf proof(s) checked against ${aggregators.length} aggregator(s).`,
	);
}

const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) main();

export { loadAggregators };
