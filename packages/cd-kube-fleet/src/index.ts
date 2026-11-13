// @hobo/cd-kube-fleet (plan 0024, WP25, D26): Kubernetes fleet managers as
// transports and inventory for HoBo Camps, never schedulers. The public
// surface takes and returns @hobo/cd and @hobo/core types only; Kubernetes
// shapes stay inside this package (I11).
export {
	type CampClusterRecord,
	CampClusterRecordSchema,
	type ClusterProfileImportRecord,
	ClusterProfileImportRecordSchema,
	HubKind,
	type ImportedClusterRecord,
	ImportedClusterRecordSchema,
	type KarmadaRealizerRecord,
	KarmadaRealizerRecordSchema,
	KubeAuth,
	type KubeHubRecord,
	KubeHubRecordSchema,
	type KubeObjectRefRecord,
	KubeObjectRefRecordSchema,
	type OcmRealizerRecord,
	OcmRealizerRecordSchema,
} from "./_generated/kube_fleet_pb.js";
export {
	type ClusterProfileChange,
	type ClusterProfileInventory,
	type ClusterProfileInventoryDeps,
	type ClusterProfileSnapshot,
	clusterProfileInventory,
	type KubeClusterAccess,
} from "./cluster-profile/inventory.js";
export type { ImportedCamp } from "./cluster-profile/parse.js";
export {
	type ClusterProfileImport,
	KUBE_FLEET_DEFAULTS,
	KUBE_FLEET_SCHEMAS,
	type KubeHub,
	parseClusterProfileImport,
	parseKarmadaRealizerConfig,
	parseKubeHub,
	parseOcmRealizerConfig,
	type RealizerConfig,
} from "./config.js";
export {
	KUBE_FLEET_FAILURES,
	KubeFleetError,
	type KubeFleetFailureCode,
} from "./errors.js";
export {
	type KarmadaRealizerDeps,
	karmadaRealizer,
} from "./karmada/realizer.js";
export { KNOWN_KINDS } from "./kube/objects.js";
export {
	type ObserveFieldsReader,
	type OcmRealizerDeps,
	ocmRealizer,
} from "./ocm/realizer.js";
export { KUBE_FLEET_METRICS } from "./telemetry.js";
