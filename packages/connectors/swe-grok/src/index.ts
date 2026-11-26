export {
	lowerSweGrokUsage,
	SWE_GROK_CONNECTOR,
	sweGrokConnector,
} from "./connector.js";
export {
	type BrokeredGrokCredential,
	buildGrokLaunch,
	envGrokCredential,
	GROK_ACP_COMMAND,
	GROK_API_KEY_ENV,
	GROK_CREDENTIALS_MISSING,
	GrokCredentialsMissingError,
	type GrokLaunchSpec,
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
	createGrokTranscriptAgent,
	GOLDEN_TRANSCRIPT,
	type GoldenTranscriptStep,
	GROK_GOLDEN_TRANSCRIPT,
	type TranscriptAcpAgent,
	type TranscriptAgentOptions,
} from "./transcript-agent.js";

// public-contract: the package id consumers assert against.
export const HOBO_SWE_GROK_PACKAGE = "@hobo/swe-grok";
