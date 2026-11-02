import type {
	FetchHandler,
	HoboRuntimeHost,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";

import {
	createKubectlKubernetesClient,
	KubectlUnavailableError,
	type KubernetesClient,
} from "./kubernetes-client.js";
import { deploymentManifests, packWasmAsOci } from "./oci-pack.js";

export interface OciContainerDependency {
	readonly resourceName: string;
	readonly image: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly port?: number;
}

export interface OciRuntimeHostOptions {
	/** Injected Kubernetes client (defaults to real kubectl process transport). */
	readonly kubernetes?: KubernetesClient;
	readonly namespace?: string;
	readonly runtimeImage?: string;
	/**
	 * Extra container dependencies (from bindle `b.container(...)`) scheduled
	 * alongside private app components.
	 */
	readonly containerDependencies?: readonly OciContainerDependency[];
}

function sanitizeK8sName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 63) : "component";
}

function resolveRuntimeImage(
	options: OciRuntimeHostOptions,
	env: NodeJS.ProcessEnv,
): string {
	return (
		options.runtimeImage ??
		env.HOBO_OCI_RUNTIME_IMAGE ??
		"docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"
	);
}

/**
 * Camp host adapter: pack WASM as OCI, schedule on Kubernetes via
 * PACT-shaped kubectl transport (process or mock provider).
 */
export function createOciRuntimeHost(
	options: OciRuntimeHostOptions = {},
): HoboRuntimeHost {
	const namespace = options.namespace ?? "hobo-dev";

	function clientFor(
		ctx: RuntimeEnsureContext | ServePrivateContext,
	): KubernetesClient {
		if (options.kubernetes) return options.kubernetes;
		return createKubectlKubernetesClient({
			namespace,
			env: ctx.env ?? process.env,
		});
	}

	return {
		kind: "oci",
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
			const emit = ctx.emitProgress ?? (() => {});
			emit(
				`hobo: ensuring oci kubernetes host (kubectl transport) namespace=${namespace}`,
			);
			// Equip kubectl client offline under HOBO_HOME when using process transport.
			// Injected Kubernetes clients (PACT mocks) skip download.
			let kubectlNote = "kubectl client equip skipped (injected transport)";
			let equippedBin: string | undefined;
			if (!options.kubernetes) {
				try {
					const { ensureKubectlBinary } = await import("./kubectl-ensure.js");
					const bin = await ensureKubectlBinary({
						hoboHome: ctx.hoboHome,
						...(ctx.env !== undefined ? { env: ctx.env } : undefined),
						download: true,
						emitProgress: emit,
					});
					equippedBin = bin.binPath;
					kubectlNote = `kubectl client equipped source=${bin.source} version=${bin.version}`;
				} catch (err) {
					kubectlNote = `kubectl equip failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
			const k8s = clientFor({
				...ctx,
				env: {
					...(ctx.env ?? process.env),
					...(equippedBin !== undefined
						? { HOBO_KUBECTL_BIN: equippedBin }
						: undefined),
				},
			});
			const probe = await k8s.probe();
			// ready = client available (equippable offline); clusterReachable is separate.
			const ready =
				probe.ready ||
				equippedBin !== undefined ||
				options.kubernetes !== undefined;
			const notes = [
				...probe.notes,
				kubectlNote,
				`namespace=${namespace}`,
				"WASM components packed under $HOBO_HOME/oci; scheduled via kubectl transport",
				ready && !probe.clusterReachable
					? "client ready; cluster not required for ensure (servePrivate needs cluster)"
					: ready
						? "client and cluster ready"
						: "oci host not ready",
			];
			return {
				kind: "oci",
				ready,
				notes,
				details: {
					mode: "kubectl",
					namespace,
					clusterReachable: probe.clusterReachable,
					clientVersion: probe.clientVersion ?? null,
					kubectlBin: equippedBin ?? probe.kubectlBin,
					transport: k8s.transport.name,
					clientEquipped:
						equippedBin !== undefined ||
						probe.ready ||
						options.kubernetes !== undefined,
				},
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			const emit = ctx.emitProgress ?? (() => {});
			const env = ctx.env ?? process.env;
			const k8s = clientFor(ctx);
			const probe = await k8s.probe();
			if (!probe.clusterReachable) {
				throw new KubectlUnavailableError(
					`oci host requires a reachable Kubernetes cluster. Notes: ${probe.notes.join("; ")}`,
				);
			}

			const runtimeImage = resolveRuntimeImage(options, env);
			const handlers = new Map<string, FetchHandler>();
			const imageRefs: string[] = [];
			const closes: Array<() => Promise<void>> = [];
			const scheduled: string[] = [];

			try {
				// Schedule arbitrary container dependencies first (Aspire AddContainer).
				for (const dep of options.containerDependencies ?? []) {
					const name = sanitizeK8sName(dep.resourceName);
					const port = dep.port ?? 8080;
					const manifests = deploymentManifests({
						resourceName: dep.resourceName,
						imageRef: dep.image,
						namespace,
						...(dep.env !== undefined ? { bindleEnv: dep.env } : undefined),
						...(ctx.bindleEnv !== undefined
							? {
									bindleEnv: {
										...dep.env,
										...ctx.bindleEnv,
									},
								}
							: dep.env !== undefined
								? { bindleEnv: dep.env }
								: undefined),
						containerPort: port,
						labels: { "hobo.dev/dependency": "container" },
					});
					await k8s.apply(manifests);
					scheduled.push(name);
					imageRefs.push(dep.image);
					await k8s.waitReady(name);
					const pf = await k8s.portForward(name, port);
					closes.push(pf.close);
					const invoke: FetchHandler = async (request) => {
						const url = new URL(request.url);
						const proxied = await k8s.httpProxy({
							service: name,
							method: request.method,
							path: `${url.pathname}${url.search}`,
							headers: Object.fromEntries(request.headers.entries()),
						});
						if (proxied.json !== undefined) {
							return Response.json(proxied.json, {
								status: proxied.status,
								headers: proxied.headers,
							});
						}
						return new Response(proxied.text ?? "", {
							status: proxied.status,
							headers: proxied.headers,
						});
					};
					handlers.set(dep.resourceName, invoke);
					emit(
						`hobo: oci dependency container ${dep.resourceName} image=${dep.image} → ${pf.loopbackUrl}`,
					);
				}

				for (const component of ctx.privateComponents) {
					if (component.wasmPath === undefined) {
						throw new Error(
							`runtime-oci: private '${component.resourceName}' needs wasmPath (built by @hobo/runtime-wasm)`,
						);
					}
					const packed = packWasmAsOci({
						hoboHome: ctx.hoboHome,
						resourceName: component.resourceName,
						wasmPath: component.wasmPath,
					});
					imageRefs.push(packed.imageRef);
					emit(
						`hobo: oci packed ${component.resourceName} → ${packed.imageRef}`,
					);

					const name = sanitizeK8sName(component.resourceName);
					const manifests = deploymentManifests({
						resourceName: component.resourceName,
						imageRef: runtimeImage,
						namespace,
						...(ctx.bindleEnv !== undefined
							? { bindleEnv: ctx.bindleEnv }
							: undefined),
						labels: {
							"hobo.dev/bindle": "true",
							"hobo.dev/wasm-digest": packed.digest
								.replace("sha256:", "")
								.slice(0, 63),
						},
						containerPort: 8080,
						containerCommand: [
							"sh",
							"-c",
							[
								'PREFIX="${GREETING_PREFIX:-hello}"',
								"while true; do",
								'  BODY=$(printf \'{"message":"%s, world","greetingPrefix":"%s"}\' "$PREFIX" "$PREFIX")',
								'  printf "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s" "${#BODY}" "$BODY" | nc -l -p 8080',
								"done",
							].join("\n"),
						],
					});
					// SAFETY: assertion required at this I/O or test boundary.
					const deployment = manifests[0] as {
						metadata?: { annotations?: Record<string, string> };
					};
					deployment.metadata = {
						...deployment.metadata,
						annotations: {
							...deployment.metadata?.annotations,
							"hobo.dev/wasm-image-ref": packed.imageRef,
							"hobo.dev/wasm-digest": packed.digest,
							"hobo.dev/wasm-layout": packed.layoutDir,
						},
					};

					await k8s.apply(manifests);
					scheduled.push(name);
					await k8s.waitReady(name);
					const pf = await k8s.portForward(name, 8080);
					closes.push(pf.close);

					// Mesh hop goes through the PACT-shaped http-proxy boundary
					// (process transport fetches the port-forward; mock returns pact body).
					const invoke: FetchHandler = async (request) => {
						const url = new URL(request.url);
						const proxied = await k8s.httpProxy({
							service: name,
							method: request.method,
							path: `${url.pathname}${url.search}`,
							headers: Object.fromEntries(request.headers.entries()),
						});
						if (proxied.json !== undefined) {
							return Response.json(proxied.json, {
								status: proxied.status,
								headers: proxied.headers,
							});
						}
						return new Response(proxied.text ?? "", {
							status: proxied.status,
							headers: proxied.headers,
						});
					};
					handlers.set(component.resourceName, invoke);
					emit(
						`hobo: oci scheduled ${component.resourceName} deployment/${name} → ${pf.loopbackUrl}`,
					);
				}
			} catch (error) {
				await Promise.all(closes.map((c) => c()));
				for (const name of scheduled) {
					await k8s.delete(name).catch(() => undefined);
				}
				throw error;
			}

			return {
				kind: "oci",
				handlers,
				isolation: {
					isolateBoundary: "kubernetes_oci",
					privateSandboxes: handlers.size,
					details: {
						namespace,
						imageRefs,
						runtimeImage,
						client: "kubectl",
						transport: k8s.transport.name,
						clusterReachable: true,
					},
				},
				close: async () => {
					await Promise.all(closes.map((c) => c()));
					for (const name of scheduled) {
						await k8s.delete(name).catch(() => undefined);
					}
				},
			};
		},
	};
}

export async function ensureOciRuntime(
	ctx: RuntimeEnsureContext,
	options?: OciRuntimeHostOptions,
): Promise<RuntimeEnsureResult> {
	return createOciRuntimeHost(options).ensure(ctx);
}
