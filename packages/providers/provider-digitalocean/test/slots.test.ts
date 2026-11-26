import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	appPlatform,
	blockStorage,
	droplet,
	dropletWorker,
	loadBalancer,
	managed,
	managedValkey,
	type SpacesOptions,
	spaces,
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

/** Every factory, called with no options, plus the triple it must emit. */
const NO_ARG_FACTORIES = [
	[
		"appPlatform.service",
		() => appPlatform.service(),
		"web",
		"web.hosted/v1",
		"digitalocean.app-platform-service/v1",
	],
	[
		"appPlatform.staticSite",
		() => appPlatform.staticSite(),
		"web",
		"web.static/v1",
		"digitalocean.app-platform-static-site/v1",
	],
	[
		"droplet",
		() => droplet(),
		"web",
		"web.hosted/v1",
		"digitalocean.droplet/v1",
	],
	[
		"loadBalancer",
		() => loadBalancer(),
		"api",
		"api.http/v1",
		"digitalocean.load-balancer/v1",
	],
	[
		"managed.postgres",
		() => managed.postgres(),
		"data",
		"data.postgres/v1",
		"digitalocean.managed-postgres/v1",
	],
	[
		"managedValkey",
		() => managedValkey(),
		"kv",
		// The most specific true profile. It refines kv.redis-compatible, which
		// refines kv.key-value, so a request for either ancestor still matches.
		"kv.valkey/v1",
		"digitalocean.managed-valkey/v1",
	],
	[
		"dropletWorker",
		() => dropletWorker(),
		"service",
		"service.worker/v1",
		"digitalocean.droplet/v1",
	],
	[
		"blockStorage",
		() => blockStorage(),
		"bucket",
		"bucket.filesystem/v1",
		"digitalocean.block-storage/v1",
	],
	[
		"spaces",
		() => spaces(),
		"bucket",
		"bucket.s3-compatible/v1",
		"digitalocean.spaces/v1",
	],
] as const;

describe("DigitalOcean slot factories emit the documented triple", () => {
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
	it("spaces keeps only the options the caller passed", () => {
		const binding = spaces({ cdn: true });
		expect(binding.properties).toEqual({ cdn: true });
		expect(Object.keys(binding.properties)).toEqual(["cdn"]);
		expect("acl" in binding.properties).toBe(false);
		expect("versioning" in binding.properties).toBe(false);
	});

	it("spaces carries every option when every option is passed", () => {
		expect(
			spaces({ acl: "public-read", cdn: false, versioning: true }).properties,
		).toEqual({ acl: "public-read", cdn: false, versioning: true });
	});

	it("managed.postgres invents no plan size or node count", () => {
		const binding = managed.postgres({ version: "16" });
		expect(binding.properties).toEqual({ version: "16" });
		expect("size" in binding.properties).toBe(false);
		expect("nodeCount" in binding.properties).toBe(false);
		expect("storageMib" in binding.properties).toBe(false);
	});

	it("droplet invents no image when only the size is set", () => {
		const binding = droplet({ size: "s-1vcpu-1gb" });
		expect(binding.properties).toEqual({ size: "s-1vcpu-1gb" });
		expect("image" in binding.properties).toBe(false);
	});

	it("appPlatform.service invents no instance count when only ingress is set", () => {
		const binding = appPlatform.service({ ingress: "public" });
		expect(binding.properties).toEqual({ ingress: "public" });
		expect("instanceCount" in binding.properties).toBe(false);
		expect("instanceSizeSlug" in binding.properties).toBe(false);
	});

	it("loadBalancer invents no algorithm when only the size unit is set", () => {
		const binding = loadBalancer({ sizeUnit: 2 });
		expect(binding.properties).toEqual({ sizeUnit: 2 });
		expect("algorithm" in binding.properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const smuggled = { apiKey: "x" } as SpacesOptions;
		expect(refusalCode(() => spaces(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const smuggled = { unknownKnob: 1 } as SpacesOptions;
		expect(spaces(smuggled).properties).toEqual({ unknownKnob: 1 });
	});

	it("refuses a credential-shaped key on a namespaced factory too", () => {
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const smuggled = { password: "x" } as Parameters<
			typeof managed.postgres
		>[0];
		expect(refusalCode(() => managed.postgres(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = { size: "db-s-1vcpu-1gb", nodeCount: 3 } as const;
		expect(managed.postgres(options)).toEqual(managed.postgres(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
