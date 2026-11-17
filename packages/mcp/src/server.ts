import { randomUUID } from "node:crypto";
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
import { SECRET_CAPTURE_TOOL_NAMES } from "./secret-capture/app.js";
import {
	assertToolSurfaceParity,
	capabilityForTool,
	findTool,
	MCP_TOOL_SURFACE,
	type ParityReport,
	type ToolDescriptor,
} from "./tool-surface.js";

export interface ToolCallInput {
	readonly cwd?: string;
	readonly camp?: string;
	readonly args?: readonly string[];
}

export interface ToolCallResult {
	readonly ok: boolean;
	readonly tool: string;
	readonly status: string;
	readonly code: string;
	readonly output: unknown;
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
	readonly authorizeCaptureTool: (
		name: string,
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
	readonly cli: HoboCli;
	readonly surface?: readonly ToolDescriptor[];
	readonly auditSink?: (event: AuthDecisionEvent) => void | Promise<void>;
	readonly now?: () => string;
	readonly rateLimit?: RateLimitPolicy;
	readonly clock?: () => number;
	readonly rateLimitAuditSink?: (event: RateLimitEvent) => void | Promise<void>;
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

	async function record(event: AuthDecisionEvent): Promise<boolean> {
		try {
			await options.auditSink?.(event);
			auditEvents.push(event);
			return true;
		} catch {
			return false;
		}
	}

	async function recordThrottle(event: RateLimitEvent): Promise<boolean> {
		try {
			await options.rateLimitAuditSink?.(event);
			rateLimitEvents.push(event);
			return true;
		} catch {
			return false;
		}
	}

	async function authorize(
		name: string,
		auth: AuthContext,
		tool: Pick<ToolDescriptor, "name" | "capability"> | undefined,
		callOptions?: { correlationId?: string },
	): Promise<ToolCallResult> {
		const correlationId =
			callOptions?.correlationId ?? `mcp:${name}:${auth.subject}`;
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
				if (!(await recordThrottle(event))) return auditUnavailable(name);
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
		if (!tool) {
			const decision = deniedUnknown(
				name,
				auth,
				correlationId,
				nextSeq(),
				now(),
			);
			if (!(await record(decision.event))) return auditUnavailable(name);
			return {
				ok: false,
				tool: name,
				status: "denied",
				code: "MCP_UNKNOWN_TOOL",
				output: null,
				decision,
				error: { code: "MCP_UNKNOWN_TOOL", message: `unknown tool "${name}"` },
			};
		}
		const decision = decideToolCall({
			auth,
			tool,
			correlationId,
			seq: nextSeq(),
			now: now(),
		});
		if (!(await record(decision.event))) return auditUnavailable(name);
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
		return {
			ok: true,
			tool: tool.name,
			status: "authorized",
			code: "MCP_AUTHORIZED",
			output: null,
			decision,
		};
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
		authorizeCaptureTool(name, auth, callOptions) {
			const tool = SECRET_CAPTURE_TOOL_NAMES.includes(name)
				? { name, capability: capabilityForTool(name) }
				: undefined;
			return authorize(name, auth, tool, callOptions);
		},
		async callTool(name, input, auth, callOptions) {
			const tool = findTool(name, surface);
			const authorization = await authorize(name, auth, tool, callOptions);
			if (!authorization.ok || !tool) return authorization;

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
				decision: authorization.decision,
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

function auditUnavailable(tool: string): ToolCallResult {
	return {
		ok: false,
		tool,
		status: "unavailable",
		code: "MCP_AUDIT_UNAVAILABLE",
		output: null,
		error: {
			code: "MCP_AUDIT_UNAVAILABLE",
			message: "The audit record could not be saved.",
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
			id: `evt-mcp-decided-${randomUUID()}`,
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
