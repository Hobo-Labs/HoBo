/**
 * macOS machines (ADR-0183): the pinned macOS runner archives, how a
 * computer connects on each platform, and `--vm` through Apple's `container`
 * tool. See `MACOS.md` beside this file.
 */
export {
	APPLE_CONTAINER_TOOL,
	appleContainerDriver,
	appleContainerExecutor,
	appleContainerStatus,
	nodeToolProcess,
	type ToolProcess,
	type ToolResult,
} from "./apple-container.js";
export {
	type AppleContainerStatus,
	type MachineConnectAsk,
	type MachineConnectPlan,
	type MachineMode,
	machineConnectPlan,
} from "./platform.js";
export {
	MACOS_RUNNER_SHA256,
	MACOS_RUNNER_SHA256_ARM64,
	macosRunnerDownloadFor,
	pinnedMacosRunnerProgram,
} from "./runner.js";
