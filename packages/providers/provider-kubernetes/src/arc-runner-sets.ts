import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";

import { errorForApiResponse } from "./client.js";
import { KubernetesProviderError } from "./errors.js";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
import { parseApiServerEndpoint } from "./resolver-transport.js";

export const ARC_RUNNER_SETS_PATH =
	"/apis/actions.github.com/v1alpha1/namespaces";
export const BATCH_JOBS_PATH = "/apis/batch/v1/namespaces";

const NAME = "[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?";
const KUBERNETES_NAME = new RegExp(`^${NAME}$`, "u");

const ROUTES: readonly Readonly<{ method: TransportMethod; path: RegExp }>[] = [
	{
		method: "GET",
		path: new RegExp(
			`^${ARC_RUNNER_SETS_PATH}/${NAME}/autoscalingrunnersets$`,
			"u",
		),
	},
	{
		method: "GET",
		path: new RegExp(
			`^${ARC_RUNNER_SETS_PATH}/${NAME}/autoscalingrunnersets/${NAME}$`,
			"u",
		),
	},
	{
		method: "PATCH",
		path: new RegExp(
			`^${ARC_RUNNER_SETS_PATH}/${NAME}/autoscalingrunnersets/${NAME}$`,
			"u",
		),
	},
	{ method: "GET", path: new RegExp(`^${BATCH_JOBS_PATH}/${NAME}/jobs$`, "u") },
	{
		method: "POST",
		path: new RegExp(`^${BATCH_JOBS_PATH}/${NAME}/jobs$`, "u"),
	},
];

export function arcRunnerSetPolicy(apiServerUrl: string): TransportGuardPolicy {
	const endpoint = parseApiServerEndpoint(apiServerUrl);
	return Object.freeze({
		allowedHosts: Object.freeze([endpoint.hostname]),
		allowedPathPrefixes: Object.freeze([
			`${ARC_RUNNER_SETS_PATH}/`,
			`${BATCH_JOBS_PATH}/`,
		]),
		maxTimeoutMs: 30_000,
		maxResponseBytes: 2 * 1024 * 1024,
		...(endpoint.port === ""
			? undefined
			: { allowedPorts: Object.freeze([endpoint.port]) }),
	});
}

export type ArcJobCreation = "created" | "exists";

export interface ArcRunnerSetClient {
	listRunnerSets(namespace: string): Promise<JsonObject>;
	readRunnerSet(
		namespace: string,
		name: string,
	): Promise<JsonObject | undefined>;
	patchRunnerSet(
		namespace: string,
		name: string,
		patch: readonly JsonValue[],
	): Promise<JsonObject>;
	listJobs(namespace: string, labelSelector: string): Promise<JsonObject>;
	createJob(namespace: string, job: JsonObject): Promise<ArcJobCreation>;
}

export type ArcRunnerSetClientOptions = Readonly<{
	transport: HttpTransport;
	apiServerUrl: string;
	bearerToken?: string;
}>;

function kubernetesName(kind: string, value: string): string {
	if (!KUBERNETES_NAME.test(value))
		throw new KubernetesProviderError(
			"ROUTE_REFUSED",
			`${kind} must be a Kubernetes object name`,
		);
	return value;
}

function objectBody(response: TransportResponse, what: string): JsonObject {
	const body = parseJsonValue(response.body);
	if (!isJsonObject(body))
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`apiserver answered ${what} with a body that is not an object`,
		);
	return body;
}

export function createArcRunnerSetClient(
	options: ArcRunnerSetClientOptions,
): ArcRunnerSetClient {
	const policy = arcRunnerSetPolicy(options.apiServerUrl);
	const transport = guardTransport(options.transport, policy);
	const base = options.apiServerUrl.replace(/\/+$/u, "");

	async function call(
		method: TransportMethod,
		path: string,
		query: string,
		body?: Readonly<{ contentType: string; value: JsonValue }>,
	): Promise<TransportResponse> {
		if (
			!ROUTES.some((route) => route.method === method && route.path.test(path))
		)
			throw new KubernetesProviderError(
				"ROUTE_REFUSED",
				`${method} ${path} is outside the runner-set routes this client may call`,
			);
		return transport({
			method,
			url: `${base}${path}${query}`,
			headers: {
				Accept: "application/json",
				...(options.bearerToken !== undefined
					? { Authorization: `Bearer ${options.bearerToken}` }
					: undefined),
				...(body !== undefined
					? { "Content-Type": body.contentType }
					: undefined),
			},
			...(body !== undefined
				? { body: JSON.stringify(body.value) }
				: undefined),
			timeoutMs: policy.maxTimeoutMs,
			maxResponseBytes: policy.maxResponseBytes,
		});
	}

	function runnerSetPath(namespace: string, name?: string): string {
		const collection = `${ARC_RUNNER_SETS_PATH}/${kubernetesName("namespace", namespace)}/autoscalingrunnersets`;
		return name === undefined
			? collection
			: `${collection}/${kubernetesName("scale set", name)}`;
	}

	function jobsPath(namespace: string): string {
		return `${BATCH_JOBS_PATH}/${kubernetesName("namespace", namespace)}/jobs`;
	}

	return {
		async listRunnerSets(namespace) {
			const what = `runner scale sets in ${namespace}`;
			const response = await call("GET", runnerSetPath(namespace), "");
			if (response.status !== 200)
				throw errorForApiResponse(response, { method: "GET", what });
			return objectBody(response, what);
		},
		async readRunnerSet(namespace, name) {
			const what = `runner scale set ${namespace}/${name}`;
			const response = await call("GET", runnerSetPath(namespace, name), "");
			if (response.status === 404) return undefined;
			if (response.status !== 200)
				throw errorForApiResponse(response, { method: "GET", what });
			return objectBody(response, what);
		},
		async patchRunnerSet(namespace, name, patch) {
			const what = `runner scale set ${namespace}/${name}`;
			const response = await call("PATCH", runnerSetPath(namespace, name), "", {
				contentType: "application/json-patch+json",
				value: [...patch],
			});
			if (response.status === 422)
				throw new KubernetesProviderError(
					"PROVISIONING_CONFLICT",
					`${what} changed after it was read, so the patch was not applied; run the command again`,
				);
			if (response.status !== 200)
				throw errorForApiResponse(response, { method: "PATCH", what });
			return objectBody(response, what);
		},
		async listJobs(namespace, labelSelector) {
			const what = `jobs in ${namespace}`;
			const response = await call(
				"GET",
				jobsPath(namespace),
				`?${new URLSearchParams({ labelSelector }).toString()}`,
			);
			if (response.status !== 200)
				throw errorForApiResponse(response, { method: "GET", what });
			return objectBody(response, what);
		},
		async createJob(namespace, job) {
			const what = `job in ${namespace}`;
			const response = await call("POST", jobsPath(namespace), "", {
				contentType: "application/json",
				value: job,
			});
			if (response.status === 200 || response.status === 201) return "created";
			if (response.status === 409) return "exists";
			throw errorForApiResponse(response, { method: "POST", what });
		},
	};
}
