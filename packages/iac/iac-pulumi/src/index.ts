export {
	ADAPTER_ID,
	createInMemoryAutomationEngine,
	createInMemoryStateBackend,
	createPerResourceStackKey,
	createPulumiAutomationAdapter,
	createStateBackendConfig,
	createTrivialIacProgram,
	IAC_PROGRAM_API_VERSION,
	outputsToBindings,
	PINNED_PULUMI_AUTOMATION_VERSION,
	PulumiApplyError,
	PulumiProgramError,
	PulumiStateError,
	runIacBackendConformance,
	validateIacProgram,
} from "./iac-pulumi-automation-adapter.js";
export type { IacProvider } from "./port.js";
export { IAC_PULUMI_INTERFACE, IAC_PULUMI_PORT } from "./port.js";
export {
	createPulumiAutomationApiEngine,
	PULUMI_AUTOMATION_MODULE_MISSING,
	type PulumiAutomationApiEngineOptions,
} from "./pulumi-automation-api-engine.js";
export {
	createPulumiCliAutomationEngine,
	PULUMI_CLI_MISSING,
	PULUMI_UNSUPPORTED_RESOURCE,
	PULUMI_YAML_TYPE_TOKENS,
	type PulumiCliEngineOptions,
	PulumiEngineUnavailableError,
	renderPulumiYamlProgram,
} from "./pulumi-cli-engine.js";

export const HOBO_IAC_PULUMI_PACKAGE = "@hobo/iac-pulumi";
