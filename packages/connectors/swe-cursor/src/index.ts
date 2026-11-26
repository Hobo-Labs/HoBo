export {
	lowerSweCursorUsage,
	SWE_CURSOR_CONNECTOR,
	sweCursorConnector,
} from "./connector.js";
export {
	type BrokeredCursorCredential,
	buildCursorLaunch,
	CURSOR_ACP_COMMAND,
	CURSOR_API_KEY_ENV,
	CURSOR_CREDENTIALS_MISSING,
	CursorCredentialsMissingError,
	type CursorLaunchSpec,
	envCursorCredential,
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
	CURSOR_GOLDEN_TRANSCRIPT,
	createCursorTranscriptAgent,
	GOLDEN_TRANSCRIPT,
	type GoldenTranscriptStep,
	type TranscriptAcpAgent,
	type TranscriptAgentOptions,
} from "./transcript-agent.js";

// public-contract: the package id consumers assert against.
export const HOBO_SWE_CURSOR_PACKAGE = "@hobo/swe-cursor";
