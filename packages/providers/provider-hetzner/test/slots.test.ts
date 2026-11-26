import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	type CloudServerOptions,
	cloudServer,
	cloudServerWorker,
	loadBalancer,
	objectStorage,
	storageBox,
	volume,
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

function extraOptions(json: string): CloudServerOptions {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as CloudServerOptions;
}

/** Every factory, called with no options, plus the triple it must emit. */
const NO_ARG_FACTORIES = [
	[
		"cloudServer",
		() => cloudServer(),
		"web",
		"web.hosted/v1",
		"hetzner.cloud-server/v1",
	],
	[
		"cloudServerWorker",
		() => cloudServerWorker(),
		"service",
		"service.worker/v1",
		"hetzner.cloud-server/v1",
	],
	[
		"loadBalancer",
		() => loadBalancer(),
		"api",
		"api.http/v1",
		"hetzner.load-balancer/v1",
	],
	[
		"objectStorage",
		() => objectStorage(),
		"bucket",
		"bucket.s3-compatible/v1",
		"hetzner.object-storage/v1",
	],
	[
		"storageBox",
		() => storageBox(),
		"bucket",
		"bucket.file-storage/v1",
		"hetzner.storage-box/v1",
	],
	[
		"volume",
		() => volume(),
		"bucket",
		// A block device formatted ext4/xfs has path semantics, which is
		// filesystem — distinct from a Storage Box's metadata-carrying share.
		"bucket.filesystem/v1",
		"hetzner.volume/v1",
	],
] as const;

describe("Hetzner slot factories emit the documented triple", () => {
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

	/**
	 * One product, two capability profiles. A Cloud Server serving a public
	 * origin and a Cloud Server running a worker are the same purchase; the
	 * profile is what a workload matches on, so both rows exist.
	 */
	it("reaches the same product through two profiles", () => {
		expect(cloudServer().productId).toBe(cloudServerWorker().productId);
		expect(cloudServer().profile).not.toBe(cloudServerWorker().profile);
	});
});

describe("options land in properties and omitted options stay absent", () => {
	it("cloudServer keeps only the options the caller passed", () => {
		const binding = cloudServer({ serverType: "cx22" });
		expect(binding.properties).toEqual({ serverType: "cx22" });
		expect(Object.keys(binding.properties)).toEqual(["serverType"]);
		expect("image" in binding.properties).toBe(false);
		expect("backups" in binding.properties).toBe(false);
	});

	it("cloudServer carries every option when every option is passed", () => {
		expect(
			cloudServer({
				serverType: "cax11",
				image: "ubuntu-24.04",
				architecture: "arm",
				backups: true,
				placementGroup: "spread-1",
				network: "private-1",
			}).properties,
		).toEqual({
			serverType: "cax11",
			image: "ubuntu-24.04",
			architecture: "arm",
			backups: true,
			placementGroup: "spread-1",
			network: "private-1",
		});
	});

	it("volume invents no size or format", () => {
		const binding = volume({ automount: true });
		expect(binding.properties).toEqual({ automount: true });
		expect("sizeGb" in binding.properties).toBe(false);
		expect("format" in binding.properties).toBe(false);
	});

	it("loadBalancer invents no type when only the algorithm is set", () => {
		const binding = loadBalancer({ algorithm: "least_connections" });
		expect(binding.properties).toEqual({ algorithm: "least_connections" });
		expect("loadBalancerType" in binding.properties).toBe(false);
	});

	it("objectStorage invents no ACL when only versioning is set", () => {
		const binding = objectStorage({ versioning: true });
		expect(binding.properties).toEqual({ versioning: true });
		expect("acl" in binding.properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		const smuggled = extraOptions('{"apiKey":"x"}');
		expect(refusalCode(() => cloudServer(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		const smuggled = extraOptions('{"unknownKnob":1}');
		expect(cloudServer(smuggled).properties).toEqual({ unknownKnob: 1 });
	});

	it("refuses a credential-shaped key on the worker factory too", () => {
		const smuggled = extraOptions('{"password":"x"}');
		expect(refusalCode(() => cloudServerWorker(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = { serverType: "cx32", backups: true } as const;
		expect(cloudServer(options)).toEqual(cloudServer(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
