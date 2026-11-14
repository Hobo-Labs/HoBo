// `@hobo/cd/authz` — delivery authorization (WP19, D15, I10).
export {
	type AgentGrants,
	AUTHZ_METRICS,
	type CdAuthorizerDeps,
	type CdDecisionAuthorizer,
	createCdAuthorizer,
	principalKey,
} from "./authorizer.js";
export {
	AUTHZ_FAILURES,
	type AuthzFailureCode,
	authzReason,
	authzRefusal,
} from "./errors.js";
export {
	AUTHZ_DECIDED_EVENT,
	AUTHZ_DECISION_SCHEMA,
	AUTHZ_STREAMS,
	type AuthzDecision,
	type AuthzEffect,
	authzDecisionJson,
	isGrant,
	parseAuthzDecision,
} from "./events.js";
export {
	agentGrantScope,
	CD_ACTION_SPECS,
	CD_ACTIONS,
	CD_BASELINE_PACK_ID,
	CD_BASELINE_PACK_VERSION,
	CD_POLICY_ACTION_PREFIX,
	type CdActionSpec,
	type CdPolicyPhase,
	type CdRuleContext,
	cdBaselineRules,
	createCdBaselinePack,
	isCdAction,
	policyActionName,
} from "./rules.js";
