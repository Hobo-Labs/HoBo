/**
 * The GitHub simulator the parity scenarios and relay tests run against
 * (ADR-0183). See `simulator.ts` for the surface and `state.ts` for the
 * GitHub rules it keeps and the simplifications it makes.
 */
export {
	type DecodedJitConfig,
	decodeSimulatedJitConfig,
	encodeSimulatedJitConfig,
} from "./jit-config.js";
export type {
	BillingUsageItem,
	JobConclusion,
	RecordedRequest,
	SimulatedAnnotation,
	SimulatedStepResult,
} from "./records.js";
export { LOG_DOWNLOAD_PATH } from "./rest.js";
export {
	RUNNER_SERVICE_PATH,
	SimulatedRunnerService,
} from "./runner-service.js";
export {
	GithubSimulator,
	type GithubSimulatorOptions,
	type MountedRunnerService,
	type SimulatedDelivery,
} from "./simulator.js";
export {
	JOB_QUEUE_LIMIT_MS,
	type JobCompletion,
	type RegisterRunnerInput,
	runnerHoldsLabels,
	SIMULATED_ACTOR_ID,
	SIMULATOR_EPOCH_MS,
} from "./state.js";
export { simulatorTransport } from "./transport.js";
