export {
	lowerSweCopilotUsage,
	SWE_COPILOT_CONNECTOR,
	sweCopilotConnector,
} from "./connector.js";
export {
	type BrokeredCopilotCredential,
	buildCopilotLaunch,
	COPILOT_ACP_COMMAND,
	COPILOT_API_KEY_ENV,
	COPILOT_CREDENTIALS_MISSING,
	CopilotCredentialsMissingError,
	type CopilotLaunchSpec,
	envCopilotCredential,
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
	COPILOT_GOLDEN_TRANSCRIPT,
	createCopilotTranscriptAgent,
	GOLDEN_TRANSCRIPT,
	type GoldenTranscriptStep,
	type TranscriptAcpAgent,
	type TranscriptAgentOptions,
} from "./transcript-agent.js";

// public-contract: the package id consumers assert against.
export const HOBO_SWE_COPILOT_PACKAGE = "@hobo/swe-copilot";
