/**
 * Placement and teardown, in terms of the parsed records.
 *
 * This file holds no HTTP and no JSON. It orders the three creates, refuses to
 * call a rollout finished on anything weaker than the controller's own
 * agreement, and is honest about the fact that a namespace DELETE is an
 * acceptance, not a completion.
 */
import type {
	DeploymentRecord,
	NamespaceRecord,
	ServiceRecord,
} from "./api.js";
import type { KubernetesApiClient } from "./client.js";
import { KubernetesProviderError } from "./errors.js";
import { PROVIDER_TARGET } from "./options.js";
import {
	clusterEndpointUrl,
	PROVIDER_RESOURCE_CLASS,
	type WorkloadPlacement,
} from "./placement.js";

// public-contract: versions persisted Kubernetes receipts.
export const RECEIPT_SCHEMA_VERSION = "hobo.provider-kubernetes.receipt/v1";

export type ProvisionReceipt = {
	readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
	readonly providerId: typeof PROVIDER_TARGET;
	readonly resourceClass: typeof PROVIDER_RESOURCE_CLASS;
	readonly placement: WorkloadPlacement;
	readonly namespace: NamespaceRecord;
	readonly deployment: DeploymentRecord;
	readonly service: ServiceRecord;
	/** In-cluster address only. No ingress is created, so none is promised. */
	readonly endpointUrl: string;
	readonly adopted: boolean;
};

export const CLEANUP_STATES = ["deleting", "deleted", "retained"] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export type CleanupOutcome = {
	readonly namespace: string;
	readonly state: CleanupState;
	readonly observedAtMs: number;
	/** Present only for `retained`; empty otherwise. */
	readonly retainedReason: string;
};

export type ProvisionInput = {
	readonly client: KubernetesApiClient;
	readonly placement: WorkloadPlacement;
};

/**
 * Namespace, then Deployment, then Service.
 *
 * The order is not cosmetic: a Service created before its Deployment has an
 * endpoint list that is empty for as long as the rollout takes, and anything
 * watching it sees a resolvable name that refuses connections.
 */
export async function provisionWorkload(
	input: ProvisionInput,
): Promise<ProvisionReceipt> {
	const { client, placement } = input;
	const namespace = await client.createOrAdoptNamespace(placement);
	if (namespace.phase === "Terminating") {
		// Objects created in a Terminating namespace are deleted by the
		// namespace controller as fast as they appear.
		throw new KubernetesProviderError(
			"PROVISIONING_CONFLICT",
			`namespace ${namespace.name} is terminating; nothing placed in it would survive`,
			{ detail: { namespace: namespace.name } },
		);
	}
	const deployment = await client.createDeployment(placement);
	const service = await client.createService(placement);

	return Object.freeze({
		schemaVersion: RECEIPT_SCHEMA_VERSION,
		providerId: PROVIDER_TARGET,
		resourceClass: PROVIDER_RESOURCE_CLASS,
		placement,
		namespace,
		deployment,
		service,
		endpointUrl: clusterEndpointUrl(placement),
		adopted: !namespace.createdByHobo,
	});
}

/**
 * Read the rollout once and say what it is.
 *
 * There is deliberately no polling loop here: a driver that waits owns a
 * deadline, a backoff and a cancellation story, and all three belong to the
 * caller that knows what the deploy is for.
 */
export async function observeRollout(
	input: ProvisionInput,
): Promise<DeploymentRecord> {
	const record = await input.client.readDeploymentStatus(input.placement);
	if (record.phase === "failed") {
		throw new KubernetesProviderError(
			"ROLLOUT_FAILED",
			`deployment ${record.name} rollout failed: ${record.failureReason}`,
			{
				detail: {
					namespace: record.namespace,
					deployment: record.name,
					reason: record.failureReason,
					readyReplicas: record.readyReplicas,
					desiredReplicas: record.desiredReplicas,
				},
			},
		);
	}
	return record;
}

export type CleanupInput = {
	readonly client: KubernetesApiClient;
	readonly receipt: ProvisionReceipt;
	readonly now: () => number;
	/** Re-read the namespace after the delete to see whether it is already gone. */
	readonly confirm?: boolean;
};

/**
 * Tear down what this driver created — and only that.
 *
 * An adopted namespace is retained. It was the operator's before this deploy
 * existed, it holds objects nobody here enumerated, and deleting it is the
 * single most destructive thing this package could do.
 */
export async function cleanupWorkload(
	input: CleanupInput,
): Promise<CleanupOutcome> {
	const { client, receipt, now } = input;
	const namespace = receipt.namespace.name;

	if (!receipt.namespace.createdByHobo) {
		return Object.freeze({
			namespace,
			state: "retained" as const,
			observedAtMs: now(),
			retainedReason: "adopted-namespace",
		});
	}

	await client.deleteNamespace(namespace);

	if (input.confirm === true) {
		const observed = await client.getNamespace(namespace);
		if (observed === undefined) {
			return Object.freeze({
				namespace,
				state: "deleted" as const,
				observedAtMs: now(),
				retainedReason: "",
			});
		}
	}

	// The apiserver accepted the delete and answered Terminating. Finalizers
	// decide when the objects actually go; reporting "deleted" here would be
	// reporting an intention as an observation.
	return Object.freeze({
		namespace,
		state: "deleting" as const,
		observedAtMs: now(),
		retainedReason: "",
	});
}
