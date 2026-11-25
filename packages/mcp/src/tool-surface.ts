import { CANONICAL_VERBS } from "@hobo/cli";

type CanonicalVerb = (typeof CANONICAL_VERBS)[number];

// public-contract: S3-01 — the MCP tool surface is DERIVED from @hobo/cli's CANONICAL_VERBS, not hand-maintained. Every tool maps 1:1 to a canonical CLI verb and dispatches
export const MCP_TOOL_PORT = "hobo:mcp";
// public-contract: MCP tool dispatch verb for CLI parity.
export const MCP_TOOL_CALL_VERB = "call";

// domain-view: the required-capability triple; its wire form is
export interface CapabilityScope {
	readonly port: string;
	readonly resource: string;
	readonly verb: string;
}

export const TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		cwd: { type: "string", description: "HoBo project directory to resolve" },
		camp: { type: "string", description: "target Camp" },
		args: { type: "array", items: { type: "string" } },
	},
	additionalProperties: false,
} as const;

// domain-view: one derived MCP tool descriptor; its wire form is
export interface ToolDescriptor {
	readonly name: string;
	readonly verb: string;
	readonly role: string;
	readonly summary: string;
	readonly capability: CapabilityScope;
	readonly inputSchema: typeof TOOL_INPUT_SCHEMA;
}

export function capabilityForTool(name: string): CapabilityScope {
	return {
		port: MCP_TOOL_PORT,
		resource: `tool:${name}`,
		verb: MCP_TOOL_CALL_VERB,
	};
}

export function deriveToolSurface(
	verbs: readonly CanonicalVerb[] = CANONICAL_VERBS,
): readonly ToolDescriptor[] {
	return verbs.map((verb) => ({
		name: verb.name,
		verb: verb.name,
		role: verb.role,
		summary: verb.summary,
		capability: capabilityForTool(verb.name),
		inputSchema: TOOL_INPUT_SCHEMA,
	}));
}

export const MCP_TOOL_SURFACE: readonly ToolDescriptor[] = deriveToolSurface();

export function findTool(
	name: string,
	surface: readonly ToolDescriptor[] = MCP_TOOL_SURFACE,
): ToolDescriptor | undefined {
	return surface.find((tool) => tool.name === name);
}

export interface ParityReport {
	readonly ok: boolean;
	readonly toolVerbs: readonly string[];
	readonly canonicalVerbs: readonly string[];
	readonly missing: readonly string[];
	readonly extra: readonly string[];
}

export function assertToolSurfaceParity(
	surface: readonly ToolDescriptor[] = MCP_TOOL_SURFACE,
	verbs: readonly CanonicalVerb[] = CANONICAL_VERBS,
): ParityReport {
	const canonicalVerbs = verbs.map((verb) => verb.name);
	const toolVerbs = surface.map((tool) => tool.verb);
	const canonicalSet = new Set(canonicalVerbs);
	const toolSet = new Set(toolVerbs);
	const missing = canonicalVerbs.filter((verb) => !toolSet.has(verb));
	const extra = toolVerbs.filter((verb) => !canonicalSet.has(verb));
	const sameLength = toolVerbs.length === canonicalVerbs.length;
	return {
		ok: missing.length === 0 && extra.length === 0 && sameLength,
		toolVerbs,
		canonicalVerbs,
		missing,
		extra,
	};
}
