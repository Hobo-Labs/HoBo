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

// S3-05 — the agent-docs freshness gate. Mirrors src/build/codegen-gate.ts
// (assertGeneratedFresh): regenerate the artifact set from the single source
// (CANONICAL_VERBS + the MCP tool surface), diff it against what is checked in,
// and fail on drift. `hobo codegen --check` is the sibling idiom; this is the
// same regenerate -> compare -> fail contract for the agent-docs surface. The
// CI wiring (S3-07) is out of scope; this is the library gate it will call.

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
		// Carried for reporting, never read back as JSON here -- the drift entries
		// this is handed are domain records, not `JsonValue` leaves.
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

/**
 * Compare a directory of checked-in agent-docs artifacts against a fresh
 * generation. Returns one drift entry per file that is missing or changed. Pure
 * relative to the generator, so `hobo`'s `--check` path and any CI gate agree by
 * construction.
 */
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

/**
 * Assert the checked-in agent-docs artifacts in `dir` are fresh. Throws an
 * AgentDocsError with HOBO_AGENT_DOCS_DRIFT (carrying the drift entries) when any
 * artifact is missing or stale — the fail-closed drift gate.
 */
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

/**
 * Write the generated agent-docs artifacts into `dir` (creating it as needed).
 * Returns the artifact-relative paths written.
 */
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
