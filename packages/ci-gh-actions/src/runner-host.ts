/**
 * `@hobo/ci-gh-actions/runner-host`: what `hobo deploy agent run` needs on a
 * runner host and what the CD Station needs to read it, without loading the
 * relay. The runner-host realizer, the runner fleet's declarations, its health
 * mapping, and the CLI Docker driver the agent wires as the container port.
 */
export { createCliDockerDriver } from "./isolated-worker/cli-docker-driver.js";
export {
	RUNNER_FLEET_CAMP_SET,
	RUNNER_FLEET_PROVIDER,
	RUNNER_FLEET_RAIL,
	RUNNER_FLEET_YARD,
	type RunnerFleetRail,
	type RunnerHostKind,
	runnerFleetRail,
} from "./runner-fleet-delivery.js";
export {
	createRunnerHostResolver,
	RUNNER_HOST_HEALTH_CLAIMS,
	RUNNER_HOST_PRODUCT_ID,
	type RunnerHostCampReport,
	type RunnerHostHealth,
	type RunnerHostPorts,
	type RunnerHostRealizerOptions,
	runnerHostAbsentReport,
	runnerHostCampReport,
	runnerHostHealthConditions,
	runnerHostIdForCamp,
	runnerHostInterfaceGaps,
	runnerHostResolveRequest,
} from "./runner-host-realizer.js";
