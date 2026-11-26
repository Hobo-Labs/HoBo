import { create } from "@bufbuild/protobuf";
import {
	type AcpAgentFactory,
	type AcpSessionFact,
	type AgentGuardrailPolicy,
	type AgentPrincipal,
	type AgentSandboxPosture,
	openGovernedSession,
	parseAgentGuardrailPolicy,
	replaySessionFacts,
} from "@hobo/connector-acp";

import {
	type SandboxAccessReport,
	SandboxAccessReportSchema,
	type SweTask,
	type SweTaskReport,
	SweTaskReportSchema,
	SweTaskSchema,
} from "./_generated/swe_task_pb.js";

// Shared SWE-task session shape every vendor adapter runs (HOBO-722..726).
// Vendor packages pass their connector id and keep launch/transcript local.
// Record shapes are the generated protobuf types (data-models/swe_task.proto);
// this module adds only the guardrail defaults, boundary parsing, and the
// report projections over audit facts.

/** public-contract: SWE-task report document schema id. */
export const SWE_TASK_REPORT_SCHEMA = "hobo.swe-task-report/v1";
/** public-contract: sandbox access-report document schema id. */
export const SANDBOX_REPORT_SCHEMA = "hobo.sandbox-access-report/v1";

export type {
	SandboxAccessReport,
	SweTask,
	SweTaskReport,
} from "./_generated/swe_task_pb.js";
export { SandboxAccessReportSchema, SweTaskReportSchema, SweTaskSchema };

/** Default SWE-task guardrails: workspace R/W + tests auto; deploy/destroy/token/admin gated. */
export function sweTaskPolicy(agentId: string): AgentGuardrailPolicy {
	return parseAgentGuardrailPolicy({
		agentId,
		actionClasses: {
			read: "auto-allow",
			write: "auto-allow",
			deploy: "require-approval",
			destroy: "deny",
			token: "deny",
			admin: "deny",
		},
		allowedApprovers: [],
	});
}

const IN_SCOPE_PREFIXES = ["workspace:", "tests:", "logs:"];

export interface SweTaskRunInput {
	/** Vendor connector id, e.g. `swe-claude`. */
	readonly connector: string;
	/** Parsed at the boundary via `create(SweTaskSchema, …)`. */
	readonly task: SweTask;
	readonly agent: AcpAgentFactory;
	readonly principal: AgentPrincipal;
	readonly policy?: AgentGuardrailPolicy;
	readonly sandbox?: AgentSandboxPosture;
	readonly onFact?: (fact: AcpSessionFact) => void;
}

// Non-wire type: composes the generated report messages with the live ACP
// session facts of one run, which are runtime objects and not serializable.
// parallel-type-allowed: deliberate non-wire composition; the proto SweTaskRunResult carries only fact_kinds, not live AcpSessionFact objects.
export interface SweTaskRunResult {
	readonly report: SweTaskReport;
	readonly sandboxReport: SandboxAccessReport;
	readonly facts: readonly AcpSessionFact[];
}

/** Run one governed SWE task; reports are projections over audit facts. */
export async function runSweTask(
	input: SweTaskRunInput,
): Promise<SweTaskRunResult> {
	const task = create(SweTaskSchema, input.task);
	const policy = input.policy ?? sweTaskPolicy(input.principal.id);
	const session = await openGovernedSession(
		input.onFact === undefined
			? {
					connector: input.connector,
					agent: input.agent,
					principal: input.principal,
					policy,
					cwd: task.workspace,
				}
			: {
					connector: input.connector,
					agent: input.agent,
					principal: input.principal,
					policy,
					cwd: task.workspace,
					onFact: input.onFact,
				},
	);
	const result = await session.prompt(task.instruction);
	return {
		report: extractSweTaskReport(task.taskId, result.facts),
		sandboxReport: buildSandboxAccessReport(task.workspace, result.facts),
		facts: result.facts,
	};
}

export function extractSweTaskReport(
	taskId: string,
	facts: readonly AcpSessionFact[],
): SweTaskReport {
	const replayed = replaySessionFacts(facts);
	const edits = replayed.decisions
		.filter(
			(decision) =>
				decision.effect === "allow" &&
				(decision.action.includes("edit") || decision.action.includes("write")),
		)
		.map((decision) => decision.action);
	return Object.freeze(
		create(SweTaskReportSchema, {
			schema: SWE_TASK_REPORT_SCHEMA,
			taskId,
			sessionId: replayed.sessionId,
			stopReason: replayed.stopReason ?? "unknown",
			edits,
			refusals: [...replayed.refusals],
			completed: replayed.closed && replayed.stopReason === "end_turn",
		}),
	);
}

export function buildSandboxAccessReport(
	workspaceRoot: string,
	facts: readonly AcpSessionFact[],
): SandboxAccessReport {
	const replayed = replaySessionFacts(facts);
	const granted = replayed.decisions
		.filter((decision) => decision.effect === "allow")
		.map((decision) => decision.action);
	const outOfScope = granted.filter(
		(action) => !IN_SCOPE_PREFIXES.some((prefix) => action.startsWith(prefix)),
	);
	return Object.freeze(
		create(SandboxAccessReportSchema, {
			schema: SANDBOX_REPORT_SCHEMA,
			workspaceRoot,
			grantedActions: granted,
			outOfScopeAccess: outOfScope,
			clean: outOfScope.length === 0,
		}),
	);
}
