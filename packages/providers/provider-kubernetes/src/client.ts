import {
	type DeploymentRecord,
	type NamespaceRecord,
	parseApiStatus,
	parseDeploymentRecord,
	parseNamespaceRecord,
	parseServiceRecord,
	type ServiceRecord,
} from "./api.js";
import { KubernetesProviderError, redactClusterText } from "./errors.js";
import type { JsonObject } from "./json.js";
import {
	renderDeploymentManifest,
	renderNamespaceManifest,
	renderServiceManifest,
	type WorkloadPlacement,
} from "./placement.js";
import {
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type KubernetesTransport,
	type TransportMethod,
	type TransportPolicy,
	type TransportResponse,
} from "./transport.js";

// public-contract: Kubernetes namespace API path used by the adapter.
export const NAMESPACES_PATH = "/api/v1/namespaces";
// public-contract: Kubernetes apps API path used by the adapter.
export const APPS_PATH = "/apis/apps/v1/namespaces";

export type KubernetesApiClientOptions = {
	readonly transport: KubernetesTransport;
	readonly apiServerUrl: string;
	readonly policy?: TransportPolicy;
	readonly timeoutMs?: number;
};

export interface KubernetesApiClient {
	createOrAdoptNamespace(
		placement: WorkloadPlacement,
	): Promise<NamespaceRecord>;
	getNamespace(name: string): Promise<NamespaceRecord | undefined>;
	createDeployment(placement: WorkloadPlacement): Promise<DeploymentRecord>;
	readDeploymentStatus(placement: WorkloadPlacement): Promise<DeploymentRecord>;
	createService(placement: WorkloadPlacement): Promise<ServiceRecord>;
	deleteNamespace(name: string): Promise<NamespaceRecord>;
}

export function errorForApiResponse(
	response: TransportResponse,
	context: { readonly method: TransportMethod; readonly what: string },
): KubernetesProviderError {
	let reason = "";
	let message = "";
	try {
		const status = parseApiStatus(response.body);
		reason = status.reason;
		message = status.message;
	} catch {
		message = redactClusterText(response.body, 180);
	}
	const detail = {
		status: response.status,
		method: context.method,
		what: context.what,
		...(reason !== "" ? { reason } : undefined),
		...(message !== "" ? { message } : undefined),
	};

	if (response.status === 401 || response.status === 403) {
		return new KubernetesProviderError(
			"PROVIDER_AUTH_FAILED",
			`apiserver refused ${context.what}: ${reason || response.status}`,
			{ detail },
		);
	}
	if (response.status === 409) {
		return new KubernetesProviderError(
			"PROVISIONING_CONFLICT",
			`apiserver reported ${reason || "Conflict"} for ${context.what}`,
			{ detail },
		);
	}
	if (response.status === 429) {
		const retryAfter = Number(response.headers["retry-after"] ?? Number.NaN);
		return new KubernetesProviderError(
			"PROVIDER_RATE_LIMITED",
			`apiserver throttled ${context.what}`,
			{
				retryable: true,
				...(Number.isFinite(retryAfter)
					? { retryAfterMs: retryAfter * 1000 }
					: undefined),
				detail,
			},
		);
	}
	if (response.status >= 500) {
		return context.method === "GET"
			? new KubernetesProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`apiserver returned ${response.status} reading ${context.what}`,
					{ retryable: true, detail },
				)
			: new KubernetesProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`apiserver returned ${response.status} to ${context.what}; the object may or may not exist`,
					{ detail },
				);
	}
	return new KubernetesProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`apiserver returned an unexpected ${response.status} for ${context.what}`,
		{ detail },
	);
}

export function createKubernetesApiClient(
	options: KubernetesApiClientOptions,
): KubernetesApiClient {
	const policy = options.policy ?? DEFAULT_TRANSPORT_POLICY;
	const transport = createGuardedTransport(options.transport, policy);
	const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
	const base = options.apiServerUrl.replace(/\/+$/u, "");

	async function call(
		method: TransportMethod,
		path: string,
		body?: JsonObject,
	): Promise<TransportResponse> {
		return transport.request({
			method,
			url: `${base}${path}`,
			headers: {
				Accept: "application/json",
				...(body !== undefined
					? { "Content-Type": "application/json" }
					: undefined),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : undefined),
			timeoutMs,
			maxResponseBytes: policy.maxResponseBytes,
		});
	}

	async function getNamespace(
		name: string,
	): Promise<NamespaceRecord | undefined> {
		const response = await call("GET", `${NAMESPACES_PATH}/${name}`);
		if (response.status === 404) return undefined;
		if (response.status !== 200) {
			throw errorForApiResponse(response, {
				method: "GET",
				what: `namespace ${name}`,
			});
		}
		return parseNamespaceRecord(response.body, { createdByHobo: false });
	}

	return {
		getNamespace,

		async createOrAdoptNamespace(placement) {
			const response = await call(
				"POST",
				NAMESPACES_PATH,
				renderNamespaceManifest(placement),
			);
			if (response.status === 200 || response.status === 201) {
				return parseNamespaceRecord(response.body, { createdByHobo: true });
			}
			if (response.status === 409) {
				const existing = await getNamespace(placement.namespace);
				if (existing === undefined) {
					throw errorForApiResponse(response, {
						method: "POST",
						what: `namespace ${placement.namespace}`,
					});
				}
				return existing;
			}
			throw errorForApiResponse(response, {
				method: "POST",
				what: `namespace ${placement.namespace}`,
			});
		},

		async createDeployment(placement) {
			const response = await call(
				"POST",
				`${APPS_PATH}/${placement.namespace}/deployments`,
				renderDeploymentManifest(placement),
			);
			if (response.status !== 200 && response.status !== 201) {
				throw errorForApiResponse(response, {
					method: "POST",
					what: `deployment ${placement.workloadName}`,
				});
			}
			return parseDeploymentRecord(response.body);
		},

		async readDeploymentStatus(placement) {
			const response = await call(
				"GET",
				`${APPS_PATH}/${placement.namespace}/deployments/${placement.workloadName}/status`,
			);
			if (response.status !== 200) {
				throw errorForApiResponse(response, {
					method: "GET",
					what: `deployment ${placement.workloadName} status`,
				});
			}
			return parseDeploymentRecord(response.body);
		},

		async createService(placement) {
			const response = await call(
				"POST",
				`${NAMESPACES_PATH}/${placement.namespace}/services`,
				renderServiceManifest(placement),
			);
			if (response.status !== 200 && response.status !== 201) {
				throw errorForApiResponse(response, {
					method: "POST",
					what: `service ${placement.workloadName}`,
				});
			}
			return parseServiceRecord(response.body);
		},

		async deleteNamespace(name) {
			const response = await call("DELETE", `${NAMESPACES_PATH}/${name}`);
			if (response.status !== 200 && response.status !== 202) {
				throw errorForApiResponse(response, {
					method: "DELETE",
					what: `namespace ${name}`,
				});
			}
			return parseNamespaceRecord(response.body, { createdByHobo: true });
		},
	};
}
