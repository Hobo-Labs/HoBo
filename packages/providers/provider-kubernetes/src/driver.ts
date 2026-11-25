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
	readonly endpointUrl: string;
	readonly adopted: boolean;
};

export const CLEANUP_STATES = ["deleting", "deleted", "retained"] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export type CleanupOutcome = {
	readonly namespace: string;
	readonly state: CleanupState;
	readonly observedAtMs: number;
	readonly retainedReason: string;
};

export type ProvisionInput = {
	readonly client: KubernetesApiClient;
	readonly placement: WorkloadPlacement;
};

export async function provisionWorkload(
	input: ProvisionInput,
): Promise<ProvisionReceipt> {
	const { client, placement } = input;
	const namespace = await client.createOrAdoptNamespace(placement);
	if (namespace.phase === "Terminating") {
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
	readonly confirm?: boolean;
};

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

	return Object.freeze({
		namespace,
		state: "deleting" as const,
		observedAtMs: now(),
		retainedReason: "",
	});
}
