import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { PatternManifest } from "./_generated/patterns_pb.js";
import { parseAtomAsPattern } from "./atoms.js";
import { canonicalJson, parsePatternManifest } from "./parse.js";

export type PatternCatalog = {
	readonly root: string;
	readonly digest: string;
	readonly patterns: readonly PatternManifest[];
};

function walkNamed(dir: string, fileName: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...walkNamed(full, fileName));
		} else if (name === fileName) {
			out.push(full);
		}
	}
	return out;
}

export function defaultCatalogRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "patterns");
}

export function defaultAtomsRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "atoms");
}

function finalizePattern(
	file: string,
	parsed: PatternManifest,
): PatternManifest {
	const dir = dirname(file);
	for (const rendering of parsed.renderings) {
		const body = join(dir, rendering.sourcePath);
		if (!existsSync(body)) {
			throw new Error(
				`${parsed.id}: missing rendering ${rendering.sourcePath}`,
			);
		}
		rendering.contentDigest = createHash("sha256")
			.update(readFileSync(body))
			.digest("hex");
	}
	parsed.contentDigest = createHash("sha256")
		.update(
			canonicalJson({
				id: parsed.id,
				version: parsed.version,
				renderings: parsed.renderings.map((item) => item.contentDigest),
			}),
		)
		.digest("hex");
	return parsed;
}

export function loadPatternCatalog(
	options: { readonly root?: string; readonly atomsRoot?: string } = {},
): PatternCatalog {
	const root = options.root ?? defaultCatalogRoot();
	const atomsRoot = options.atomsRoot ?? defaultAtomsRoot();
	const patterns = [
		...walkNamed(root, "pattern.json").map((file) =>
			finalizePattern(
				file,
				parsePatternManifest(JSON.parse(readFileSync(file, "utf8"))),
			),
		),
		...walkNamed(atomsRoot, "meta.json").map((file) =>
			finalizePattern(
				file,
				parseAtomAsPattern(
					JSON.parse(readFileSync(file, "utf8")),
					relative(atomsRoot, dirname(file)),
				),
			),
		),
	].sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version);
	const digest = createHash("sha256")
		.update(
			canonicalJson(
				patterns.map((item) => ({
					id: item.id,
					version: item.version,
					digest: item.contentDigest,
				})),
			),
		)
		.digest("hex");
	return { root, digest, patterns };
}

const manifestIndexes = new WeakMap<
	PatternCatalog,
	ReadonlyMap<string, string>
>();

function manifestIndex(catalog: PatternCatalog): ReadonlyMap<string, string> {
	const cached = manifestIndexes.get(catalog);
	if (cached) return cached;
	const index = new Map<string, string>();
	const files = [catalog.root, defaultAtomsRoot()].flatMap((root) => [
		...walkNamed(root, "pattern.json"),
		...walkNamed(root, "meta.json"),
	]);
	for (const file of files) {
		// SAFETY: loadPatternCatalog validates these manifests before indexing.
		const raw = JSON.parse(readFileSync(file, "utf8")) as { id?: string };
		if (raw.id && !index.has(raw.id)) index.set(raw.id, file);
	}
	manifestIndexes.set(catalog, index);
	return index;
}

export function readRenderingBody(
	catalog: PatternCatalog,
	pattern: PatternManifest,
	renderingId: string,
): string {
	const rendering = pattern.renderings.find(
		(item) => item.renderingId === renderingId,
	);
	if (!rendering) {
		throw new Error(`${pattern.id}: unknown rendering ${renderingId}`);
	}
	const file = manifestIndex(catalog).get(pattern.id);
	if (!file || !existsSync(join(dirname(file), rendering.sourcePath))) {
		throw new Error(`${pattern.id}: catalog file missing`);
	}
	return readFileSync(join(dirname(file), rendering.sourcePath), "utf8");
}
