import { request as httpsRequest } from "node:https";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";

import { KubernetesProviderError } from "./errors.js";
import type { KubernetesTlsMaterial } from "./kubeconfig.js";

function ambiguous(request: TransportRequest, cause?: Error) {
	return new KubernetesProviderError(
		"PROVIDER_OPERATION_AMBIGUOUS",
		`${request.method} to the apiserver did not complete`,
		{
			...(cause !== undefined ? { cause } : undefined),
			detail: { method: request.method },
		},
	);
}

export function createKubernetesHttpsTransport(
	tls: KubernetesTlsMaterial,
): HttpTransport {
	return (request) =>
		new Promise<TransportResponse>((resolve, reject) => {
			const body =
				request.body === undefined ? undefined : Buffer.from(request.body);
			const outbound = httpsRequest(
				request.url,
				{
					method: request.method,
					headers: {
						...request.headers,
						...(body !== undefined
							? { "Content-Length": String(body.byteLength) }
							: undefined),
					},
					...tls,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("data", (chunk: Buffer) => {
						size += chunk.byteLength;
						if (size > request.maxResponseBytes) {
							clearTimeout(timer);
							response.destroy();
							reject(
								new KubernetesProviderError(
									"PROVIDER_CONTRACT_CHANGED",
									`apiserver response exceeded the ${request.maxResponseBytes} byte cap`,
								),
							);
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () => {
						clearTimeout(timer);
						if (size > request.maxResponseBytes) return;
						const headers: Record<string, string> = {};
						for (const [name, value] of Object.entries(response.headers))
							if (value !== undefined)
								headers[name.toLowerCase()] = Array.isArray(value)
									? value.join(", ")
									: value;
						resolve({
							status: response.statusCode ?? 0,
							headers,
							body: Buffer.concat(chunks).toString("utf8"),
						});
					});
					response.on("error", (cause) => {
						clearTimeout(timer);
						reject(
							cause instanceof KubernetesProviderError
								? cause
								: ambiguous(request, cause),
						);
					});
				},
			);
			const timer = setTimeout(() => {
				outbound.destroy(ambiguous(request));
			}, request.timeoutMs);
			outbound.on("error", (cause) => {
				clearTimeout(timer);
				reject(
					cause instanceof KubernetesProviderError
						? cause
						: ambiguous(request, cause),
				);
			});
			outbound.end(body);
		});
}
