export {
	createOciRuntimeHost,
	ensureOciRuntime,
	type OciRuntimeHostOptions,
} from "./host.js";
export {
	ensureKubectlBinary,
	isKubectlPresent,
	type KubectlBinary,
	kubectlToolsPath,
	PINNED_KUBECTL_VERSION,
} from "./kubectl-ensure.js";
export {
	createKubectlKubernetesClient,
	createProcessKubectlTransport,
	type KubectlKubernetesClientOptions,
	type KubectlProbeResult,
	type KubectlTransport,
	KubectlUnavailableError,
	type KubernetesClient,
	type PortForwardHandle,
} from "./kubernetes-client.js";
export {
	deploymentManifests,
	type OciPackResult,
	packWasmAsOci,
	WASM_COMPONENT_MEDIA_TYPE,
} from "./oci-pack.js";

// public-contract: package id consumers assert against.
export const HOBO_RUNTIME_OCI_PACKAGE = "@hobo/runtime-oci";
