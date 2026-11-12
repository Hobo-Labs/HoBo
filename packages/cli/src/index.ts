export {
	type AgentDocsDriftEntry,
	type AgentDocsDriftStatus,
	AgentDocsError,
	assertAgentDocsFresh,
	compareAgentDocs,
	writeAgentDocs,
} from "./agent-docs/gate.js";
export {
	AGENT_DOCS_ARTIFACTS,
	AGENT_DOCS_GENERATOR,
	AGENT_DOCS_MCP_CALL_VERB,
	AGENT_DOCS_MCP_PORT,
	AGENT_DOCS_PRODUCT,
	AGENT_DOCS_SCHEMA_VERSION,
	type AgentDocCapability,
	type AgentDocEntry,
	type AgentDocsArtifact,
	type AgentDocsManifest,
	type AgentDocsResult,
	type AgentDocsToolInput,
	type GenerateAgentDocsInput,
	generateAgentDocs,
} from "./agent-docs/generate.js";
export {
	buildContainerImage,
	type ContainerBuildFn,
	validateContainerArchive,
} from "./build/container-build.js";
export {
	BINDLE_SOURCE_CANDIDATES,
	compileProjectManifest,
	DEFAULT_COMPONENT_HOST,
	loadBindleDefinition,
	loadProjectCollectionTarget,
	targetFromBindleDefinition,
} from "./cloud/loader.js";
export {
	BINDLE_MANIFEST_FILE,
	deploymentIdFor,
	loadProjectManifest,
} from "./cloud/manifest.js";
export {
	ANONYMOUS_SUBJECT,
	createFixtureSession,
	DEFAULT_TENANT,
	loadSession,
	persistSession,
	SESSION_FILE,
} from "./cloud/session.js";
export {
	createYardClient,
	type DownResult,
	type PlanRendered,
	type UpResult,
	type YardClient,
	type YardRuntime,
	type YardSession,
} from "./cloud/yard-client.js";
export { createProjectCodegenEngine } from "./codegen/engine.js";
export { selectProjectCodegenEngine } from "./codegen/project-engine.js";
export { runCodegen } from "./codegen/run-codegen.js";
export type { CodegenEngine } from "./codegen/types.js";
export {
	createTypeScriptProjectCodegenEngine,
	packageTypeScriptAppArtifacts,
	selectTypeScriptProjectCodegenEngine,
	type TypeScriptProjectCodegenOptions,
} from "./codegen/typescript-project-engine.js";
export {
	BUILD_MANIFEST_PATH,
	BuildError,
	createBuildCommand,
	parseBuildManifest,
	parseBuildRequestFromInvocation,
	parseServiceDeclaration,
	runBuild,
	writeBuildFixtureProject,
} from "./commands/build.js";
export { createCodegenCommand } from "./commands/codegen.js";
export {
	COLLECT_GOLDEN_FILE,
	type CollectCommandDeps,
	createCollectCommand,
} from "./commands/collect.js";
export {
	createDevCommand,
	type DevCommandDeps,
	type DevServeResult,
} from "./commands/dev.js";
export { createDownCommand, type DownCommandDeps } from "./commands/down.js";
export { createLoginCommand, type LoginCommandDeps } from "./commands/login.js";
export {
	scaffoldHoboProject,
	validateScaffoldProject,
} from "./commands/new.js";
export { createPlanCommand, type PlanCommandDeps } from "./commands/plan.js";
export { createStubCommand } from "./commands/stub.js";
export { createUpCommand, type UpCommandDeps } from "./commands/up.js";
export {
	bootLocalCamp,
	DEV_COLD_BUDGET_MS,
	DEV_LOCAL_URL,
	type DevBindlePlan,
	type DevBootResult,
	type DevRuntime,
} from "./dev/local-camp.js";
export type {
	CommandInvocation,
	CreateHoboCliOptions,
	HoboCli,
} from "./shell/dispatch.js";
export { createHoboCli, dispatchCommand, runHobo } from "./shell/dispatch.js";
export {
	BindleImportError,
	CliError,
	NoBindleError,
	UsageError,
} from "./shell/errors.js";
export { parseArgv } from "./shell/parse.js";
export type {
	CommandModule,
	CommandRegistry,
	CommandRunInput,
} from "./shell/registry.js";
export { createCommandRegistry } from "./shell/registry.js";
export {
	DEPLOY_SUBCOMMANDS,
	INCIDENT_SUBCOMMANDS,
	resolveSubcommand,
	SERVE_SUBCOMMANDS,
	type SubcommandOptionKind,
	type SubcommandOptions,
	type SubcommandOptionValue,
	VERB_SUBCOMMANDS,
	type VerbSubcommandTable,
} from "./shell/subcommands.js";
export {
	CANONICAL_VERBS,
	GLOBAL_FLAGS,
	helpText,
	verbHelpText,
} from "./shell/verbs.js";
export type {
	CliContext,
	CliEnvelope,
	CommandResult,
} from "./types/envelope.js";
export { VALID_TEMPLATES } from "./types/scaffold.js";
