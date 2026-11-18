import type {
	FetchHandler,
	HoboRuntimeHost,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";

import { createCloudflareCloudNativeProvider } from "./cloudflare-provider.js";

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

/**
 * Mock provider for setup/parity tests — runs private components in-process
 * via supplied handlers (same mesh contract as local host).
 */
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
			// Apply bindle env for in-process handlers.
			const previous = new Map<
				string,
				{ value: string | undefined; applied: string }
			>();
			for (const [key, value] of Object.entries(ctx.bindleEnv ?? {})) {
				previous.set(key, { value: process.env[key], applied: value });
				process.env[key] = value;
			}
			let closed = false;
			return {
				kind: "cloud-native",
				handlers,
				isolation: {
					isolateBoundary: "cloud_native",
					privateSandboxes: handlers.size,
					details: { provider: "mock" },
				},
				close: async () => {
					if (closed) return;
					closed = true;
					for (const [key, { value, applied }] of previous) {
						if (process.env[key] !== applied) continue;
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				},
			};
		},
	};
}

function stubProvider(id: CloudNativeProviderId): CloudNativeHostProvider {
	return {
		id,
		async ensure() {
			return {
				kind: "cloud-native",
				ready: true,
				notes: [
					`cloud-native provider '${id}' registered (implementation pending)`,
				],
				details: { provider: id, implemented: false },
			};
		},
		async servePrivate() {
			throw new Error(
				`HOBO_CLOUD_NATIVE_UNIMPLEMENTED: provider '${id}' is not implemented yet. ` +
					`Use defaultProvider: "mock" for local parity, or implement @hobo/runtime-cloud-native/${id}.`,
			);
		},
	};
}

export function defaultCloudNativeProviders(): CloudNativeHostProvider[] {
	return [
		createMockCloudNativeProvider(),
		stubProvider("aws"),
		stubProvider("gcp"),
		stubProvider("azure"),
		stubProvider("vercel"),
		// REAL provider (credential-gated): options are read presence-only from
		// the environment; values are never logged.
		createCloudflareCloudNativeProvider({
			accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
			apiToken: process.env.CLOUDFLARE_API_TOKEN,
		}),
	];
}

/**
 * Multi-cloud Camp host registry. Default provider is `mock` for setup tests;
 * real aws/gcp/azure/vercel/cloudflare implementations land later.
 */
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
				// Credential-gated providers fail closed at the provider level, but do
				// not block registry readiness: the registry's default serving path is
				// `mock`, and the gate is surfaced honestly in notes + provider details.
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
