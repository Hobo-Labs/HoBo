import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	experienceTypeForWorkspace,
	layerForWorkspace,
	type ProofManifest,
	proofManifestSchema,
} from "./lib/proof-manifest.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
function firstHeading(readme: string): string | undefined {
	const match = readme.match(/^#\s+(.+?)\s*$/m);
	return match?.[1]?.replace(/`/g, "").trim();
}

function linearId(readme: string): string | undefined {
	const match = readme.match(/\bHOBO-(\d+)\b/);
	return match ? `HOBO-${match[1]}` : undefined;
}

function listFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFilesRecursive(absolute));
		else out.push(absolute);
	}
	return out;
}

export function referencesFor(
	workspace: string,
	root = repoRoot,
): ProofManifest["references"] {
	const absolute = path.join(root, workspace);
	const technical = new Set<string>();
	const epics = new Set<string>();
	const exp = new Set<string>();

	const record = (candidate: string) => {
		const normalized = candidate.replace(/\\/g, "/");
		if (!existsSync(path.join(root, normalized))) return;
		if (normalized === workspace) return;
		if (/^src\/draft\/technical-proofs\/[^/]+$/.test(normalized)) {
			technical.add(normalized);
		} else if (/^src\/draft\/epic-proofs\/[^/]+$/.test(normalized)) {
			epics.add(normalized);
		} else if (/^src\/draft\/exp-proofs\/[^/]+\/[^/]+$/.test(normalized)) {
			exp.add(normalized);
		}
	};

	for (const file of listFilesRecursive(absolute)) {
		const rel = path.relative(root, file).replace(/\\/g, "/");
		if (/\.(ts|mts|js|mjs)$/.test(file)) {
			const content = readFileSync(file, "utf8");
			for (const match of content.matchAll(
				/(?:\bfrom\s+|\bimport\s*)["']((?:\.\.\/)+[^"']+)["']/g,
			)) {
				const resolved = path
					.relative(root, path.resolve(path.dirname(file), match[1]!))
					.replace(/\\/g, "/");
				const pkg = resolved.match(
					/^(src\/draft\/(?:technical-proofs|epic-proofs)\/[^/]+|src\/draft\/exp-proofs\/[^/]+\/[^/]+)/,
				);
				if (pkg) record(pkg[1]!);
			}
		}
		if (rel === `${workspace}/README.md`) {
			const content = readFileSync(file, "utf8");
			for (const match of content.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
				const target = match[1]!;
				if (/^(https?:|mailto:)/.test(target)) continue;
				const resolved = path
					.relative(root, path.resolve(path.dirname(file), target))
					.replace(/\\/g, "/");
				const pkg = resolved.match(
					/^(src\/draft\/(?:technical-proofs|epic-proofs)\/[^/]+|src\/draft\/exp-proofs\/[^/]+\/[^/]+)/,
				);
				if (pkg) record(pkg[1]!);
			}
		}
	}

	return {
		technicalProofs: [...technical].sort(),
		epicProofs: [...epics].sort(),
		expProofs: [...exp].sort(),
		designDocs: [],
	};
}

export function artifactsFor(
	workspace: string,
	layer: ProofManifest["layer"],
	root = repoRoot,
): ProofManifest["artifacts"] {
	const absolute = path.join(root, workspace);
	const artifacts: ProofManifest["artifacts"] = {
		examples: "examples",
		notebook: "notebook.ipynb",
		diagrams: [],
	};
	if (
		layer === "epic" ||
		(layer === "project" && existsSync(path.join(absolute, "features")))
	) {
		if (existsSync(path.join(absolute, "features"))) {
			artifacts.features = "features";
		}
	}
	if (layer === "technical" && existsSync(path.join(absolute, "bench"))) {
		artifacts.bench = "bench";
	}
	if (existsSync(path.join(absolute, "assets"))) {
		artifacts.assets = "assets";
	}
	return artifacts;
}

function main() {
	const force = process.argv.includes("--force");
	// SAFETY: _grandfathered.json is the checked-in registry whose packages array contains workspace strings.
	const registry = JSON.parse(
		readFileSync(path.join(repoRoot, "src/draft/_grandfathered.json"), "utf8"),
	) as { packages: string[] };
	let written = 0;
	let skipped = 0;
	for (const workspace of registry.packages) {
		const absolute = path.join(repoRoot, workspace);
		if (!existsSync(absolute)) {
			console.warn(`missing on disk (stale registry entry?): ${workspace}`);
			continue;
		}
		const manifestPath = path.join(absolute, "proof.json");
		if (existsSync(manifestPath) && !force) {
			skipped += 1;
			continue;
		}

		const layer = layerForWorkspace(workspace);
		if (!layer) {
			console.warn(`cannot determine layer: ${workspace}`);
			continue;
		}
		const slug = path.basename(workspace);
		const readmePath = path.join(absolute, "README.md");
		const readme = existsSync(readmePath)
			? readFileSync(readmePath, "utf8")
			: "";
		const experienceType = experienceTypeForWorkspace(workspace);
		const linear = linearId(readme);

		type ProofBackfill = {
			layer: typeof layer;
			slug: string;
			experienceType?: string;
			title: string;
			linear?: string;
			references: ReturnType<typeof referencesFor>;
			artifacts: ReturnType<typeof artifactsFor>;
			waivers: [];
		};
		const manifest: ProofBackfill = {
			layer,
			slug,
			title: firstHeading(readme) ?? slug,
			references: referencesFor(workspace),
			artifacts: artifactsFor(workspace, layer),
			waivers: [],
		};
		if (experienceType !== undefined) manifest.experienceType = experienceType;
		if (linear !== undefined) manifest.linear = linear;

		const parsed = proofManifestSchema.parse(manifest);
		writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
		written += 1;
	}

	console.log(
		`proof.json backfill: ${written} written, ${skipped} already present.`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
