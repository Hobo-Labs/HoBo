export {
	lowerSweClaudeUsage,
	SWE_CLAUDE_CONNECTOR,
	sweClaudeConnector,
} from "./connector.js";
export {
	type BrokeredClaudeCredential,
	buildClaudeLaunch,
	CLAUDE_ACP_COMMAND,
	CLAUDE_API_KEY_ENV,
	CLAUDE_CREDENTIALS_MISSING,
	ClaudeCredentialsMissingError,
	type ClaudeLaunchSpec,
	envClaudeCredential,
} from "./launch.js";
export {
	buildSandboxAccessReport,
	extractSweTaskReport,
	runSweTask,
	SANDBOX_REPORT_SCHEMA,
	type SandboxAccessReport,
	SWE_TASK_REPORT_SCHEMA,
	type SweTask,
	type SweTaskReport,
	type SweTaskRunInput,
	type SweTaskRunResult,
	sweTaskPolicy,
} from "./swe-task.js";
export {
	CLAUDE_GOLDEN_TRANSCRIPT,
	createClaudeTranscriptAgent,
	GOLDEN_TRANSCRIPT,
	type GoldenTranscriptStep,
	type TranscriptAcpAgent,
	type TranscriptAgentOptions,
} from "./transcript-agent.js";

// public-contract: the package id consumers assert against.
export const HOBO_SWE_CLAUDE_PACKAGE = "@hobo/swe-claude";
