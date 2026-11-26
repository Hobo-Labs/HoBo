export type { IacProvider } from "./port.js";
export { IAC_TERRAFORM_INTERFACE, IAC_TERRAFORM_PORT } from "./port.js";
export {
	ADAPTER_ID,
	createInMemoryHclEngine,
	createInMemoryStateBackend,
	createTerraformAdapter,
	createTrivialIacProgram,
	createWorkspaceKey,
	HCL_PROVIDERS,
	IAC_PROGRAM_API_VERSION,
	outputsToBindings,
	PINNED_TERRAFORM_VERSION,
	PINNED_TOFU_VERSION,
	runIacBackendConformance,
	TerraformApplyError,
	TerraformProgramError,
	TerraformStateError,
	validateIacProgram,
} from "./terraform-adapter.js";
export {
	createTerraformCliEngine,
	parsePlanChanges,
	readLocalState,
	renderTerraformJsonProgram,
	TERRAFORM_CLI_MISSING,
	TERRAFORM_TYPE_TOKENS,
	TERRAFORM_UNSUPPORTED_RESOURCE,
	type TerraformCliEngineOptions,
	TerraformEngineUnavailableError,
} from "./terraform-cli-engine.js";

// public-contract: the package id consumers assert against.
export const HOBO_IAC_TERRAFORM_PACKAGE = "@hobo/iac-terraform";
