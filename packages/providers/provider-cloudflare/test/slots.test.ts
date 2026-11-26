import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	d1,
	kv,
	pages,
	queues,
	type R2Options,
	r2,
	workers,
} from "../src/index.js";

/** The code core refused a call with, or undefined if it did not refuse. */
function refusalCode(call: () => void): string | undefined {
	try {
		call();
		return undefined;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return error instanceof SlotBindingError ? error.code : undefined;
	}
}

/** Every factory, called with no options, plus the triple it must emit. */
const NO_ARG_FACTORIES = [
	["r2", () => r2(), "bucket", "bucket.s3-compatible/v1", "cloudflare.r2/v1"],
	["d1", () => d1(), "data", "data.sqlite/v1", "cloudflare.d1/v1"],
	["kv", () => kv(), "kv", "kv.key-value/v1", "cloudflare.kv/v1"],
	[
		"queues",
		() => queues(),
		"queue",
		"queue.at-least-once/v1",
		"cloudflare.queues/v1",
	],
	[
		"workers",
		() => workers(),
		"service",
		"service.worker/v1",
		"cloudflare.workers/v1",
	],
	["pages", () => pages(), "web", "web.hosted/v1", "cloudflare.pages/v1"],
] as const;

describe("Cloudflare slot factories emit the documented triple", () => {
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
	)("%s yields empty properties when called with no options", (_name, call) => {
		expect(call().properties).toEqual({});
	});
});

describe("options land in properties and omitted options stay absent", () => {
	it("r2 keeps only the options the caller passed", () => {
		const binding = r2({ jurisdiction: "eu" });
		expect(binding.properties).toEqual({ jurisdiction: "eu" });
		expect(Object.keys(binding.properties)).toEqual(["jurisdiction"]);
		expect("publicBucket" in binding.properties).toBe(false);
	});

	it("r2 carries every option when every option is passed", () => {
		expect(
			r2({ publicBucket: false, jurisdiction: "fedramp" }).properties,
		).toEqual({ publicBucket: false, jurisdiction: "fedramp" });
	});

	it("d1 invents no read-replication setting", () => {
		expect(d1({ readReplication: true }).properties).toEqual({
			readReplication: true,
		});
		expect("readReplication" in d1().properties).toBe(false);
	});

	it("kv invents no ttl", () => {
		expect(kv({ ttlSeconds: 60 }).properties).toEqual({ ttlSeconds: 60 });
		expect("ttlSeconds" in kv().properties).toBe(false);
	});

	it("queues invents no retry count when only batch size is set", () => {
		const binding = queues({ maxBatchSize: 10 });
		expect(binding.properties).toEqual({ maxBatchSize: 10 });
		expect("maxRetries" in binding.properties).toBe(false);
	});

	it("workers invents no compatibility date when only placement is set", () => {
		const binding = workers({ smartPlacement: true });
		expect(binding.properties).toEqual({ smartPlacement: true });
		expect("compatibilityDate" in binding.properties).toBe(false);
	});

	it("pages invents no production branch", () => {
		expect(pages({ productionBranch: "main" }).properties).toEqual({
			productionBranch: "main",
		});
		expect("productionBranch" in pages().properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const smuggled = { apiKey: "x" } as R2Options;
		expect(refusalCode(() => r2(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const smuggled = { unknownKnob: 1 } as R2Options;
		expect(r2(smuggled).properties).toEqual({ unknownKnob: 1 });
	});

	it("refuses a credential-shaped key on another factory too", () => {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const smuggled = { accountToken: "x" } as Parameters<typeof workers>[0];
		expect(refusalCode(() => workers(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = { maxBatchSize: 25, maxRetries: 3 } as const;
		expect(queues(options)).toEqual(queues(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
