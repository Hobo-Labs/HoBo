import { CANONICAL_VERBS } from "@hobo/cli";

// S3-01 — the MCP tool surface is DERIVED from @hobo/cli's CANONICAL_VERBS, not
// hand-maintained. Every tool maps 1:1 to a canonical CLI verb and dispatches
// through the same command registry (server.ts), so the agent-facing surface
// can never drift from the CLI surface (NFR-004 parity). The design's curated
// §6.4 list (plan/deploy/promote/…) is a documentation view over this same
// verb surface — `deploy` is the `up` lifecycle verb, `get_drift` the `drift`
// verb, etc. The structural invariant enforced here is the stronger one: the
// tool set EQUALS the verb set; a divergent hand-list fails assertToolSurfaceParity.

// A canonical verb, as re-exported by @hobo/cli.
type CanonicalVerb = (typeof CANONICAL_VERBS)[number];

// The MCP capability port + call verb. Tokens are scoped to (port, resource,
// action) per ai-native-agent-auth.md §6.2; a tool's required grant is
// { port: "hobo:mcp", resource: "tool:<name>", verb: "call" }.
export const MCP_TOOL_PORT = "hobo:mcp";
export const MCP_TOOL_CALL_VERB = "call";

// domain-view: the required-capability triple; its wire form is
// McpCapabilityScope in data-models/mcp.proto. Named distinctly from the proto
// message so it is a derived domain type, not a parallel wire declaration.
export interface CapabilityScope {
	readonly port: string;
	readonly resource: string;
	readonly verb: string;
}

// The JSON-schema view of a tool's input. Tools take an optional project
// directory + Camp selector + passthrough args, matching the CLI global flags.
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
// McpToolDescriptor in data-models/mcp.proto.
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

// The canonical, checked-in tool surface.
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

// Structural parity: the set of verbs the tools dispatch to must EQUAL the
// canonical verb surface. Feeding a divergent hand-list (a dropped or invented
// tool) yields ok:false — this is the NFR-004 guard the parity test exercises.
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
