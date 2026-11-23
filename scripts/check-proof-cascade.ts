import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { z } from "zod";

import { commentsIn, commentViolations } from "./check-source-policy.mts";
import { workspaceForDraftFile } from "./lib/proof-manifest.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const PROGRAM_EXTENSIONS = new Set([
	".cjs",
	".cts",
	".js",
	".mjs",
	".mts",
	".ts",
]);
const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const TRACEABILITY_REFERENCE =
	/(["'`])(?:docs\/design\/[^"'`\r\n]*|urn:hobo:(?:decision|proof|requirement):[^"'`\r\n]*)\1/gu;

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

function normalizedProgram(
	file: string,
	text: string,
	normalizeTraceability: boolean,
): string | undefined {
	const hasSyntaxError = (source: string) =>
		(
			ts.transpileModule(source, { reportDiagnostics: true }).diagnostics ?? []
		).some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	if (hasSyntaxError(text)) return undefined;
	let normalized = text;
	for (const comment of [...commentsIn(file, text)].reverse()) {
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
			commentViolations(file, `${comment.text}\nconst marker = 0;`, lines)
				.length === 0
		)
			continue;
		const lineBreaks = text
			.slice(comment.start, comment.end)
			.replace(/[^\r\n]/gu, "");
		normalized =
			normalized.slice(0, comment.start) +
			(lineBreaks || " ") +
			normalized.slice(comment.end);
	}
	if (normalizeTraceability)
		normalized = normalized.replace(
			TRACEABILITY_REFERENCE,
			'"urn:hobo:traceability"',
		);
	if (hasSyntaxError(normalized)) return undefined;
	const source = ts.createSourceFile(
		file,
		normalized,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	return ts.createPrinter().printFile(source);
}

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
		const normalized = normalizedProgram("cell.ts", source, false);
		if (normalized === undefined) return undefined;
		cell.source = normalized;
	}
	return JSON.stringify(notebook);
}

export function sameNotebookExecution(before: string, after: string): boolean {
	const left = normalizedNotebook(before);
	return left !== undefined && left === normalizedNotebook(after);
}

function normalizedJson(text: string): string | undefined {
	let value: z.infer<ReturnType<typeof z.json>>;
	try {
		value = z.json().parse(JSON.parse(text));
	} catch {
		return undefined;
	}
	return JSON.stringify(value, (_key, entry) => {
		const string = z.string().safeParse(entry);
		return string.success &&
			/^(?:docs\/design\/|urn:hobo:(?:decision|proof|requirement):)/u.test(
				string.data,
			)
			? "urn:hobo:traceability"
			: entry;
	});
}

export function sameProofExecution(
	file: string,
	before: string,
	after: string,
): boolean {
	const extension = path.extname(file).toLowerCase();
	if (PROSE_EXTENSIONS.has(extension)) return true;
	if (extension === ".ipynb") return sameNotebookExecution(before, after);
	if (extension === ".json") {
		const left = normalizedJson(before);
		return left !== undefined && left === normalizedJson(after);
	}
	if (!PROGRAM_EXTENSIONS.has(extension)) return false;
	const left = normalizedProgram(file, before, true);
	return left !== undefined && left === normalizedProgram(file, after, true);
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

const IDENTITY_SCAFFOLD_DIGESTS = new Map<string, readonly string[]>([
	[
		"examples/proof-identity.ts",
		[
			"675ac55737ce135cc1e27c79cd589d3178512e47fc22089d70ea7562e5dc14ca",
			"70fefc662e85ea6128d3d7d8a10c1fc3c5d580b8ab81c32c6c5487d460b4a909",
		],
	],
	[
		"examples/proof-identity.expected.txt",
		["b03742b19dcecfa42f53d6840636c4d662e47cf1063166668a774c0dea6a047a"],
	],
	[
		"bench/identity.bench.ts",
		["ef3ca99124e340eed040b88c6efd804608460878ee3c752b0fb133eabb932ec7"],
	],
	[
		"notebook.ipynb",
		["77362e68407c912a8632a04f6bf85a4a627c3b5cce189fbff39f36963831ea21"],
	],
]);

export function isIdentityScaffold(file: string, content: string): boolean {
	const workspace = workspaceForDraftFile(file);
	if (workspace === undefined) return false;
	const digests = IDENTITY_SCAFFOLD_DIGESTS.get(
		file.slice(workspace.length + 1),
	);
	if (digests === undefined) return false;
	const normalized = content.replaceAll(path.basename(workspace), "<slug>");
	const digest = createHash("sha256").update(normalized).digest("hex");
	return digests.includes(digest);
}

const manifestCleanupSchema = z
	.object({
		artifacts: z
			.object({
				examples: z.string().optional(),
				notebook: z.string().optional(),
				bench: z.string().optional(),
			})
			.passthrough(),
	})
	.passthrough();

export function removesOnlyIdentityDeclarations(
	workspace: string,
	before: string,
	after: string,
	priorFiles: ReadonlySet<string>,
	removedScaffolds: ReadonlySet<string>,
): boolean {
	let left: z.infer<typeof manifestCleanupSchema>;
	let right: z.infer<typeof manifestCleanupSchema>;
	try {
		left = manifestCleanupSchema.parse(JSON.parse(before));
		right = manifestCleanupSchema.parse(JSON.parse(after));
	} catch {
		return false;
	}
	const expected = {
		examples: [
			"examples/proof-identity.ts",
			"examples/proof-identity.expected.txt",
		],
		notebook: ["notebook.ipynb"],
		bench: ["bench/identity.bench.ts"],
	} as const;
	let removed = false;
	for (const key of ["examples", "notebook", "bench"] as const) {
		const oldPath = left.artifacts[key];
		if (oldPath === undefined || right.artifacts[key] !== undefined) continue;
		if (oldPath !== (key === "notebook" ? "notebook.ipynb" : key)) return false;
		const prefix = `${workspace}/${oldPath}`;
		const previous = [...priorFiles].filter(
			(file) => file === prefix || file.startsWith(`${prefix}/`),
		);
		const required = expected[key].map((file) => `${workspace}/${file}`);
		if (
			previous.length !== required.length ||
			!required.every(
				(file) => priorFiles.has(file) && removedScaffolds.has(file),
			)
		)
			return false;
		delete left.artifacts[key];
		removed = true;
	}
	return removed && JSON.stringify(left) === JSON.stringify(right);
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
	const removedScaffolds = new Set(
		files.filter((file) => {
			const previous = fileAt(before, file);
			return (
				previous !== undefined &&
				fileAt(after, file) === undefined &&
				isIdentityScaffold(file, previous)
			);
		}),
	);
	return files.filter((file) => {
		if (removedScaffolds.has(file)) return false;
		if (PROSE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
			const workspace = workspaceForDraftFile(file);
			return Boolean(
				workspace && /^src\/draft\/(?:epic-proofs|projects)\//u.test(workspace),
			);
		}
		const left = fileAt(before, file);
		const right = fileAt(after, file);
		const workspace = workspaceForDraftFile(file);
		if (
			workspace &&
			file === `${workspace}/proof.json` &&
			left !== undefined &&
			right !== undefined
		) {
			const priorFiles = new Set(
				execFileSync(
					"git",
					["ls-tree", "-r", "--name-only", before, "--", workspace],
					{
						cwd: repoRoot,
						encoding: "utf8",
					},
				)
					.split("\n")
					.filter(Boolean),
			);
			if (
				removesOnlyIdentityDeclarations(
					workspace,
					left,
					right,
					priorFiles,
					removedScaffolds,
				)
			)
				return false;
		}
		return (
			left === undefined ||
			right === undefined ||
			!sameProofExecution(file, left, right)
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
					const manifest: {
						references?: {
							technicalProofs?: string[];
							expProofs?: string[];
							epicProofs?: string[];
						};
					} = JSON.parse(readFileSync(manifestPath, "utf8"));
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
		const manifest: {
			waivers?: Array<{ requirement?: string }>;
		} = JSON.parse(readFileSync(manifestPath, "utf8"));
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

	const grandfatheredRegistry: { packages: string[] } = JSON.parse(
		readFileSync(path.join(repoRoot, "src/draft/_grandfathered.json"), "utf8"),
	);
	const grandfathered = new Set(grandfatheredRegistry.packages);
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
