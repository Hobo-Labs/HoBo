export {
	lowerSweGeminiUsage,
	SWE_GEMINI_CONNECTOR,
	sweGeminiConnector,
} from "./connector.js";
export {
	type BrokeredGeminiCredential,
	buildGeminiLaunch,
	envGeminiCredential,
	GEMINI_ACP_FLAG,
	GEMINI_API_KEY_ENV,
	GEMINI_COMMAND,
	GEMINI_CREDENTIALS_MISSING,
	GeminiCredentialsMissingError,
	type GeminiLaunchSpec,
} from "./launch.js";
export {
	extractSweTaskReport,
	runSweTask,
	SWE_TASK_REPORT_SCHEMA,
	type SweTask,
	type SweTaskReport,
	type SweTaskRunInput,
	type SweTaskRunResult,
	sweTaskPolicy,
} from "./swe-task.js";
export {
	createGeminiTranscriptAgent,
	GEMINI_GOLDEN_TRANSCRIPT,
	GOLDEN_TRANSCRIPT,
	type GoldenTranscriptStep,
	STOCK_ACP_PROTOCOL_VERSION,
	type TranscriptAcpAgent,
	type TranscriptAgentOptions,
} from "./transcript-agent.js";

// public-contract: the package id consumers assert against.
export const HOBO_SWE_GEMINI_PACKAGE = "@hobo/swe-gemini";
