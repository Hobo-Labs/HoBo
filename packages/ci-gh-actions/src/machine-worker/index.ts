/**
 * The machine worker: what `hobo ci machine connect` runs on a computer its
 * owner connects (ADR-0183). See `MACHINE-WORKER.md` beside this file.
 */
export {
	MACHINE_ADVERT_EVERY_MS,
	type MachineAdvertSink,
	type MachineAdvertState,
	type MachineProfile,
	machineAdvert,
	machineRunsOnLabel,
	registryAdvertSink,
	signedMachineAdvert,
} from "./advert.js";
export {
	containerExecutor,
	containerJobEnvironment,
	DEFAULT_MACHINE_IMAGE,
	type HostProcess,
	hostExecutor,
	hostJobEnvironment,
	type JobExecutor,
	MACHINE_JOB_TIMEOUT_MS,
	type MachineJobOutcome,
	type MachineJobRun,
	nodeHostProcess,
	pause,
	pinnedRunnerProgram,
	RUNNER_JIT_CONFIG_ENV,
	type RunnerProgram,
} from "./executor.js";
export {
	assignedJobSource,
	createOneJobRunner,
	GITHUB_API_URL,
	githubQueueJobSource,
	MACHINE_QUEUE_POLL_MS,
	type MachineGithub,
	type MachineJobOffer,
	type MachineJobSource,
	type OneJobRunner,
	OneJobRunnerError,
	removeOneJobRunner,
	userGithub,
} from "./jobs.js";
export {
	githubOwner,
	loadMachine,
	MACHINE_FILE,
	MACHINE_KEY_FILE,
	MACHINE_TICK_MS,
	type MachinePlatform,
	type MachineSession,
	machinePlatform,
	runMachineSession,
	type StoredMachine,
} from "./session.js";
export {
	createMachineWorker,
	type MachineWorker,
	type MachineWorkerEvent,
	type MachineWorkerOptions,
	type MachineWorkerStatus,
	oneJobRunnerName,
} from "./worker.js";
