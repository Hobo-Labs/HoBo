import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	apiGateway,
	appEngine,
	type CloudStorageOptions,
	cloudFunctions,
	cloudRun,
	cloudRunJob,
	cloudSqlMysql,
	cloudSqlPostgres,
	cloudStorage,
	cloudStorageSite,
	cloudTasks,
	firestore,
	memorystoreRedis,
	pubsub,
	type SecretManagerOptions,
	secretManager,
} from "../src/index.js";

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

function extraStorage(json: string): CloudStorageOptions {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as CloudStorageOptions;
}

function extraSecret(json: string): SecretManagerOptions {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as SecretManagerOptions;
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
	["cloudRun", () => cloudRun(), "web", "web.hosted/v1", "gcp.cloud-run/v1"],
	["appEngine", () => appEngine(), "web", "web.hosted/v1", "gcp.app-engine/v1"],
	[
		"cloudStorageSite",
		() => cloudStorageSite(),
		"web",
		"web.static/v1",
		"gcp.cloud-storage-site/v1",
	],
	[
		"apiGateway",
		() => apiGateway(),
		"api",
		"api.http/v1",
		"gcp.api-gateway/v1",
	],
	[
		"cloudFunctions",
		() => cloudFunctions(),
		"service",
		"service.worker/v1",
		"gcp.cloud-functions/v1",
	],
	[
		"cloudRunJob",
		() => cloudRunJob(),
		"service",
		"service.batch/v1",
		"gcp.cloud-run-job/v1",
	],
	[
		"cloudSqlPostgres",
		() => cloudSqlPostgres(),
		"data",
		"data.postgres/v1",
		"gcp.cloud-sql-postgres/v1",
	],
	[
		"cloudSqlMysql",
		() => cloudSqlMysql(),
		"data",
		"data.mysql/v1",
		"gcp.cloud-sql-mysql/v1",
	],
	[
		"firestore",
		() => firestore(),
		"data",
		"data.document/v1",
		"gcp.firestore/v1",
	],
	[
		"memorystoreRedis",
		() => memorystoreRedis(),
		"kv",
		"kv.redis-compatible/v1",
		"gcp.memorystore-redis/v1",
	],
	[
		"cloudStorage",
		() => cloudStorage(),
		"bucket",
		"bucket.object/v1",
		"gcp.cloud-storage/v1",
	],
	[
		"cloudTasks",
		() => cloudTasks(),
		"queue",
		"queue.at-least-once/v1",
		"gcp.cloud-tasks/v1",
	],
	["pubsub", () => pubsub(), "topic", "topic.pubsub/v1", "gcp.pubsub-topic/v1"],
	[
		"secretManager",
		() => secretManager(),
		"secretRef",
		"secret-ref.locator/v1",
		"gcp.secret-manager/v1",
	],
] as const;

describe("GCP slot factories emit the documented triple", () => {
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

	it("emits a gcp-namespaced product id everywhere", () => {
		for (const [, call] of NO_ARG_FACTORIES) {
			expect(call().productId).toMatch(/^gcp\./u);
		}
	});
});

describe("options land in properties and omitted options stay absent", () => {
	it("cloudRun keeps only the options the caller passed", () => {
		const binding = cloudRun({ maxInstances: 4 });
		expect(binding.properties).toEqual({ maxInstances: 4 });
		expect(Object.keys(binding.properties)).toEqual(["maxInstances"]);
		expect("minInstances" in binding.properties).toBe(false);
	});

	it("cloudRun carries every option when every option is passed", () => {
		expect(
			cloudRun({
				concurrency: 80,
				cpu: "1",
				image: "gcr.io/hobo/app:1",
				ingress: "all",
				maxInstances: 10,
				memory: "512Mi",
				minInstances: 1,
			}).properties,
		).toEqual({
			concurrency: 80,
			cpu: "1",
			image: "gcr.io/hobo/app:1",
			ingress: "all",
			maxInstances: 10,
			memory: "512Mi",
			minInstances: 1,
		});
	});

	it("cloudSqlPostgres invents no storage size", () => {
		expect(cloudSqlPostgres({ tier: "db-custom-2-7680" }).properties).toEqual({
			tier: "db-custom-2-7680",
		});
		expect("storageGb" in cloudSqlPostgres().properties).toBe(false);
	});

	it("firestore invents no mode", () => {
		expect(firestore({ locationId: "nam5" }).properties).toEqual({
			locationId: "nam5",
		});
		expect("mode" in firestore().properties).toBe(false);
	});

	it("pubsub invents no retention when only ordering is set", () => {
		const binding = pubsub({ messageOrdering: true });
		expect(binding.properties).toEqual({ messageOrdering: true });
		expect("messageRetentionSeconds" in binding.properties).toBe(false);
	});

	it("secretManager keeps a locator policy and nothing secret", () => {
		const binding = secretManager({
			replicaLocations: ["us-central1"],
			replication: "user-managed",
		});
		expect(binding.properties).toEqual({
			replicaLocations: ["us-central1"],
			replication: "user-managed",
		});
		expect("rotationPeriodSeconds" in binding.properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		const smuggled = extraStorage('{"apiKey":"x"}');
		expect(refusalCode(() => cloudStorage(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("refuses a credential-shaped key on the secretRef factory too", () => {
		const smuggled = extraSecret('{"secretId":"x"}');
		expect(refusalCode(() => secretManager(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		const smuggled = extraStorage('{"unknownKnob":1}');
		expect(cloudStorage(smuggled).properties).toEqual({ unknownKnob: 1 });
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = { memoryGb: 4, tier: "standard-ha" } as const;
		expect(memorystoreRedis(options)).toEqual(memorystoreRedis(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
