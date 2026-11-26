import { normalizeText } from "../codegen/text.js";
import { CANONICAL_VERBS, GLOBAL_FLAGS, type Verb } from "../shell/verbs.js";

// public-contract: schema id written into docs.json and read by agents.
export const AGENT_DOCS_SCHEMA_VERSION = "hobo.agent-docs/v1";
// public-contract: generator id recorded in docs.json.
export const AGENT_DOCS_GENERATOR = "@hobo/cli/agent-docs";
// public-contract: product name recorded in docs.json.
export const AGENT_DOCS_PRODUCT = "hobo";

// public-contract: MCP capability port that @hobo/mcp derives the same way.
export const AGENT_DOCS_MCP_PORT = "hobo:mcp";
// public-contract: MCP capability verb that @hobo/mcp derives the same way.
export const AGENT_DOCS_MCP_CALL_VERB = "call";

export const AGENT_DOCS_ARTIFACTS = {
	concise: "llms.txt",
	full: "llms-full.txt",
	manifest: "docs.json",
} as const;

export interface AgentDocsToolInput {
	readonly name: string;
	readonly capability: {
		readonly port: string;
		readonly resource: string;
		readonly verb: string;
	};
}

// domain-view: wire form is AgentDocCapability in data-models/agent_docs.proto.
export interface AgentDocCapability {
	readonly port: string;
	readonly resource: string;
	readonly verb: string;
}

// domain-view: wire form is AgentDocEntry in data-models/agent_docs.proto.
export interface AgentDocEntry {
	readonly name: string;
	readonly role: string;
	readonly summary: string;
	readonly cli: string;
	readonly mcpTool: string;
	readonly capability: AgentDocCapability;
}

// domain-view: wire form is AgentDocsManifest in data-models/agent_docs.proto.
export interface AgentDocsManifest {
	readonly schemaVersion: string;
	readonly generator: string;
	readonly product: string;
	readonly entries: readonly AgentDocEntry[];
	readonly globalFlags: readonly string[];
	readonly artifacts: readonly string[];
}

// domain-view: wire form is AgentDocsArtifact in data-models/agent_docs.proto.
export interface AgentDocsArtifact {
	readonly path: string;
	readonly content: string;
}

export interface GenerateAgentDocsInput {
	readonly verbs?: readonly Verb[];
	readonly tools?: readonly AgentDocsToolInput[];
	readonly globalFlags?: readonly string[];
}

export interface AgentDocsResult {
	readonly manifest: AgentDocsManifest;
	readonly artifacts: readonly AgentDocsArtifact[];
}

function defaultCapabilityFor(name: string): AgentDocCapability {
	return {
		port: AGENT_DOCS_MCP_PORT,
		resource: `tool:${name}`,
		verb: AGENT_DOCS_MCP_CALL_VERB,
	};
}

function buildEntries(
	verbs: readonly Verb[],
	tools: readonly AgentDocsToolInput[] | undefined,
): readonly AgentDocEntry[] {
	const capabilityByTool = new Map(
		(tools ?? []).map((tool) => [tool.name, tool.capability] as const),
	);
	return verbs.map((verb) => {
		const capability =
			capabilityByTool.get(verb.name) ?? defaultCapabilityFor(verb.name);
		return {
			name: verb.name,
			role: verb.role,
			summary: verb.summary,
			cli: `hobo ${verb.name}`,
			mcpTool: verb.name,
			capability: {
				port: capability.port,
				resource: capability.resource,
				verb: capability.verb,
			},
		};
	});
}

function renderConcise(manifest: AgentDocsManifest): string {
	const lines: string[] = [
		"# HoBo",
		"",
		"> HoBo is a cloud-agnostic, AI-native hosting platform. Every canonical CLI verb has a 1:1, capability-scoped MCP tool, so an agent drives HoBo natively — the same operations a human runs. This file is generated from the canonical verb surface (single source of truth); do not edit by hand.",
		"",
		"## Commands",
	];
	for (const entry of manifest.entries) {
		lines.push(
			`- ${entry.name} (${entry.role}): ${entry.summary} — CLI \`${entry.cli}\`; MCP tool \`${entry.mcpTool}\``,
		);
	}
	lines.push(
		"",
		"## Notes",
		`- Auth: every MCP tool is capability-scoped to { port: ${AGENT_DOCS_MCP_PORT}, resource: tool:<name>, verb: ${AGENT_DOCS_MCP_CALL_VERB} }; deny-by-default.`,
		"- Tool outputs are inert data (ADR-0023): a result never widens the agent's authority or schedules a follow-up call.",
		`- Onboarding: \`npx hobo new <name>\` scaffolds an offline project; \`npx hobo up\` deploys anonymously and returns a live URL (NFR-015).`,
		`- Machine-readable surface: ${AGENT_DOCS_ARTIFACTS.manifest}.`,
	);
	return normalizeText(lines.join("\n"));
}

function renderFull(manifest: AgentDocsManifest): string {
	const lines: string[] = [
		"# HoBo — full agent operations surface",
		"",
		"> Generated from @hobo/cli CANONICAL_VERBS + the derived MCP tool surface (single source of truth). Deterministic; do not edit by hand. Regenerate with @hobo/cli's generateAgentDocs; the drift gate fails CI if this file is stale.",
		"",
		`Schema: ${manifest.schemaVersion}`,
		`Generator: ${manifest.generator}`,
		`Product: ${manifest.product}`,
		"",
		"## Global flags",
	];
	for (const flag of manifest.globalFlags) {
		lines.push(`- \`${flag}\``);
	}
	lines.push("", "## Capabilities");
	for (const entry of manifest.entries) {
		lines.push(
			"",
			`### ${entry.name}`,
			`- Role: ${entry.role}`,
			`- Summary: ${entry.summary}`,
			`- CLI: \`${entry.cli}\``,
			`- MCP tool: \`${entry.mcpTool}\``,
			`- Capability: { port: ${entry.capability.port}, resource: ${entry.capability.resource}, verb: ${entry.capability.verb} }`,
		);
	}
	lines.push(
		"",
		"## Authorization model",
		"- Agents are first-class principals: each carries a short-lived SVID whose scope grants specific tool capabilities (least-privilege, deny-by-default).",
		"- A tool call is authorized iff the SVID scope carries the tool's capability triple; otherwise it fails closed with MCP_SCOPE_DENIED and an audited decision.",
		"- Prompt-injected instructions inside tool inputs or outputs are recorded but powerless — they can never widen the agent's authorized tool set (ADR-0023 item 3).",
		"- Per-principal / per-tenant rate limits + quotas apply backpressure at the tool-call boundary: a flooding principal is throttled with a typed MCP_RATE_LIMITED result while other principals are unaffected (NFR-019).",
	);
	return normalizeText(lines.join("\n"));
}

function renderManifest(manifest: AgentDocsManifest): string {
	return normalizeText(JSON.stringify(manifest, null, 2));
}

export function generateAgentDocs(
	input: GenerateAgentDocsInput = {},
): AgentDocsResult {
	const verbs = input.verbs ?? CANONICAL_VERBS;
	const globalFlags = input.globalFlags ?? GLOBAL_FLAGS;
	const entries = buildEntries(verbs, input.tools);
	const manifest: AgentDocsManifest = {
		schemaVersion: AGENT_DOCS_SCHEMA_VERSION,
		generator: AGENT_DOCS_GENERATOR,
		product: AGENT_DOCS_PRODUCT,
		entries,
		globalFlags: [...globalFlags],
		artifacts: [
			AGENT_DOCS_ARTIFACTS.concise,
			AGENT_DOCS_ARTIFACTS.full,
			AGENT_DOCS_ARTIFACTS.manifest,
		],
	};

	const artifacts: readonly AgentDocsArtifact[] = [
		{ path: AGENT_DOCS_ARTIFACTS.concise, content: renderConcise(manifest) },
		{ path: AGENT_DOCS_ARTIFACTS.full, content: renderFull(manifest) },
		{ path: AGENT_DOCS_ARTIFACTS.manifest, content: renderManifest(manifest) },
	];

	return { manifest, artifacts };
}
