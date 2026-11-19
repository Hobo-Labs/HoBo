import type { RegistrableProvider } from "@hobo/cloud";

// region, it produces a real provider whose capabilities/cost/manifest are all
export function createProviderFromPorts(
	id: string,
	ports: readonly string[],
	region = "local",
): RegistrableProvider {
	return {
		id,
		regions: [region],
		capabilities: ports.map((port) => ({
			port,
			satisfies: (req) =>
				req.port === port
					? { kind: "full" }
					: { kind: "none", missing: [req.port] },
			estimateCost: () => ({
				marginalPrice: "0",
				sku: `${id}-${port}`,
				unit: "hour",
			}),
		})),
		capabilityManifest: () => ({
			providerId: id,
			published: {
				"/.well-known/capability-manifest/index.json": JSON.stringify({
					providerId: id,
					ports: [...ports],
				}),
			},
			capabilities: {
				capabilities: ports.map((port) => ({
					port,
					features: [],
					regions: [region],
				})),
			},
			cost: {
				facts: ports.map((port) => ({
					port,
					sku: `${id}-${port}`,
					unit: "hour",
					marginalPrice: "0",
				})),
			},
		}),
	};
}

// public-contract: provider id for the default bare-metal / local-host yard.
export const BARE_METAL_PROVIDER_ID = "local" as const;

const BARE_METAL_PORTS = [
	"kv",
	"queue",
	"objectStore",
	"hobo:key-value",
	"hobo:message-queue",
	"hobo:object-store",
	"hobo:http-service",
	"hobo:web-app",
	"hobo:data",
	"wasi:http",
	"compute",
] as const;

// already runs on (kv + objectStore, one "local" region, zero cost). Installable
export function createLocalProvider(): RegistrableProvider {
	return createProviderFromPorts("local", ["kv", "objectStore"]);
}

export function createBareMetalProvider(): RegistrableProvider {
	return createProviderFromPorts(BARE_METAL_PROVIDER_ID, [...BARE_METAL_PORTS]);
}
