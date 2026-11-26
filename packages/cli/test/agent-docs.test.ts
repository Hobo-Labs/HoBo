import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AGENT_DOCS_ARTIFACTS,
	AgentDocsError,
	assertAgentDocsFresh,
	CANONICAL_VERBS,
	compareAgentDocs,
	generateAgentDocs,
	writeAgentDocs,
} from "../src/index.js";

// S3-05 — the agent-docs surface is generated from CANONICAL_VERBS (single
// source of truth): it covers every canonical verb, invents none, is
// byte-deterministic, and is drift-gated exactly like `hobo codegen --check`.

const checkedInDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../agent-docs",
);

describe("agent-docs generation covers the canonical verb surface", () => {
	it("emits one manifest entry per canonical verb — none missing, none invented", () => {
		const { manifest } = generateAgentDocs();
		expect(manifest.entries.map((entry) => entry.name)).toEqual(
			CANONICAL_VERBS.map((verb) => verb.name),
		);
		// Every entry is a real canonical verb (no invented tool).
		const canonical = new Set(CANONICAL_VERBS.map((verb) => verb.name));
		for (const entry of manifest.entries) {
			expect(canonical.has(entry.name)).toBe(true);
			expect(entry.mcpTool).toBe(entry.name);
			expect(entry.capability).toEqual({
				port: "hobo:mcp",
				resource: `tool:${entry.name}`,
				verb: "call",
			});
		}
	});

	it("every verb appears in llms.txt and llms-full.txt", () => {
		const { artifacts } = generateAgentDocs();
		const concise = artifacts.find(
			(a) => a.path === AGENT_DOCS_ARTIFACTS.concise,
		);
		const full = artifacts.find((a) => a.path === AGENT_DOCS_ARTIFACTS.full);
		expect(concise).toBeDefined();
		expect(full).toBeDefined();
		for (const verb of CANONICAL_VERBS) {
			expect(concise?.content).toContain(`hobo ${verb.name}`);
			expect(full?.content).toContain(`### ${verb.name}`);
		}
	});

	it("emits exactly the three well-known artifacts", () => {
		const { artifacts } = generateAgentDocs();
		expect(artifacts.map((a) => a.path)).toEqual([
			AGENT_DOCS_ARTIFACTS.concise,
			AGENT_DOCS_ARTIFACTS.full,
			AGENT_DOCS_ARTIFACTS.manifest,
		]);
		const manifest = artifacts.find(
			(a) => a.path === AGENT_DOCS_ARTIFACTS.manifest,
		);
		const parsed = JSON.parse(manifest?.content ?? "{}");
		expect(parsed.entries).toHaveLength(CANONICAL_VERBS.length);
	});

	it("tracks a mutated verb list (proving projection, not hardcoding)", () => {
		const { manifest } = generateAgentDocs({
			verbs: [{ name: "plan", role: "read-only", summary: "dry-run" }],
		});
		expect(manifest.entries).toHaveLength(1);
		expect(manifest.entries[0]?.name).toBe("plan");
	});

	it("uses an injected MCP tool surface's capability when supplied", () => {
		const { manifest } = generateAgentDocs({
			verbs: [{ name: "plan", role: "read-only", summary: "dry-run" }],
			tools: [
				{
					name: "plan",
					capability: { port: "hobo:mcp", resource: "tool:plan", verb: "call" },
				},
			],
		});
		expect(manifest.entries[0]?.capability.resource).toBe("tool:plan");
	});
});

describe("agent-docs output is deterministic", () => {
	it("produces byte-identical artifacts across two runs", () => {
		const first = generateAgentDocs().artifacts;
		const second = generateAgentDocs().artifacts;
		expect(second.map((a) => a.content)).toEqual(first.map((a) => a.content));
	});
});

describe("agent-docs drift gate (mirrors hobo codegen --check)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hobo-agent-docs-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("passes on a freshly written tree", async () => {
		await writeAgentDocs(dir);
		await expect(assertAgentDocsFresh(dir)).resolves.toBeUndefined();
		expect(await compareAgentDocs(dir)).toEqual([]);
	});

	it("fails closed on a hand-edited artifact (changed)", async () => {
		await writeAgentDocs(dir);
		await writeFile(
			join(dir, AGENT_DOCS_ARTIFACTS.concise),
			"hand-edited drift\n",
		);

		const drift = await compareAgentDocs(dir);
		expect(drift.map((entry) => entry.path)).toContain(
			AGENT_DOCS_ARTIFACTS.concise,
		);
		expect(
			drift.find((entry) => entry.path === AGENT_DOCS_ARTIFACTS.concise)
				?.status,
		).toBe("changed");

		await expect(assertAgentDocsFresh(dir)).rejects.toBeInstanceOf(
			AgentDocsError,
		);
		await expect(assertAgentDocsFresh(dir)).rejects.toMatchObject({
			code: "HOBO_AGENT_DOCS_DRIFT",
		});
	});

	it("fails closed on a missing artifact", async () => {
		await writeAgentDocs(dir);
		await rm(join(dir, AGENT_DOCS_ARTIFACTS.manifest));

		const drift = await compareAgentDocs(dir);
		expect(
			drift.find((entry) => entry.path === AGENT_DOCS_ARTIFACTS.manifest)
				?.status,
		).toBe("missing");
		await expect(assertAgentDocsFresh(dir)).rejects.toMatchObject({
			code: "HOBO_AGENT_DOCS_DRIFT",
		});
	});
});

describe("checked-in agent-docs artifacts stay fresh", () => {
	it("the packages/cli/agent-docs tree matches a fresh generation", async () => {
		// Guards the repo: adding/removing a canonical verb without regenerating
		// the agent-docs surface fails here, exactly as `hobo build` asserts
		// generated-tree freshness.
		await expect(assertAgentDocsFresh(checkedInDir)).resolves.toBeUndefined();
	});

	it("docs.json on disk parses and covers every verb", async () => {
		const raw = await readFile(
			join(checkedInDir, AGENT_DOCS_ARTIFACTS.manifest),
			"utf8",
		);
		const parsed = JSON.parse(raw);
		expect(parsed.entries.map((entry: { name: string }) => entry.name)).toEqual(
			CANONICAL_VERBS.map((verb) => verb.name),
		);
	});
});
