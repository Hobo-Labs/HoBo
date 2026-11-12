// `@hobo/cd/promotion` (WP6): the promotion saga, previews, and the adapters
// it composes (planning, gate, approvals, Trails, hooks). See README.md.
export {
	type A2HApproverDeps,
	APPROVAL_REASON,
	APPROVAL_REQUESTED_TYPE,
	APPROVAL_SUBJECT_PREFIX,
	type ApprovalSubject,
	approvalSubject,
	createA2HApprover,
	createApprovalLedger,
	createWebhookApprover,
	type HumanApprover,
	parseApprovalSubject,
	type WebhookApprover,
	type WebhookApproverDeps,
} from "../adapters/approval.js";
export {
	type ContractState,
	createDeployGate,
	createFanoutAggregateGate,
	type DeployGateDeps,
	type EnforcedRail,
	type FanoutAggregateDeps,
	type FanoutAggregateGate,
	GATE_REASON,
	PREVIEW_LABEL,
	type StationBudget,
	topologyOf,
} from "../adapters/gatekeeper.js";
export {
	createCloudEventsNotifier,
	createHookRunner,
	HOOK_REASON,
	type HookRunner,
	type HookSubject,
	hookPointName,
	NOTIFY_EVENT_TYPE,
} from "../adapters/hooks.js";
export {
	type CampPlanning,
	createPlanningResolver,
	DEFAULT_DATA_PORTS,
	type Declaration,
	deltaIdFor,
	diffResolvedSets,
	PLANNING_REASON,
	type PlanningDeps,
	sealResolved,
} from "../adapters/planning.js";
export {
	createTrailsMigrations,
	type DataMigrationRun,
	MIGRATION_LABEL,
	TRAILS_REASON,
	type TrailsDeps,
	type TrailsMigration,
	type TrailsMigrations,
	type TrailsPhase,
} from "../adapters/trails.js";
export {
	PREVIEW_CAMP_SEPARATOR,
	previewCampIdFor,
	previewPromotionIdFor,
	previewSourceOf,
	promotionIdFor,
	rollbackIdFor,
} from "./ids.js";
export {
	PROMOTION_METRIC,
	PROMOTION_REASON,
	type PromotionReasonCode,
} from "./reasons.js";
export { createPromotionService, type PromotionServiceDeps } from "./service.js";
export {
	foldPromotion,
	PROMOTION_SAGA,
	type PromotionView,
	recordOf,
	SAGA_FACT,
	STEP,
	type StepName,
} from "./state.js";
