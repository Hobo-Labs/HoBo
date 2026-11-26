export {
	lowerSweCodexUsage,
	SWE_CODEX_CONNECTOR,
	sweCodexConnector,
} from "./connector.js";
export {
	type BrokeredCodexCredential,
	buildCodexLaunch,
	CODEX_ACP_COMMAND,
	CODEX_API_KEY_ENV,
	CODEX_CREDENTIALS_MISSING,
	CodexCredentialsMissingError,
	type CodexLaunchSpec,
	envCodexCredential,
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
	CODEX_GOLDEN_TRANSCRIPT,
	createCodexTranscriptAgent,
	GOLDEN_TRANSCRIPT,
	type GoldenTranscriptStep,
	type TranscriptAcpAgent,
	type TranscriptAgentOptions,
} from "./transcript-agent.js";

// public-contract: the package id consumers assert against.
export const HOBO_SWE_CODEX_PACKAGE = "@hobo/swe-codex";
