export {
	ADAPTER_ID,
	CROSSPLANE_CLAIM_API_VERSION,
	CrossplaneApplyError,
	type CrossplaneClusterLike,
	CrossplaneProgramError,
	claimFor,
	createCrossplaneIacAdapter,
	createFixtureIacProgram,
	createInMemoryCrossplaneCluster,
	IAC_PROGRAM_API_VERSION,
	outputsToBindings,
	runIacBackendConformance,
	validateIacProgram,
} from "./crossplane-adapter.js";
export {
	APPLIED_OUTPUTS_ANNOTATION,
	CrossplaneClusterUnavailableError,
	createKubectlCrossplaneCluster,
	KUBECTL_UNAVAILABLE,
	type KubectlCrossplaneClusterOptions,
} from "./kubectl-cluster.js";
export type { IacProvider } from "./port.js";
export { IAC_CROSSPLANE_INTERFACE, IAC_CROSSPLANE_PORT } from "./port.js";

// public-contract: the package id consumers assert against.
export const HOBO_IAC_CROSSPLANE_PACKAGE = "@hobo/iac-crossplane";
