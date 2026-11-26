/**
 * `@hobo/ci-agent`: an optional agent for the HoBo CI relay that plans the
 * merge queue and resolves merge conflicts with a configured model.
 *
 * This entry is free of provider SDKs, git and SQLite. Adapters are subpaths:
 * `./ai-sdk` (models), `./git` (the merge workspace), `./github` (the merge
 * queue) and `./sqlite` (the durable journal).
 */
export type {
	AgentConfig,
	AgentEvent,
	PairVerdict,
	QueueEntry,
	QueuePlan,
	QueueSnapshot,
	Resolution,
} from "./_generated/agent_pb.js";
export {
	AgentEventSchema,
	QueuePlanSchema,
	QueueSnapshotSchema,
	ResolutionSchema,
} from "./_generated/agent_pb.js";
export {
	type AgentTickReport,
	type CiAgent,
	createCiAgent,
	type QueuePublisher,
	type QueueSource,
} from "./agent.js";
export {
	AGENT_ENGINE_KINDS,
	AGENT_HARNESSES,
	AGENT_MODES,
	AgentConfigDocumentSchema,
	type AgentMode,
	ALWAYS_PROTECTED_PATHS,
	matchesAnyPath,
	type ParsedAgentConfig,
	parseAgentConfig,
} from "./config.js";
export {
	composeMerged,
	fitRegionResolution,
	type MergeSegment,
	markerSizeFor,
	parseMergeSegments,
} from "./conflict.js";
export type { MergeWorkspace, TrialMerge } from "./git-workspace.js";
export {
	AGENT_EVENT_TYPES,
	type AgentEventType,
	type AgentJournal,
	createMemoryJournal,
} from "./journal.js";
export {
	type ObservedQueue,
	observeQueue,
	overlappingPairs,
	planQueue,
} from "./planner.js";
export {
	type ConflictFile,
	type EngineAnswer,
	type EngineRequest,
	type ResolutionEngine,
	type ResolutionReason,
	type ResolveResult,
	resolveConflicts,
} from "./resolver.js";
