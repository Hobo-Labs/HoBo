import type { HoboCli } from "@hobo/cli";
import { CREDENTIAL_AUDIT_RETENTION } from "@hobo/identity";

import {
	type AuthContext,
	type AuthDecisionEvent,
	authorizedToolNames,
	decideToolCall,
	type InertOutputObservation,
	MCP_EVENTS_SCHEMA_VERSION,
	MCP_TOOL_CALL_DECIDED,
	observeToolOutput,
	type ToolDecision,
} from "./auth.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import {
	createRateLimiter,
	createThrottleEvent,
	MCP_RATE_LIMITED_CODE,
	type RateLimitEvent,
	type RateLimiter,
	type RateLimitPolicy,
} from "./rate-limit.js";
import {
	assertToolSurfaceParity,
	findTool,
	MCP_TOOL_SURFACE,
	type ParityReport,
	type ToolDescriptor,
} from "./tool-surface.js";

// S3-01/S3-02 — the MCP server object. It exposes listTools()/callTool() and
// dispatches EVERY tool through the SAME @hobo/cli command registry the CLI
// uses (an injected HoboCli whose plan/up/down/login commands are wired to a
// YardRuntime). There is no second implementation of plan/up/down here: a tool
// call becomes `hobo <verb> --json` over the shared dispatch path. Auth is
// checked BEFORE dispatch (deny-by-default); results are inert data.

export interface ToolCallInput {
	readonly cwd?: string;
	readonly camp?: string;
	readonly args?: readonly string[];
}

// domain-view: the inert tool-call result; its wire form is McpToolCallResult
// in data-models/mcp.proto. `output` is pure data — the CLI envelope — and can
// never schedule or widen a follow-up call (ADR-0023 item 3).
export interface ToolCallResult {
	readonly ok: boolean;
	readonly tool: string;
	readonly status: string;
	readonly code: string;
	readonly output: unknown;
	// Present for scope allow/deny outcomes; absent when a call is refused for
	// backpressure (MCP_RATE_LIMITED) before the scope decision is reached.
	readonly decision?: ToolDecision;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface HoboMcpServer {
	readonly listTools: () => readonly ToolDescriptor[];
	readonly parity: () => ParityReport;
	readonly authorizedTools: (auth: AuthContext) => readonly string[];
	readonly callTool: (
		name: string,
		input: ToolCallInput,
		auth: AuthContext,
		options?: { correlationId?: string },
	) => Promise<ToolCallResult>;
	readonly observeToolOutput: (input: {
		auth: AuthContext;
		tool: string;
		output: JsonValue;
	}) => InertOutputObservation;
	readonly getAuditEvents: () => readonly AuthDecisionEvent[];
	readonly getRateLimitEvents: () => readonly RateLimitEvent[];
}

export interface CreateHoboMcpServerOptions {
	// The shared dispatch layer. Its plan/up/down/login command modules carry the
	// injected YardRuntime, exactly as the CLI tests wire them.
	readonly cli: HoboCli;
	readonly surface?: readonly ToolDescriptor[];
	readonly auditSink?: (event: AuthDecisionEvent) => void;
	readonly now?: () => string;
	// S3-06 — optional per-principal / per-tenant backpressure (NFR-019). When
	// absent, no throttling is applied (existing callers are unaffected). `clock`
	// is the monotonic millisecond source the limiter reads — injected so tests
	// are deterministic; it defaults to Date.now.
	readonly rateLimit?: RateLimitPolicy;
	readonly clock?: () => number;
	readonly rateLimitAuditSink?: (event: RateLimitEvent) => void;
}

export function createHoboMcpServer(
	options: CreateHoboMcpServerOptions,
): HoboMcpServer {
	const surface = options.surface ?? MCP_TOOL_SURFACE;
	const now = options.now ?? (() => new Date().toISOString());
	const clock = options.clock ?? (() => Date.now());
	const limiter: RateLimiter | undefined = options.rateLimit
		? createRateLimiter(options.rateLimit)
		: undefined;
	const auditEvents: AuthDecisionEvent[] = [];
	const rateLimitEvents: RateLimitEvent[] = [];
	let seq = 0;
	const nextSeq = (): number => (seq += 1);

	function record(event: AuthDecisionEvent): void {
		auditEvents.push(event);
		options.auditSink?.(event);
	}

	function recordThrottle(event: RateLimitEvent): void {
		rateLimitEvents.push(event);
		options.rateLimitAuditSink?.(event);
	}

	return {
		listTools() {
			return surface;
		},
		parity() {
			return assertToolSurfaceParity(surface);
		},
		authorizedTools(auth) {
			return authorizedToolNames(auth, surface);
		},
		async callTool(name, input, auth, callOptions) {
			const correlationId =
				callOptions?.correlationId ?? `mcp:${name}:${auth.subject}`;

			// S3-06 — backpressure BEFORE dispatch (NFR-019). Rate-limiting is the
			// outermost gate so a flooding principal is throttled regardless of scope
			// (even repeated denied calls consume budget), while a control principal
			// keyed by a different (tenant, principal) is unaffected. Fail-closed: an
			// exhausted principal gets a typed MCP_RATE_LIMITED result + audited fact.
			if (limiter) {
				const rl = limiter.check({
					tenant: auth.tenant,
					principal: auth.principal,
					now: clock(),
				});
				if (!rl.allowed) {
					const event = createThrottleEvent({
						tool: name,
						auth,
						decision: rl,
						correlationId,
						seq: nextSeq(),
						now: now(),
					});
					recordThrottle(event);
					return {
						ok: false,
						tool: name,
						status: "throttled",
						code: MCP_RATE_LIMITED_CODE,
						output: null,
						error: {
							code: MCP_RATE_LIMITED_CODE,
							message: `rate limit exceeded (${rl.reason}); retry after ${rl.retryAfterMs}ms`,
						},
					};
				}
			}

			const tool = findTool(name, surface);
			if (!tool) {
				// Unknown tools are not part of the derived surface — fail closed.
				const decision = deniedUnknown(
					name,
					auth,
					correlationId,
					nextSeq(),
					now(),
				);
				record(decision.event);
				return {
					ok: false,
					tool: name,
					status: "denied",
					code: "MCP_UNKNOWN_TOOL",
					output: null,
					decision,
					error: {
						code: "MCP_UNKNOWN_TOOL",
						message: `unknown tool "${name}"`,
					},
				};
			}

			const decision = decideToolCall({
				auth,
				tool,
				correlationId,
				seq: nextSeq(),
				now: now(),
			});
			record(decision.event);

			// Deny-by-default: the scope check gates BEFORE the shared dispatch runs.
			if (decision.effect === "deny") {
				return {
					ok: false,
					tool: tool.name,
					status: "denied",
					code: "MCP_SCOPE_DENIED",
					output: null,
					decision,
					error: { code: "MCP_SCOPE_DENIED", message: decision.reason },
				};
			}

			// Authorized: dispatch through the SAME registry the CLI uses.
			const argv = buildArgv(tool.verb, input);
			const runOptions = input.cwd !== undefined ? { cwd: input.cwd } : {};
			const run = await options.cli.run(argv, runOptions);
			const envelope = parseEnvelope(run.stdout);

			return {
				ok: run.exitCode === 0 && envelope.ok !== false,
				tool: tool.name,
				status: isJsonString(envelope.status) ? envelope.status : "unknown",
				code: isJsonString(envelope.code) ? envelope.code : "HOBO_OK",
				output: envelope,
				decision,
			};
		},
		observeToolOutput(input) {
			return observeToolOutput({ ...input, surface });
		},
		getAuditEvents() {
			return [...auditEvents];
		},
		getRateLimitEvents() {
			return [...rateLimitEvents];
		},
	};
}

function buildArgv(verb: string, input: ToolCallInput): string[] {
	const argv = [verb, "--json"];
	if (input.camp !== undefined) {
		argv.push("--camp", input.camp);
	}
	if (input.args) {
		argv.push(...input.args);
	}
	return argv;
}

export interface CliEnvelope {
	ok?: boolean;
	status?: string;
	code?: string;
	raw?: string;
	data?: JsonValue;
}

function parseEnvelope(stdout: string): CliEnvelope {
	try {
		const parsed = JSON.parse(stdout);
		if (isJsonObject(parsed)) {
			const envelope: CliEnvelope = {};
			if (parsed.ok === true || parsed.ok === false) envelope.ok = parsed.ok;
			if (isJsonString(parsed.status)) envelope.status = parsed.status;
			if (isJsonString(parsed.code)) envelope.code = parsed.code;
			if (parsed.data !== undefined) envelope.data = parsed.data;
			return envelope;
		}
		return { raw: stdout };
	} catch {
		return { raw: stdout };
	}
}

function deniedUnknown(
	name: string,
	auth: AuthContext,
	correlationId: string,
	seq: number,
	time: string,
): ToolDecision {
	const reason = `unknown tool "${name}"`;
	return {
		effect: "deny",
		tool: name,
		subject: auth.subject,
		tenant: auth.tenant,
		reason,
		event: {
			id: `evt-mcp-decided-${name}-${seq}`,
			type: MCP_TOOL_CALL_DECIDED,
			schemaVersion: MCP_EVENTS_SCHEMA_VERSION,
			tenant: auth.tenant,
			seq,
			time,
			actor: auth.principal,
			correlationId,
			retention: CREDENTIAL_AUDIT_RETENTION,
			data: { tool: name, subject: auth.subject, effect: "deny", reason },
		},
	};
}
