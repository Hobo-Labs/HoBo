import type {
	FetchHandler,
	HoboRuntimeHost,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";

import { createCloudflareCloudNativeProvider } from "./cloudflare-provider.js";
import {
	createAwsCloudNativeProvider,
	createAzureCloudNativeProvider,
	createGcpCloudNativeProvider,
	createVercelCloudNativeProvider,
} from "./endpoint-provider.js";

export type CloudNativeProviderId =
	| "aws"
	| "gcp"
	| "azure"
	| "vercel"
	| "cloudflare"
	| "mock"
	| (string & {});

export interface CloudNativeHostProvider {
	readonly id: CloudNativeProviderId;
	ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult>;
	servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult>;
}

export interface CloudNativeRuntimeHostOptions {
	readonly providers?: readonly CloudNativeHostProvider[];
	readonly defaultProvider?: CloudNativeProviderId;
}

export function createMockCloudNativeProvider(): CloudNativeHostProvider {
	return {
		id: "mock",
		async ensure(ctx) {
			ctx.emitProgress?.("hobo: cloud-native mock provider ready");
			return {
				kind: "cloud-native",
				ready: true,
				notes: ["cloud-native mock provider ready (in-process handlers)"],
				details: { provider: "mock" },
			};
		},
		async servePrivate(ctx) {
			const handlers = new Map<string, FetchHandler>();
			for (const component of ctx.privateComponents) {
				if (!component.handler) {
					throw new Error(
						`cloud-native mock: private '${component.resourceName}' requires handler`,
					);
				}
				handlers.set(component.resourceName, component.handler);
			}
			const previous: Record<string, string | undefined> = {};
			for (const [key, value] of Object.entries(ctx.bindleEnv ?? {})) {
				previous[key] = process.env[key];
				process.env[key] = value;
			}
			return {
				kind: "cloud-native",
				handlers,
				isolation: {
					isolateBoundary: "cloud_native",
					privateSandboxes: handlers.size,
					details: { provider: "mock" },
				},
				close: async () => {
					for (const [key, value] of Object.entries(previous)) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				},
			};
		},
	};
}

export function defaultCloudNativeProviders(): CloudNativeHostProvider[] {
	return [
		createMockCloudNativeProvider(),
		createAwsCloudNativeProvider(),
		createGcpCloudNativeProvider(),
		createAzureCloudNativeProvider(),
		createVercelCloudNativeProvider(),
		createCloudflareCloudNativeProvider({
			accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
			apiToken: process.env.CLOUDFLARE_API_TOKEN,
		}),
	];
}

export function createCloudNativeRuntimeHost(
	options: CloudNativeRuntimeHostOptions = {},
): HoboRuntimeHost {
	const providers = [...(options.providers ?? defaultCloudNativeProviders())];
	const byId = new Map(providers.map((p) => [p.id, p]));
	const defaultProvider = options.defaultProvider ?? "mock";

	function pick(): CloudNativeHostProvider {
		const selected = byId.get(defaultProvider);
		if (!selected) {
			throw new Error(
				`cloud-native: unknown default provider '${defaultProvider}' (known: ${[...byId.keys()].join(", ")})`,
			);
		}
		return selected;
	}

	return {
		kind: "cloud-native",
		async ensure(ctx) {
			const emit = ctx.emitProgress ?? (() => {});
			const notes: string[] = [];
			let ready = true;
			for (const provider of providers) {
				const result = await provider.ensure(ctx);
				notes.push(...result.notes.map((n) => `[${provider.id}] ${n}`));
				if (!result.ready && result.details?.credentialGated !== true)
					ready = false;
			}
			emit(
				`hobo: cloud-native registry ready providers=[${providers.map((p) => p.id).join(",")}] default=${defaultProvider}`,
			);
			return {
				kind: "cloud-native",
				ready,
				notes,
				details: {
					providers: providers.map((p) => p.id),
					defaultProvider,
				},
			};
		},
		async servePrivate(ctx) {
			return pick().servePrivate(ctx);
		},
	};
}

export async function ensureCloudNativeRuntime(
	ctx: RuntimeEnsureContext,
	options?: CloudNativeRuntimeHostOptions,
): Promise<RuntimeEnsureResult> {
	return createCloudNativeRuntimeHost(options).ensure(ctx);
}
