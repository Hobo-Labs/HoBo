import {
	type AgentGuardrailPolicy,
	parseAgentGuardrailPolicy,
} from "./policy.js";
import {
	type GovernedSession,
	type GovernedSessionOptions,
	openGovernedSession,
} from "./session.js";

export const ISSUE_CLAIM_ACTION = ["linear", "issue", "claim"].join(":");

export interface IssueWorkerPolicyOptions {
	readonly agentId: string;
	readonly spendCapUsd?: number;
	readonly allowedApprovers?: readonly string[];
}

export function issueWorkerPolicy(
	options: IssueWorkerPolicyOptions,
): AgentGuardrailPolicy {
	return parseAgentGuardrailPolicy({
		agentId: options.agentId,
		actionClasses: {
			read: "auto-allow",
			write: "auto-allow",
			deploy: "require-approval",
			destroy: "deny",
			token: "deny",
			admin: "deny",
		},
		allowedApprovers: [...(options.allowedApprovers ?? [])],
		spendCapUsd: options.spendCapUsd ?? 0,
		actionQuotas: { [ISSUE_CLAIM_ACTION]: 1 },
	});
}

export type IssueWorkerSessionOptions = Omit<
	GovernedSessionOptions,
	"policy" | "resolveAction"
> & {
	readonly spendCapUsd?: number;
	readonly allowedApprovers?: readonly string[];
	readonly resolveAction: NonNullable<GovernedSessionOptions["resolveAction"]>;
};

export function openIssueWorkerSession(
	options: IssueWorkerSessionOptions,
): Promise<GovernedSession> {
	const { allowedApprovers, spendCapUsd, ...sessionOptions } = options;
	if (!sessionOptions.resolveAction) {
		throw new Error("connector-acp: issue worker requires resolveAction");
	}
	return openGovernedSession({
		...sessionOptions,
		policy: issueWorkerPolicy({
			agentId: options.principal.id,
			...(spendCapUsd === undefined ? undefined : { spendCapUsd }),
			...(allowedApprovers === undefined ? undefined : { allowedApprovers }),
		}),
	});
}
