// CUE constraints for the pipeline-graph records in cd.proto (WP5: D4, D21,
// D24). Values are protobuf JSON (camelCase fields, enum names, uint64 as
// decimal strings). Proto3 JSON omits default values, so scalar fields are
// optional unless the record is meaningless without them. Self-contained (no
// package clause): `cue vet -d '#Pipeline' pipelines.cue pipeline.json`.
//
// Graph rules that need more than one record (acyclic, upstream nodes exist,
// sources and Camps exist, preview nodes are leaves, ENFORCE after INFORM,
// at least one source per node) live in the parse boundary
// `validatePipeline` (src/pipelines/graph.ts); test/pipelines/cue.test.ts
// checks that the two agree on everything CUE can express.

import (
	"list"
	"strings"
)

#Slug:      =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Text:      string & !="" & strings.MaxRunes(1024)
#UInt64:    =~"^[0-9]+$"
#Percent:   int & >=0 & <=100

#Availability:   "AVAILABILITY_UNSPECIFIED" | "AVAILABILITY_ONE_OF" | "AVAILABILITY_ALL" | "AVAILABILITY_QUORUM"
#AutoPromotion:  "AUTO_PROMOTION_UNSPECIFIED" | "AUTO_PROMOTION_DISABLED" | "AUTO_PROMOTION_NEWEST" | "AUTO_PROMOTION_MATCH_UPSTREAM" | "AUTO_PROMOTION_MATCH_NODE"
#RolloutStrategy: "ROLLOUT_STRATEGY_UNSPECIFIED" | "ROLLOUT_STRATEGY_ALL_AT_ONCE" | "ROLLOUT_STRATEGY_CANARY" | "ROLLOUT_STRATEGY_BLUE_GREEN" | "ROLLOUT_STRATEGY_EXPERIMENT"
#PolicyMode:      "POLICY_MODE_INFORM" | "POLICY_MODE_ENFORCE"
#FanoutStrategy:  "FANOUT_STRATEGY_UNSPECIFIED" | "FANOUT_STRATEGY_ALL" | "FANOUT_STRATEGY_PROGRESSIVE" | "FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP"
#DepartureAction: "DEPARTURE_ACTION_UNSPECIFIED" | "DEPARTURE_ACTION_DELETE" | "DEPARTURE_ACTION_ORPHAN" | "DEPARTURE_ACTION_ORPHAN_DATA"
#PurgeMode:       "PURGE_MODE_UNSPECIFIED" | "PURGE_MODE_GRACEFUL" | "PURGE_MODE_NEVER" | "PURGE_MODE_IMMEDIATE"

#HookRecord: {
	kind:  "HOOK_KIND_RUNBOOK" | "HOOK_KIND_NOTIFY" | "HOOK_KIND_SUITE"
	point: "HOOK_POINT_BEFORE_APPLY" | "HOOK_POINT_AFTER_CONVERGED" | "HOOK_POINT_AFTER_QUALIFIED" | "HOOK_POINT_ON_FAILURE"
	ref:   #Text
}

#FanoutRecord: {
	strategy?:              #FanoutStrategy
	maxConcurrency?:        int & >=0
	maxConcurrencyPercent?: #Percent
	minSuccessMs?:          #UInt64
	progressDeadlineMs?:    #UInt64
	maxFailures?:           int & >=0
	maxFailuresPercent?:    #Percent
	mandatoryGroups?: [...#Slug]
	rollbackOnHalt?: bool
}

#QuorumRecord: {
	minQualified?:        int & >=0
	minQualifiedPercent?: #Percent
}

#FailoverPolicyRecord: {
	purge?:   #PurgeMode
	graceMs?: #UInt64
	handoverOutputs?: [...#Text]
}

// Rising strictly within 1–100 and ending at 100 is checked by the parse boundary.
#StagePercents: [...int & >=1 & <=100] & list.MaxItems(16)

// Fields every node may carry.
#NodeCommon: {
	name: #Slug
	fromSources?: [...string & !=""]
	fromNodes?: [...#Slug]
	availability?:   #Availability
	requiredSoakMs?: #UInt64
	autoPromotion?:  #AutoPromotion
	strategy?:       #RolloutStrategy
	// Owned by WP9 (verification.cue); structurally open here.
	verification?: {...}
	windows?: [...#Slug]
	hooks?: [...#HookRecord]
	approvalRequired?: bool
	stagePercents?:    #StagePercents
	quorum?:           #QuorumRecord
}

// A node that lists its Camps: no placement, no fan-out, failover or departure.
#ListNode: {
	#NodeCommon
	campIds: [string & !="", ...string & !=""]
	placement?:    ""
	previewTtlMs?: #UInt64
}

// A fleet node: exactly a Placement (D21), never a Camp list, never a preview.
#PlacedNode: {
	#NodeCommon
	campIds?: []
	placement: #Slug
	fanout?:    #FanoutRecord
	departure?: #DepartureAction
	failover?:  #FailoverPolicyRecord
	previewTtlMs?: "0"
}

// Exactly one of campIds or placement. policy_mode appears only in RAIL
// pipelines, and every RAIL node has one (D24).
#BindleNode: #ListNode | #PlacedNode
#RailNode:   {#ListNode, policyMode: #PolicyMode} | {#PlacedNode, policyMode: #PolicyMode}

#PipelineBase: {
	schemaVersion?: "hobo.cd.pipeline/v1"
	name:           #Slug
	bindle:         #Text
	definedBy?:     string
}

#PipelineRecord: {
	#PipelineBase
	subject: "FREIGHT_SUBJECT_BINDLE"
	nodes: [#BindleNode, ...#BindleNode]
} | {
	#PipelineBase
	subject: "FREIGHT_SUBJECT_RAIL"
	nodes: [#RailNode, ...#RailNode]
}

// The recorded (parsed) form: the controller normalizes UNSPECIFIED to BINDLE,
// so `subject` is always explicit in a `pipeline.Applied` body.
#Pipeline: #PipelineRecord

#FreightAvailabilityRecord: {
	pipeline:  #Slug
	node:      #Slug
	freightId: string & !=""
	// Upstream node names, source names, or "approval".
	via: [string & !="", ...string & !=""]
	availableAt: #Timestamp
}
