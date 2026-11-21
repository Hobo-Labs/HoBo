import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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
					// SAFETY: this best-effort scan reads optional reference lists and ignores malformed manifests.
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
		// SAFETY: waiver reads are optional, and malformed manifests fall back to no waiver.
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
	const files = changedFiles(argv);
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
