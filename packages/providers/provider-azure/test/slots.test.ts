import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	aks,
	apiManagement,
	appService,
	type BlobStorageOptions,
	blobStorage,
	containerApps,
	containerAppsService,
	cosmosDb,
	cosmosTable,
	functions,
	type KeyVaultOptions,
	keyVault,
	postgresFlexible,
	redisCache,
	serviceBusQueue,
	serviceBusTopic,
	sqlDatabase,
	staticWebApps,
	storageQueue,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

/** The code core refused a call with, or undefined if it did not refuse. */
function refusalCode(call: () => void): string | undefined {
	try {
		call();
		return undefined;
	} catch (error) {
		if (!(error instanceof SlotBindingError)) throw error;
		return error.code;
	}
}

function extraBlob(json: string): BlobStorageOptions {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as BlobStorageOptions;
}

function extraVault(json: string): KeyVaultOptions {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as KeyVaultOptions;
}

/**
 * The capability profiles ADR-0151 actually publishes. A factory naming a
 * profile outside this set would fail at selection with nothing to match, so
 * the list is asserted rather than trusted.
 */
const REAL_PROFILES: readonly string[] = [
	"web.static/v1",
	"web.hosted/v1",
	"web.ssr/v1",
	"api.http/v1",
	"service.worker/v1",
	"service.batch/v1",
	"service.scheduled/v1",
	"service.queue-consumer/v1",
	"data.relational/v1",
	"data.postgres/v1",
	"data.mysql/v1",
	"data.sqlite/v1",
	"data.document/v1",
	"data.vector/v1",
	"kv.key-value/v1",
	"kv.redis-compatible/v1",
	"bucket.object/v1",
	"bucket.s3-compatible/v1",
	"bucket.file-storage/v1",
	"queue.at-least-once/v1",
	"queue.fifo/v1",
	"topic.pubsub/v1",
	"secret-ref.locator/v1",
	"webhook.inbound-http/v1",
];

/** Every factory, called with no options, plus the triple it must emit. */
const NO_ARG_FACTORIES = [
	[
		"staticWebApps",
		() => staticWebApps(),
		"web",
		"web.static/v1",
		"azure.static-web-apps/v1",
	],
	[
		"appService",
		() => appService(),
		"web",
		"web.hosted/v1",
		"azure.app-service/v1",
	],
	[
		"containerApps",
		() => containerApps(),
		"web",
		"web.hosted/v1",
		"azure.container-apps/v1",
	],
	["aks", () => aks(), "web", "web.hosted/v1", "azure.aks/v1"],
	[
		"apiManagement",
		() => apiManagement(),
		"api",
		"api.http/v1",
		"azure.api-management/v1",
	],
	[
		"functions",
		() => functions(),
		"service",
		"service.worker/v1",
		"azure.functions/v1",
	],
	[
		"containerAppsService",
		() => containerAppsService(),
		"service",
		"service.worker/v1",
		"azure.container-apps/v1",
	],
	[
		"postgresFlexible",
		() => postgresFlexible(),
		"data",
		"data.postgres/v1",
		"azure.postgres-flexible/v1",
	],
	[
		"sqlDatabase",
		() => sqlDatabase(),
		"data",
		"data.relational/v1",
		"azure.sql-database/v1",
	],
	[
		"cosmosDb",
		() => cosmosDb(),
		"data",
		"data.document/v1",
		"azure.cosmos-db/v1",
	],
	[
		"cosmosTable",
		() => cosmosTable(),
		"kv",
		"kv.key-value/v1",
		"azure.cosmos-table/v1",
	],
	[
		"redisCache",
		() => redisCache(),
		"kv",
		"kv.redis-compatible/v1",
		"azure.cache-for-redis/v1",
	],
	[
		"blobStorage",
		() => blobStorage(),
		"bucket",
		"bucket.object/v1",
		"azure.blob-storage/v1",
	],
	[
		"storageQueue",
		() => storageQueue(),
		"queue",
		"queue.at-least-once/v1",
		"azure.storage-queue/v1",
	],
	[
		"serviceBusQueue",
		() => serviceBusQueue(),
		"queue",
		"queue.fifo/v1",
		"azure.service-bus-queue/v1",
	],
	[
		"serviceBusTopic",
		() => serviceBusTopic(),
		"topic",
		"topic.pubsub/v1",
		"azure.service-bus-topic/v1",
	],
	[
		"keyVault",
		() => keyVault(),
		"secretRef",
		"secret-ref.locator/v1",
		"azure.key-vault/v1",
	],
] as const;

describe("Azure slot factories emit the documented triple", () => {
	it.each(
		NO_ARG_FACTORIES,
	)("%s binds slot/profile/product without arguments", (_name, call, slot, profile, productId) => {
		const binding = call();
		expect(binding.slot).toBe(slot);
		expect(binding.profile).toBe(profile);
		expect(binding.productId).toBe(productId);
	});

	it.each(
		NO_ARG_FACTORIES,
	)("%s names a published capability profile", (_name, _call, _slot, profile) => {
		expect(REAL_PROFILES).toContain(profile);
	});

	it.each(
		NO_ARG_FACTORIES,
	)("%s yields empty properties when called with no options", (_name, call) => {
		expect(call().properties).toEqual({});
	});

	it("emits an azure-namespaced product id everywhere", () => {
		for (const [, call] of NO_ARG_FACTORIES) {
			expect(call().productId).toMatch(/^azure\./u);
		}
	});
});

describe("options land in properties and omitted options stay absent", () => {
	it("staticWebApps keeps only the options the caller passed", () => {
		const binding = staticWebApps({ sku: "standard" });
		expect(binding.properties).toEqual({ sku: "standard" });
		expect(Object.keys(binding.properties)).toEqual(["sku"]);
		expect("appLocation" in binding.properties).toBe(false);
	});

	it("appService invents no instance count when only the plan is set", () => {
		const binding = appService({ planSku: "P1v3" });
		expect(binding.properties).toEqual({ planSku: "P1v3" });
		expect("instances" in binding.properties).toBe(false);
		expect("alwaysOn" in binding.properties).toBe(false);
	});

	it("containerApps carries every option when every option is passed", () => {
		expect(
			containerApps({
				cpu: 0.5,
				image: "ghcr.io/hobo/app:1",
				ingress: "external",
				maxReplicas: 5,
				memory: "1Gi",
				minReplicas: 1,
			}).properties,
		).toEqual({
			cpu: 0.5,
			image: "ghcr.io/hobo/app:1",
			ingress: "external",
			maxReplicas: 5,
			memory: "1Gi",
			minReplicas: 1,
		});
	});

	it("aks keeps nested compute quantities and omits the sibling", () => {
		const binding = aks({ limits: { cpu: "500m" }, replicas: 2 });
		expect(binding.properties).toEqual({
			limits: { cpu: "500m" },
			replicas: 2,
		});
		expect("requests" in binding.properties).toBe(false);
		const limits = binding.properties.limits;
		expect(isJsonObject(limits) && !("memory" in limits)).toBe(true);
	});

	it("postgresFlexible invents no storage size", () => {
		expect(postgresFlexible({ highAvailability: true }).properties).toEqual({
			highAvailability: true,
		});
		expect("storageGb" in postgresFlexible().properties).toBe(false);
	});

	it("keyVault names the vault and nothing inside it", () => {
		expect(keyVault({ vaultName: "kv-hobo" }).properties).toEqual({
			vaultName: "kv-hobo",
		});
		expect("rbacAuthorization" in keyVault().properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		const smuggled = extraBlob('{"apiKey":"x"}');
		expect(refusalCode(() => blobStorage(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("refuses a credential-shaped key on the secretRef factory too", () => {
		const smuggled = extraVault('{"vaultPassword":"x"}');
		expect(refusalCode(() => keyVault(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		const smuggled = extraBlob('{"unknownKnob":1}');
		expect(blobStorage(smuggled).properties).toEqual({ unknownKnob: 1 });
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = { capacity: 2, skuName: "Premium" } as const;
		expect(redisCache(options)).toEqual(redisCache(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
