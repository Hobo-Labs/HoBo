import { readFile } from "node:fs/promises";
import path from "node:path";

import { type ManifestV1, parseManifest } from "@hobo/bindles";
import type { JsonValue } from "../json.js";
import { compileProjectManifest } from "./loader.js";

export const BINDLE_MANIFEST_FILE = "hobo.bindle.json";

export async function loadProjectManifest(
	projectDir: string,
): Promise<ManifestV1 | null> {
	const fromArtifact = await loadManifestArtifact(projectDir);
	if (fromArtifact !== null) {
		return fromArtifact;
	}
	return compileProjectManifest(projectDir);
}

async function loadManifestArtifact(
	projectDir: string,
): Promise<ManifestV1 | null> {
	let raw: string;
	try {
		raw = await readFile(path.join(projectDir, BINDLE_MANIFEST_FILE), "utf8");
	} catch {
		return null;
	}
	let json: JsonValue;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	try {
		return parseManifest(json);
	} catch {
		return null;
	}
}

export function deploymentIdFor(projectDir: string): string {
	const base = path
		.basename(projectDir)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-");
	return base.length > 0 ? base : "hobo-deployment";
}
