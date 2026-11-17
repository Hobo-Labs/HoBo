import type {
	HoboRuntimeHost,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";

import { createDaprActorHost } from "./actor-host.js";
import {
	generateDaprComponentYaml,
	kafkaPubsubComponent,
	scopesFromAllow,
} from "./components.js";
import { defaultDaprRuntimeConfig, parseDaprRuntimeConfig } from "./config.js";
import type { DaprSidecarClient } from "./dapr-client.js";
import { resolveDaprClientFromEnv } from "./dapr-client.js";
import { diagnoseDaprReadiness } from "./doctor.js";
import { createDaprMessaging } from "./messaging.js";
import type { DaprRuntimeConfig } from "./types.js";

export interface DaprRuntimeHostOptions {
	readonly config?: DaprRuntimeConfig;
	readonly tenantId?: string;
	readonly campId?: string;
	readonly client?: DaprSidecarClient;
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	readonly healthTimeoutMs?: number;
}

export interface DaprRuntimeBundle {
	readonly host: HoboRuntimeHost;
	readonly config: DaprRuntimeConfig;
	readonly actors: ReturnType<typeof createDaprActorHost>;
	readonly messaging: ReturnType<typeof createDaprMessaging>;
	readonly client: DaprSidecarClient | null;
	generateKafkaPubsubYaml(bootstrapBinding: string): string;
}

export function createDaprRuntimeHost(
	options: DaprRuntimeHostOptions = {},
): DaprRuntimeBundle {
	const config =
		options.config ??
		defaultDaprRuntimeConfig(
			options.tenantId ?? "local",
			options.campId ?? "default",
		);

	const healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
	if (
		!Number.isSafeInteger(healthTimeoutMs) ||
		healthTimeoutMs < 1 ||
		healthTimeoutMs > 30_000
	)
		throw new RangeError("healthTimeoutMs must be between 1 and 30000");
	const client =
		options.client ??
		resolveDaprClientFromEnv(options.env ?? process.env) ??
		null;

	const actors = createDaprActorHost({
		config,
		...(client ? { client } : undefined),
	});
	const messaging = createDaprMessaging({
		config,
		...(client ? { client } : undefined),
	});

	const host: HoboRuntimeHost = {
		kind: "dapr",
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
			const emit = ctx.emitProgress ?? (() => {});
			const reachable = await clientIsReachable(client, healthTimeoutMs);
			const doctor = diagnoseDaprReadiness({
				env: ctx.env ?? process.env,
				config,
				probeRuntime: () => reachable,
			});
			const liveRequested = client?.fidelity === "live";
			const fidelity = liveRequested && reachable ? "live" : "simulated";
			emit(
				`hobo: dapr runtime ensure appId=${config.appId} mode=${config.mode} fidelity=${fidelity}`,
			);
			return {
				kind: "dapr",
				ready: !liveRequested || reachable,
				notes: [
					...doctor.notes,
					`actors=${config.actorsEnabled}`,
					`pubsub=${config.pubsubEnabled}`,
					`workflow=${config.workflowEnabled}`,
					`svidBinding=${config.svidBindingRef}`,
					`client=${client ? "injected" : "none"}`,
				],
				details: {
					appId: config.appId,
					mode: config.mode,
					fidelity,
					httpEndpoint: config.httpEndpoint,
					placementMode: "dapr",
					clientPresent: Boolean(client),
					runtimeReachable: reachable,
				},
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			const handlers = new Map<
				string,
				(input: Request) => Response | Promise<Response>
			>();
			for (const component of ctx.privateComponents) {
				if (component.handler) {
					handlers.set(component.resourceName, component.handler);
				}
			}
			ctx.emitProgress?.(
				`hobo: dapr servePrivate components=${handlers.size} appId=${config.appId}`,
			);
			return {
				kind: "dapr",
				handlers,
				isolation: {
					isolateBoundary: "in_process",
					privateSandboxes: 0,
					details: {
						appId: config.appId,
						mode: config.mode,
						sidecar: false,
						handlerCount: handlers.size,
					},
				},
				close: async () => {},
			};
		},
	};

	return {
		host,
		config,
		actors,
		messaging,
		client,
		generateKafkaPubsubYaml(bootstrapBinding: string) {
			const component = kafkaPubsubComponent({
				bootstrapServersBinding: bootstrapBinding,
				scopes: scopesFromAllow(config.appId, ["publish", "subscribe"]),
			});
			return generateDaprComponentYaml(component).body;
		},
	};
}

export function createDaprHoboRuntimeHost(
	options?: DaprRuntimeHostOptions,
): HoboRuntimeHost {
	return createDaprRuntimeHost(options).host;
}

export { defaultDaprRuntimeConfig, parseDaprRuntimeConfig };

async function clientIsReachable(
	client: DaprSidecarClient | null,
	timeoutMs: number,
): Promise<boolean> {
	if (client?.fidelity !== "live" || !client.health) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			client
				.health()
				.then((healthy) => healthy === true)
				.catch(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} catch {
		return false;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
