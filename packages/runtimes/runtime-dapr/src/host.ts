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
	/** Live daprd client (harness or real). When set, messaging/actors use it. */
	readonly client?: DaprSidecarClient;
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface DaprRuntimeBundle {
	readonly host: HoboRuntimeHost;
	readonly config: DaprRuntimeConfig;
	readonly actors: ReturnType<typeof createDaprActorHost>;
	readonly messaging: ReturnType<typeof createDaprMessaging>;
	readonly client: DaprSidecarClient | null;
	generateKafkaPubsubYaml(bootstrapBinding: string): string;
}

/**
 * Optional Camp runtime backend (`kind: "dapr"`).
 * Does not replace local/wasm defaults (ADR-0031).
 */
export function createDaprRuntimeHost(
	options: DaprRuntimeHostOptions = {},
): DaprRuntimeBundle {
	const config =
		options.config ??
		defaultDaprRuntimeConfig(
			options.tenantId ?? "local",
			options.campId ?? "default",
		);

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
			const doctor = diagnoseDaprReadiness({
				env: ctx.env ?? process.env,
				config,
				...(client?.health
					? {
							probeRuntime: () => {
								// sync doctor path: treat injected client as reachable
								return true;
							},
						}
					: undefined),
			});
			const fidelity = client ? "live" : doctor.fidelity;
			emit(
				`hobo: dapr runtime ensure appId=${config.appId} mode=${config.mode} fidelity=${fidelity}`,
			);
			return {
				kind: "dapr",
				ready: true,
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
				},
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			// Polyglot path: handlers still in-process for tests; live mode would
			// inject sidecar annotations / dapr run wrappers outside this host.
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
					isolateBoundary: "dapr_sidecar",
					privateSandboxes: handlers.size,
					details: {
						appId: config.appId,
						mode: config.mode,
						sidecar: true,
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
