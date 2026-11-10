/**
 * Kubernetes: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns every built-in object a conformant cluster *can* allocate —
 * a catalog, not a selection. Which offering a given resource gets is decided
 * later, by ADR-0151 selection, against the requirements the app actually
 * states.
 *
 * HONEST SCOPE: the catalog is built-ins only. Kubernetes provides no database,
 * cache, queue or topic — those arrive through operators, which are third-party
 * software an operator installs into a cluster — so those four slots carry no
 * rows, and a row for one would be a claim about somebody else's software.
 * `@hobo/provider-kubernetes` ships convergent resolvers for its catalogued
 * products (count: `providerParity()` in `./parity.js`), exercised against an injected
 * fake apiserver. The Secret's contents arrive through an injected
 * `resolveSecretData` and never through `desired`, so nothing secret reaches
 * the event log. No Resource Definitions are registered for the
 * `kubernetes.*` product ids, so a deploy routed through this Yard still fails
 * closed at resolution.
 *
 * The `regions` option is topology labels for the cluster's nodes, not a
 * provider region list: where a cluster's nodes run is a fact about the
 * infrastructure underneath it, which the Kubernetes API does not report and
 * this package will not guess.
 */
import {
	type KubernetesYardSpecOptions,
	kubernetesYardSpec,
} from "@hobo/provider-kubernetes";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	type CronJobOptions,
	cronJob,
	type DaemonSetOptions,
	type DeploymentOptions,
	daemonSet,
	deployment,
	deploymentWorker,
	type IngressOptions,
	ingress,
	type JobOptions,
	job,
	type PersistentVolumeClaimOptions,
	persistentVolumeClaim,
	SERVICE_TYPES,
	type SecretOptions,
	type ServiceOptions,
	type ServiceType,
	type SlotResourceQuantities,
	type StatefulSetOptions,
	secret,
	service,
	statefulSet,
	statefulSetWorker,
} from "@hobo/provider-kubernetes";

/**
 * This namespace's provider id, read when it is passed to
 * `yard(kubernetes, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have to
 * guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(kubernetes, …).
export const PROVIDER_ID = "kubernetes";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default Kubernetes Yard is registered under; changing it renames them all.
export const DEFAULT_KUBERNETES_YARD_NAME = "kubernetes";

export interface KubernetesYardOptions
	extends ComposedYardOptions,
		KubernetesYardSpecOptions {}

/**
 * The default Kubernetes Yard: the full allocatable built-in catalog, parsed
 * and canonical.
 */
export function Yard(options: KubernetesYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_KUBERNETES_YARD_NAME,
		kubernetesYardSpec(regionOption(options.regions)),
		options,
	);
}
