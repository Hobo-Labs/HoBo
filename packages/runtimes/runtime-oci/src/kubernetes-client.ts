import {
	createProcessKubectlTransport,
	type KubectlRequest,
	type KubectlResponse,
	type KubectlTransport,
	KubectlUnavailableError,
} from "./kubectl-transport.js";

export type {
	KubectlRequest,
	KubectlResponse,
	KubectlTransport,
} from "./kubectl-transport.js";
export {
	createProcessKubectlTransport,
	KubectlUnavailableError,
} from "./kubectl-transport.js";

export interface PortForwardHandle {
	readonly loopbackUrl: string;
	readonly localPort: number;
	readonly close: () => Promise<void>;
}

/**
 * Minimal Kubernetes client surface used by the oci Camp host.
 * All cluster I/O goes through {@link KubectlTransport} (PACT boundary).
 */
export interface KubernetesClient {
	readonly kind: "kubectl";
	readonly namespace: string;
	readonly transport: KubectlTransport;
	apply(manifests: readonly unknown[]): Promise<void>;
	waitReady(
		name: string,
		opts?: { readonly timeoutMs?: number },
	): Promise<void>;
	portForward(service: string, targetPort: number): Promise<PortForwardHandle>;
	/** Proxy HTTP to a port-forwarded service (mesh hop). */
	httpProxy(options: {
		readonly service: string;
		readonly method: string;
		readonly path: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: unknown;
	}): Promise<{
		readonly status: number;
		readonly headers: Record<string, string>;
		readonly json?: unknown;
		readonly text?: string;
	}>;
	delete(name: string): Promise<void>;
	probe(): Promise<KubectlProbeResult>;
}

export interface KubectlProbeResult {
	readonly ready: boolean;
	readonly kubectlBin: string | null;
	readonly clientVersion: string | null;
	readonly clusterReachable: boolean;
	readonly notes: readonly string[];
}

export interface KubectlKubernetesClientOptions {
	readonly namespace?: string;
	/**
	 * Integration transport. Defaults to real process kubectl.
	 * Tests inject `createMockProviderFromPact(pact)` from the kubectl-cluster pact.
	 */
	readonly transport?: KubectlTransport;
	/** Used only when transport is omitted (process kubectl). */
	readonly kubectlBin?: string;
	readonly context?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly ensureNamespace?: boolean;
}

async function call(
	transport: KubectlTransport,
	request: KubectlRequest,
): Promise<KubectlResponse> {
	return transport.handle(request);
}

/**
 * Kubernetes client over a PACT-shaped transport.
 * Production: process kubectl. Tests: pact mock provider.
 */
export function createKubectlKubernetesClient(
	options: KubectlKubernetesClientOptions = {},
): KubernetesClient {
	const namespace = options.namespace ?? "hobo-dev";
	const transport =
		options.transport ??
		createProcessKubectlTransport({
			...(options.kubectlBin !== undefined
				? { kubectlBin: options.kubectlBin }
				: undefined),
			...(options.context !== undefined
				? { context: options.context }
				: undefined),
			...(options.env !== undefined ? { env: options.env } : undefined),
		});
	const ensureNamespace = options.ensureNamespace ?? true;
	let namespaceReady = false;
	const openForwards = new Map<string, PortForwardHandle>();

	async function ensureNs(): Promise<void> {
		if (namespaceReady || !ensureNamespace) {
			namespaceReady = true;
			return;
		}
		const response = await call(transport, {
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace },
		});
		if (response.status >= 400) {
			throw new KubectlUnavailableError(
				`namespace ensure failed: ${JSON.stringify(response.body)}`,
			);
		}
		namespaceReady = true;
	}

	const client: KubernetesClient = {
		kind: "kubectl",
		namespace,
		transport,
		async probe(): Promise<KubectlProbeResult> {
			const notes: string[] = [];
			const version = await call(transport, {
				method: "POST",
				path: "/kubectl/version",
				body: { client: true },
			});
			if (version.status >= 400) {
				return {
					ready: false,
					kubectlBin: null,
					clientVersion: null,
					clusterReachable: false,
					notes: ["kubectl client unavailable", JSON.stringify(version.body)],
				};
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const versionBody = version.body as {
				clientVersion?: string;
				kubectlBin?: string;
			};
			notes.push(
				`kubectl client ${versionBody.clientVersion ?? "ok"}` +
					(versionBody.kubectlBin ? ` (${versionBody.kubectlBin})` : ""),
			);

			const cluster = await call(transport, {
				method: "POST",
				path: "/kubectl/cluster-info",
			});
			// SAFETY: assertion required at this I/O or test boundary.
			const clusterBody = (cluster.body ?? {}) as {
				reachable?: boolean;
				detail?: string;
			};
			const clusterReachable =
				cluster.status < 400 && clusterBody.reachable !== false;
			notes.push(
				clusterReachable
					? "cluster reachable"
					: `cluster not reachable: ${clusterBody.detail ?? JSON.stringify(cluster.body)}`,
			);
			return {
				ready: version.status < 400,
				kubectlBin: versionBody.kubectlBin ?? null,
				clientVersion: versionBody.clientVersion ?? null,
				clusterReachable,
				notes,
			};
		},
		async apply(manifests) {
			await ensureNs();
			const response = await call(transport, {
				method: "POST",
				path: "/kubectl/apply",
				body: { namespace, manifests },
			});
			if (response.status >= 400) {
				throw new KubectlUnavailableError(
					`kubectl apply failed: ${JSON.stringify(response.body)}`,
				);
			}
		},
		async waitReady(name, opts) {
			await ensureNs();
			const response = await call(transport, {
				method: "POST",
				path: "/kubectl/rollout-status",
				body: {
					namespace,
					name,
					timeoutMs: opts?.timeoutMs ?? 120_000,
				},
			});
			if (response.status >= 400) {
				throw new KubectlUnavailableError(
					`workload '${name}' not ready: ${JSON.stringify(response.body)}`,
				);
			}
		},
		async portForward(service, targetPort) {
			await ensureNs();
			const response = await call(transport, {
				method: "POST",
				path: "/kubectl/port-forward",
				body: { namespace, service, targetPort },
			});
			if (response.status >= 400) {
				throw new KubectlUnavailableError(
					`port-forward failed: ${JSON.stringify(response.body)}`,
				);
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const body = response.body as {
				loopbackUrl: string;
				localPort: number;
			};
			const handle: PortForwardHandle = {
				loopbackUrl: body.loopbackUrl,
				localPort: body.localPort,
				close: async () => {
					openForwards.delete(service);
					// Best-effort: delete tears down process forwards.
				},
			};
			openForwards.set(service, handle);
			return handle;
		},
		async httpProxy(options) {
			const response = await call(transport, {
				method: "POST",
				path: "/kubectl/http-proxy",
				body: {
					namespace,
					service: options.service,
					method: options.method,
					path: options.path,
					...(options.headers !== undefined
						? { headers: options.headers }
						: undefined),
					...(options.body !== undefined ? { body: options.body } : undefined),
				},
			});
			if (response.status >= 400) {
				throw new KubectlUnavailableError(
					`http-proxy failed: ${JSON.stringify(response.body)}`,
				);
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const body = response.body as {
				status: number;
				headers?: Record<string, string>;
				json?: unknown;
				text?: string;
			};
			return {
				status: body.status,
				headers: body.headers ?? {},
				...(body.json !== undefined ? { json: body.json } : undefined),
				...(body.text !== undefined ? { text: body.text } : undefined),
			};
		},
		async delete(name) {
			await ensureNs();
			openForwards.delete(name);
			const response = await call(transport, {
				method: "DELETE",
				path: "/kubectl/resources",
				body: { namespace, name },
			});
			if (response.status >= 400) {
				throw new KubectlUnavailableError(
					`delete failed: ${JSON.stringify(response.body)}`,
				);
			}
		},
	};

	return client;
}
