import { randomUUID } from "node:crypto";
import type {
	AgentRebindAction,
	IdentityMigrationEvent,
	IdentityService,
	ScopeEntry,
} from "@hobo/identity";
import {
	agentActionsForMigrationEvents,
	CREDENTIAL_AUDIT_RETENTION,
	isMigrationReactiveEvent,
} from "@hobo/identity";

import { isJsonString, type JsonValue } from "./json.js";
import {
	type CapabilityScope,
	MCP_TOOL_SURFACE,
	type ToolDescriptor,
} from "./tool-surface.js";

export const MCP_EVENTS_SCHEMA_VERSION = "hobo.mcp-events/v1";
export const MCP_TOOL_CALL_DECIDED = "mcp.ToolCallDecided";

export interface McpPrincipal {
	readonly kind: string;
	readonly id: string;
}

export interface AuthContext {
	readonly subject: string;
	readonly tenant: string;
	readonly principal: McpPrincipal;
	readonly scope: readonly ScopeEntry[];
}

export type ToolDecisionEffect = "allow" | "deny";

export interface AuthDecisionEvent {
	readonly id: string;
	readonly type: typeof MCP_TOOL_CALL_DECIDED;
	readonly schemaVersion: typeof MCP_EVENTS_SCHEMA_VERSION;
	readonly tenant: string;
	readonly seq: number;
	readonly time: string;
	readonly actor: McpPrincipal;
	readonly correlationId: string;
	readonly retention: typeof CREDENTIAL_AUDIT_RETENTION;
	readonly data: {
		readonly tool: string;
		readonly subject: string;
		readonly effect: ToolDecisionEffect;
		readonly reason: string;
	};
}

export interface ToolDecision {
	readonly effect: ToolDecisionEffect;
	readonly tool: string;
	readonly subject: string;
	readonly tenant: string;
	readonly reason: string;
	readonly event: AuthDecisionEvent;
}

export function scopeAuthorizesCapability(
	scope: readonly ScopeEntry[],
	capability: CapabilityScope,
): boolean {
	return scope.some(
		(entry) =>
			entry.port === capability.port &&
			entry.resource === capability.resource &&
			entry.verbs.includes(capability.verb),
	);
}

export function authorizedToolNames(
	auth: AuthContext,
	surface: readonly ToolDescriptor[] = MCP_TOOL_SURFACE,
): readonly string[] {
	return surface
		.filter((tool) => scopeAuthorizesCapability(auth.scope, tool.capability))
		.map((tool) => tool.name);
}

export function decideToolCall(input: {
	auth: AuthContext;
	tool: Pick<ToolDescriptor, "name" | "capability">;
	correlationId: string;
	seq: number;
	now?: string;
}): ToolDecision {
	const { auth, tool } = input;
	const allowed = scopeAuthorizesCapability(auth.scope, tool.capability);
	const effect: ToolDecisionEffect = allowed ? "allow" : "deny";
	const reason = allowed
		? `svid scope authorizes ${tool.capability.resource}`
		: `svid scope does not grant ${tool.capability.verb} on ${tool.capability.resource}`;
	const time = input.now ?? new Date().toISOString();
	const event: AuthDecisionEvent = {
		id: `evt-mcp-decided-${randomUUID()}`,
		type: MCP_TOOL_CALL_DECIDED,
		schemaVersion: MCP_EVENTS_SCHEMA_VERSION,
		tenant: auth.tenant,
		seq: input.seq,
		time,
		actor: auth.principal,
		correlationId: input.correlationId,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: { tool: tool.name, subject: auth.subject, effect, reason },
	};
	return {
		effect,
		tool: tool.name,
		subject: auth.subject,
		tenant: auth.tenant,
		reason,
		event,
	};
}

export interface InertOutputObservation {
	readonly tool: string;
	readonly subject: string;
	readonly recordedText: string;
	readonly authorizedToolsBefore: readonly string[];
	readonly authorizedToolsAfter: readonly string[];
	readonly widened: boolean;
}

export function observeToolOutput(input: {
	auth: AuthContext;
	tool: string;
	output: JsonValue;
	surface?: readonly ToolDescriptor[];
}): InertOutputObservation {
	const surface = input.surface ?? MCP_TOOL_SURFACE;
	const before = authorizedToolNames(input.auth, surface);
	const recordedText = isJsonString(input.output)
		? input.output
		: JSON.stringify(input.output);
	const after = authorizedToolNames(input.auth, surface);
	return {
		tool: input.tool,
		subject: input.auth.subject,
		recordedText,
		authorizedToolsBefore: before,
		authorizedToolsAfter: after,
		widened: !setsEqual(before, after),
	};
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((value) => set.has(value));
}

export type AuthResolution =
	| { readonly ok: true; readonly auth: AuthContext }
	| { readonly ok: false; readonly reason: string };

export async function resolveAuthContext(
	identity: IdentityService,
	input: {
		token: string;
		audience: string;
		principal?: McpPrincipal;
		now?: string;
	},
): Promise<AuthResolution> {
	const result = await identity.authenticateAtGateway({
		token: input.token,
		audience: input.audience,
		...(input.now !== undefined ? { now: input.now } : undefined),
	});
	if (result.status !== "authenticated") {
		return { ok: false, reason: result.reason };
	}
	return {
		ok: true,
		auth: {
			subject: result.subject,
			tenant: result.tenant,
			principal: input.principal ?? { kind: "agent", id: result.subject },
			scope: result.scope,
		},
	};
}

export function rebindAgentsOnMigrationEvents(
	events: readonly IdentityMigrationEvent[],
): readonly AgentRebindAction[] {
	const reactive = events.filter((e) => isMigrationReactiveEvent(e.type));
	return agentActionsForMigrationEvents(reactive);
}
