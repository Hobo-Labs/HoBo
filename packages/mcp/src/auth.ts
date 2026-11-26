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

// S3-02 — capability-scoped MCP auth. This module COMPOSES @hobo/identity (it
// reuses its ScopeEntry vocabulary + gateway verification, never reimplements
// SVID issuance) to answer one question per tool call: does the caller's SVID
// scope authorize this tool's required capability? Deny-by-default. Every
// decision is an audited credential-audit fact. It also models the ADR-0023
// inert-tool-output invariant: a tool result is pure data that can never widen
// the caller's authorized tool set.

// public-contract: MCP auth decision event schema version.
export const MCP_EVENTS_SCHEMA_VERSION = "hobo.mcp-events/v1";
// public-contract: audited MCP tool-call decision event type.
export const MCP_TOOL_CALL_DECIDED = "mcp.ToolCallDecided";

export interface McpPrincipal {
	readonly kind: string;
	readonly id: string;
}

// The resolved caller: an SVID subject + tenant + its granted scope. The scope
// is exactly @hobo/identity's ScopeEntry[] — the same shape
// IdentityService.authenticateAtGateway returns — so there is one scope model
// across the CLI gateway and the MCP surface.
export interface AuthContext {
	readonly subject: string;
	readonly tenant: string;
	readonly principal: McpPrincipal;
	readonly scope: readonly ScopeEntry[];
}

export type ToolDecisionEffect = "allow" | "deny";

// domain-view: the audited decision fact; its wire form is
// McpAuthDecisionEvent in data-models/mcp.proto. Carries the never-compact
// credential-audit retention so the S3-04 CredentialAudit projection can fold
// it off the same stream as identity.*/token.* events.
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

// Deny-by-default scope check: the SVID must carry an entry whose (port,
// resource) matches the tool's required capability and whose verbs include the
// call verb. No match → denied.
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

// The set of tool names the caller may invoke, derived PURELY from the SVID
// scope. This is the anchor of the inert-output invariant: nothing but the
// SVID's own grants can appear here — never a tool's output.
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
	tool: ToolDescriptor;
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
		id: `evt-mcp-decided-${tool.name}-${input.seq}`,
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

// domain-view: the recorded, powerless observation of a tool output; its wire
// form is McpToolOutputObservation in data-models/mcp.proto.
export interface InertOutputObservation {
	readonly tool: string;
	readonly subject: string;
	readonly recordedText: string;
	readonly authorizedToolsBefore: readonly string[];
	readonly authorizedToolsAfter: readonly string[];
	readonly widened: boolean;
}

// The inert-output invariant, modelled + provable (ADR-0023 item 3). Whatever a
// tool result carries — including a prompt-injected "instruction" — is recorded
// as untrusted text, then the caller's authorized tool set is RECOMPUTED from
// the SVID scope alone. Because the scope is never touched, before == after and
// `widened` is always false: an output cannot expand what the next call may do.
export function observeToolOutput(input: {
	auth: AuthContext;
	tool: string;
	output: JsonValue;
	surface?: readonly ToolDescriptor[];
}): InertOutputObservation {
	const surface = input.surface ?? MCP_TOOL_SURFACE;
	const before = authorizedToolNames(input.auth, surface);
	// The output is data. It is recorded for audit but has no authority.
	const recordedText = isJsonString(input.output)
		? input.output
		: JSON.stringify(input.output);
	// Recompute from the SVID scope — the ONLY source of authority.
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

// Compose @hobo/identity end-to-end: verify a presented JWT-SVID at the Yard
// gateway and lift the verified subject/tenant/scope into an AuthContext. This
// is the real resolution path (no reimplementation of verification here); tests
// may also construct an AuthContext directly from an already-resolved SVID.
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

/**
 * Zero-config agent re-attest on identity.Migrated (ADR-0132).
 * MCP subscriptions / sessions call this on delivered migration events —
 * no agent or Bindle configuration required.
 */
export function rebindAgentsOnMigrationEvents(
	events: readonly IdentityMigrationEvent[],
): readonly AgentRebindAction[] {
	const reactive = events.filter((e) => isMigrationReactiveEvent(e.type));
	return agentActionsForMigrationEvents(reactive);
}
