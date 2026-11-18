import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { digest, normalizeText } from "../codegen/text.js";
import {
	type AgentDocsArtifact,
	type GenerateAgentDocsInput,
	generateAgentDocs,
} from "./generate.js";

export type AgentDocsDriftStatus = "missing" | "changed" | "extra";

export interface AgentDocsDriftEntry {
	readonly path: string;
	readonly status: AgentDocsDriftStatus;
	readonly expectedDigest?: string;
	readonly actualDigest?: string;
}

export class AgentDocsError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly detail: { readonly drift?: readonly AgentDocsDriftEntry[] } = {},
	) {
		super(message);
		this.name = "AgentDocsError";
	}
}

async function readIfPresent(target: string): Promise<string | undefined> {
	return existsSync(target)
		? normalizeText(await readFile(target, "utf8"))
		: undefined;
}

async function listArtifacts(root: string, dir = root): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const target = join(dir, entry.name);
			return entry.isDirectory()
				? listArtifacts(root, target)
				: [relative(root, target).split(sep).join("/")];
		}),
	);
	return files.flat();
}

export async function compareAgentDocs(
	dir: string,
	input: GenerateAgentDocsInput = {},
): Promise<readonly AgentDocsDriftEntry[]> {
	const { artifacts } = generateAgentDocs(input);
	const expectedPaths = new Set(artifacts.map((artifact) => artifact.path));
	const drift: AgentDocsDriftEntry[] = [];
	for (const artifact of artifacts) {
		const expected = normalizeText(artifact.content);
		const actual = await readIfPresent(join(dir, artifact.path));
		if (actual === undefined) {
			drift.push({
				path: artifact.path,
				status: "missing",
				expectedDigest: digest(expected),
			});
			continue;
		}
		if (actual !== expected) {
			drift.push({
				path: artifact.path,
				status: "changed",
				expectedDigest: digest(expected),
				actualDigest: digest(actual),
			});
		}
	}
	for (const path of await listArtifacts(dir)) {
		if (!expectedPaths.has(path)) drift.push({ path, status: "extra" });
	}
	return drift.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertAgentDocsFresh(
	dir: string,
	input: GenerateAgentDocsInput = {},
): Promise<void> {
	const drift = await compareAgentDocs(dir, input);
	if (drift.length > 0) {
		throw new AgentDocsError(
			"HOBO_AGENT_DOCS_DRIFT",
			"agent docs drift detected; run pnpm --filter @hobo/cli agent-docs:write and remove unexpected artifacts",
			{ drift },
		);
	}
}

export async function writeAgentDocs(
	dir: string,
	input: GenerateAgentDocsInput = {},
): Promise<readonly string[]> {
	const { artifacts } = generateAgentDocs(input);
	const sorted: readonly AgentDocsArtifact[] = [...artifacts].sort(
		(left, right) => left.path.localeCompare(right.path),
	);
	for (const artifact of sorted) {
		const target = join(dir, artifact.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, normalizeText(artifact.content));
	}
	return sorted.map((artifact) => artifact.path);
}
