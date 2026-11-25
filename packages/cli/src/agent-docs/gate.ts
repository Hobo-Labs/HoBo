import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { digest, normalizeText } from "../codegen/text.js";
import type { JsonObject } from "../json.js";
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
		readonly detail: Readonly<Record<string, unknown>> = {},
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

export async function compareAgentDocs(
	dir: string,
	input: GenerateAgentDocsInput = {},
): Promise<readonly AgentDocsDriftEntry[]> {
	const { artifacts } = generateAgentDocs(input);
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
	return drift;
}

export async function assertAgentDocsFresh(
	dir: string,
	input: GenerateAgentDocsInput = {},
): Promise<void> {
	const drift = await compareAgentDocs(dir, input);
	if (drift.length > 0) {
		throw new AgentDocsError(
			"HOBO_AGENT_DOCS_DRIFT",
			"agent docs drift detected; run generateAgentDocs to refresh llms.txt/llms-full.txt/docs.json",
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
