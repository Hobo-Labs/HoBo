import { FreightOrigin } from "../_generated/cd_pb.js";

// refusal carries a remediation; `SHADOW_REQUIRED` (events.ts) is reused for
// an ENFORCE node without INFORM upstream (I23).
export const PIPELINE_REASON = Object.freeze({
	invalid: "pipeline-invalid",
	targets: "pipeline-node-targets",
	cycle: "pipeline-cycle",
	noSource: "pipeline-node-without-source",
	unknownSource: "pipeline-unknown-source",
	unknownUpstream: "pipeline-unknown-upstream",
	unknownCamp: "pipeline-unknown-camp",
	campOutsideProject: "pipeline-camp-outside-project",
	campNotManaged: "pipeline-camp-not-managed",
	duplicateCamp: "pipeline-camp-in-two-nodes",
	unknownPlacement: "pipeline-unknown-placement",
	unknownGroup: "pipeline-unknown-mandatory-group",
	placedFieldOnList: "pipeline-placed-field-on-list-node",
	previewNotLeaf: "pipeline-preview-not-leaf",
	matchUpstream: "pipeline-match-upstream-needs-one-upstream",
	availability: "pipeline-availability-invalid",
	policyMode: "pipeline-policy-mode-invalid",
	bindleTaken: "pipeline-bindle-has-pipeline",
	unauthorized: "pipeline-action-unauthorized",
	proposalOnly: "pipeline-proposal-only",
	conflict: "pipeline-journal-conflict",
} as const);

export const PIPELINE_METRIC = Object.freeze({
	applied: "hobo.cd.pipeline.applied",
	refused: "hobo.cd.pipeline.refused",
	freightAvailable: "hobo.cd.pipeline.freight_available",
	promotionRequested: "hobo.cd.pipeline.promotion_requested",
	promotionRefused: "hobo.cd.pipeline.promotion_refused",
	fanoutStarted: "hobo.cd.pipeline.fanout_started",
	blocked: "hobo.cd.pipeline.tick_blocked",
	unreadable: "hobo.cd.pipeline.unreadable",
} as const);

// (FreightIngest / `hobo up` record Freight without a source name).
export const ORIGIN_SOURCES: ReadonlyMap<string, FreightOrigin> = new Map([
	["origin:manifest", FreightOrigin.MANIFEST],
	["origin:attestation", FreightOrigin.ATTESTATION],
	["origin:cdevent", FreightOrigin.CDEVENT],
	["origin:hobo-ci", FreightOrigin.HOBO_CI],
	["origin:local-build", FreightOrigin.LOCAL_BUILD],
]);

// project is the segment of its id before the first "/".
export const PROJECT_LABEL = "hobo.cd/project" as const;
