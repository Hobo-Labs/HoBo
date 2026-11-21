import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
	experienceTypeForWorkspace,
	layerForWorkspace,
	type ProofManifest,
	proofManifestSchema,
	workspaceForDraftFile,
} from "./lib/proof-manifest.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function changedFiles(argv: string[]): string[] {
	const staged = argv.includes("--staged");
	const baseArg = argv.find((arg) => arg.startsWith("--base="));
	const base = baseArg ? baseArg.slice("--base=".length) : "HEAD~1";
	const args = staged
		? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
		: ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`];
	const output = execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return output.split("\n").filter(Boolean);
}

function listFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
		else out.push(abs);
	}
	return out;
}

export type WorkspaceReport = {
	workspace: string;
	grandfathered: boolean;
	problems: string[];
};

export function checkWorkspace(
	workspace: string,
	options: { root?: string; runExamples?: boolean; runBench?: boolean } = {},
): WorkspaceReport {
	const root = options.root ?? repoRoot;
	const runExamples = options.runExamples ?? true;
	const runBench = options.runBench ?? false;
	const abs = path.join(root, workspace);
	const problems: string[] = [];
	const layer = layerForWorkspace(workspace);
	if (!layer)
		return {
			workspace,
			grandfathered: false,
			problems: [`unrecognized draft workspace: ${workspace}`],
		};

	const manifestPath = path.join(abs, "proof.json");
	if (!existsSync(manifestPath)) {
		return {
			workspace,
			grandfathered: false,
			problems: ["missing proof.json (see scripts/lib/proof-manifest.ts)"],
		};
	}

	let manifest: ProofManifest;
	try {
		manifest = proofManifestSchema.parse(
			JSON.parse(readFileSync(manifestPath, "utf8")),
		);
	} catch (error) {
		return {
			workspace,
			grandfathered: false,
			problems: [
				`invalid proof.json: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}

	const slug = path.basename(workspace);
	if (manifest.slug !== slug)
		problems.push(
			`proof.json slug "${manifest.slug}" does not match folder "${slug}"`,
		);
	if (manifest.layer !== layer)
		problems.push(
			`proof.json layer "${manifest.layer}" does not match path layer "${layer}"`,
		);
	const expType = experienceTypeForWorkspace(workspace);
	if (expType && manifest.experienceType !== expType) {
		problems.push(
			`proof.json experienceType "${manifest.experienceType}" does not match type folder "${expType}"`,
		);
	}

	const waived = new Set(manifest.waivers.map((w) => w.requirement));
	for (const waiver of manifest.waivers) {
		if (waiver.adr && !existsSync(path.join(abs, waiver.adr)))
			problems.push(
				`waiver for "${waiver.requirement}" cites missing ADR: ${waiver.adr}`,
			);
	}

	if (!waived.has("examples")) {
		let examplesReady = true;
		const packagePath = path.join(abs, "package.json");
		const packageJson = existsSync(packagePath)
			? JSON.parse(readFileSync(packagePath, "utf8"))
			: undefined;
		if (runExamples && packageJson?.scripts?.["draft:prepare"]) {
			const prepare = spawnSync("pnpm", ["run", "draft:prepare"], {
				cwd: abs,
				encoding: "utf8",
				timeout: 120_000,
				env: { ...process.env, NODE_OPTIONS: "" },
			});
			if (prepare.error || prepare.status !== 0) {
				examplesReady = false;
				problems.push(
					`draft:prepare failed: ${prepare.error?.message ?? (prepare.stderr || "").trim().slice(0, 300)}`,
				);
			}
		}
		const examplesDir = path.join(abs, manifest.artifacts.examples);
		const examples = existsSync(examplesDir)
			? readdirSync(examplesDir).filter(
					(f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
				)
			: [];
		if (examples.length === 0) {
			problems.push(
				`no runnable examples under ${manifest.artifacts.examples}/ (need <name>.ts + <name>.expected.txt)`,
			);
		}
		for (const example of examples) {
			const expected = path.join(
				examplesDir,
				example.replace(/\.ts$/u, ".expected.txt"),
			);
			if (!existsSync(expected)) {
				problems.push(
					`example ${example} has no committed expected output (${path.basename(expected)})`,
				);
				continue;
			}
			if (!runExamples || !examplesReady) continue;
			const run = spawnSync(
				"node",
				[
					"--import",
					import.meta.resolve("tsx"),
					path.join(examplesDir, example),
				],
				{
					cwd: abs,
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, NODE_OPTIONS: "" },
				},
			);
			if (run.error || run.status !== 0) {
				problems.push(
					`example ${example} failed: ${run.error?.message ?? (run.stderr || "").trim().slice(0, 300)}`,
				);
			} else if (run.stdout.trim() !== readFileSync(expected, "utf8").trim()) {
				problems.push(
					`example ${example} output does not match ${path.basename(expected)}`,
				);
			}
		}
	}

	if (!waived.has("notebook")) {
		const notebookPath = path.join(abs, manifest.artifacts.notebook);
		if (!existsSync(notebookPath)) {
			problems.push(`missing notebook: ${manifest.artifacts.notebook}`);
		} else {
			try {
				// SAFETY: this JSON boundary reads only optional notebook metadata and cell fields, with defaults below.
				const nb = JSON.parse(readFileSync(notebookPath, "utf8")) as {
					nbformat?: number;
					cells?: Array<{ cell_type?: string; outputs?: unknown[] }>;
				};
				const codeCells = (nb.cells ?? []).filter(
					(c) => c.cell_type === "code",
				);
				if (!nb.nbformat || nb.nbformat < 4)
					problems.push("notebook is not nbformat >= 4");
				if (codeCells.length === 0) problems.push("notebook has no code cells");
				else if (
					!codeCells.some(
						(c) => Array.isArray(c.outputs) && c.outputs.length > 0,
					)
				)
					problems.push("notebook has no executed outputs");
			} catch {
				problems.push(
					`notebook is not valid JSON: ${manifest.artifacts.notebook}`,
				);
			}
		}
	}

	if (layer === "technical" && !waived.has("bench")) {
		const benchPath = path.join(abs, manifest.artifacts.bench ?? "bench");
		const benches =
			existsSync(benchPath) && statSync(benchPath).isDirectory()
				? readdirSync(benchPath).filter((f) => f.endsWith(".bench.ts"))
				: existsSync(benchPath)
					? [benchPath]
					: [];
		if (benches.length === 0) {
			problems.push(
				"technical proof declares no bench (bench/*.bench.ts) and no bench waiver",
			);
		} else if (runBench) {
			const run = spawnSync(
				"pnpm",
				[
					"exec",
					"vitest",
					"bench",
					"--run",
					manifest.artifacts.bench ?? "bench",
				],
				{
					cwd: abs,
					encoding: "utf8",
					timeout: 180_000,
				},
			);
			if (run.status !== 0)
				problems.push(
					`declared bench does not execute: ${(run.stderr || "").trim().slice(0, 300)}`,
				);
		}
	}

	if (layer === "epic" && !waived.has("features")) {
		const featuresDir = path.join(
			abs,
			manifest.artifacts.features ?? "features",
		);
		const features = existsSync(featuresDir)
			? listFilesRecursive(featuresDir)
			: [];
		if (!features.some((f) => f.endsWith(".feature")))
			problems.push("epic proof has no executable features/*.feature");
		if (!features.some((f) => /steps\/.+\.ts$/u.test(f.replaceAll("\\", "/"))))
			problems.push("epic proof has no features/steps/*.ts step definitions");
	}

	if (layer === "exp" && expType && !waived.has("assets")) {
		const all = listFilesRecursive(abs).map((f) =>
			path.relative(abs, f).replaceAll("\\", "/"),
		);
		const assetRoot = manifest.artifacts.assets ?? "assets";
		const inAssets = all.filter((f) => f.startsWith(`${assetRoot}/`));
		const requirementByType = {
			ux: () => inAssets.some((f) => /\.(svg|png|jpe?g|webp)$/u.test(f)),
			dx: () =>
				all.some((f) => f.endsWith(".proto")) &&
				all.some((f) => f.endsWith(".cue")),
			cx: () =>
				all.some((f) =>
					/(?:^|\/)(?:test|tests)\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(f),
				) ||
				(all.some((f) => /(?:^|\/)features\/.+\.feature$/u.test(f)) &&
					all.some((f) => /(?:^|\/)features\/steps\/.+\.[cm]?[jt]s$/u.test(f))),
			ax: () =>
				inAssets.some((f) => /\.(json|md)$/u.test(f)) ||
				all.some((f) => /transcripts\/.+\.(json|md)$/u.test(f)),
			api: () =>
				all.some(
					(f) =>
						/(type-tests|test-types)\//u.test(f) || f.endsWith(".test-d.ts"),
				),
		};
		const message = {
			ux: "ux proof needs real visual assets (assets/*.svg|png|jpg|webp)",
			dx: "dx proof needs protobuf + CUE contracts",
			cx: "cx proof needs executable customer journey tests or feature steps",
			ax: "ax proof needs MCP transcript/tool-schema fixtures (assets/ or transcripts/, .json|.md)",
			api: "api proof needs type tests (type-tests/, test-types/, or *.test-d.ts)",
		};
		if (!requirementByType[expType]()) problems.push(message[expType]);
		if (expType === "ux") {
			for (const f of inAssets.filter((x) =>
				/\.(svg|png|jpe?g|webp)$/u.test(x),
			)) {
				const head = readFileSync(path.join(abs, f)).subarray(0, 64);
				const text = head.toString("utf8");
				const looksReal = f.endsWith(".svg")
					? text.includes("<svg") || text.includes("<?xml")
					: head.length >= 8 && head[0] !== 0x20;
				if (!looksReal || statSync(path.join(abs, f)).size < 128)
					problems.push(`asset ${f} does not look like a real image/wireframe`);
			}
		}
	}

	return { workspace, grandfathered: false, problems };
}

function main() {
	const argv = process.argv.slice(2);
	// SAFETY: _grandfathered.json is the checked-in registry whose packages array contains workspace strings.
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
	const positional = argv.filter((arg) => !arg.startsWith("--"));
	const workspaces = [
		...new Set(
			(positional.length > 0
				? positional.map((p) =>
						path.relative(repoRoot, path.resolve(repoRoot, p)),
					)
				: changedFiles(argv).map(workspaceForDraftFile)
			).filter((w): w is string => Boolean(w)),
		),
	];
	if (workspaces.length === 0) {
		console.log("draft artifacts OK: no changed proof packages.");
		return;
	}

	let failures = 0;
	for (const workspace of workspaces) {
		const isGrandfathered =
			positional.length === 0 && grandfathered.has(workspace);
		const report = checkWorkspace(workspace);
		if (report.problems.length === 0) {
			console.log(`ok: ${workspace}`);
			continue;
		}
		if (isGrandfathered) {
			console.log(`advisory (grandfathered): ${workspace}`);
			for (const problem of report.problems) console.log(`  - ${problem}`);
		} else {
			failures += 1;
			console.error(`FAIL: ${workspace}`);
			for (const problem of report.problems) console.error(`  - ${problem}`);
		}
	}

	if (failures > 0) {
		console.error(
			`\ndraft-artifact gate failed for ${failures} package(s). Fix the reported artifacts and executable checks.`,
		);
		process.exit(1);
	}
	console.log(`draft artifacts OK: ${workspaces.length} package(s) checked.`);
}

const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) main();
