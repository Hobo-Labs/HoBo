import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	dnsZone,
	mysql,
	staticSite,
	type VpsOptions,
	vps,
	vpsWorker,
	webHosting,
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

function extraOptions(json: string): VpsOptions {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as VpsOptions;
}

/** Every factory, called with no options, plus the triple it must emit. */
const NO_ARG_FACTORIES = [
	["vps", () => vps(), "web", "web.hosted/v1", "hostinger.vps/v1"],
	[
		"vpsWorker",
		() => vpsWorker(),
		"service",
		"service.worker/v1",
		"hostinger.vps/v1",
	],
	[
		"webHosting",
		() => webHosting(),
		"web",
		"web.hosted/v1",
		"hostinger.web-hosting/v1",
	],
	[
		"staticSite",
		() => staticSite(),
		"web",
		"web.static/v1",
		"hostinger.static-site/v1",
	],
	["mysql", () => mysql(), "data", "data.mysql/v1", "hostinger.mysql/v1"],
	["dnsZone", () => dnsZone(), "api", "api.http/v1", "hostinger.dns-zone/v1"],
] as const;

describe("Hostinger slot factories emit the documented triple", () => {
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

	it("reaches the same VPS product through two profiles", () => {
		expect(vps().productId).toBe(vpsWorker().productId);
		expect(vps().profile).not.toBe(vpsWorker().profile);
	});
});

describe("options land in properties and omitted options stay absent", () => {
	it("vps keeps only the options the caller passed", () => {
		const binding = vps({ template: "ubuntu-24-04" });
		expect(binding.properties).toEqual({ template: "ubuntu-24-04" });
		expect(Object.keys(binding.properties)).toEqual(["template"]);
		expect("plan" in binding.properties).toBe(false);
		expect("backups" in binding.properties).toBe(false);
	});

	it("vps carries every option when every option is passed", () => {
		expect(
			vps({
				template: "debian-12",
				plan: "kvm2",
				hostname: "api-1",
				backups: true,
				monitoring: false,
			}).properties,
		).toEqual({
			template: "debian-12",
			plan: "kvm2",
			hostname: "api-1",
			backups: true,
			monitoring: false,
		});
	});

	it("mysql invents no version or charset", () => {
		const binding = mysql({ remoteAccess: true });
		expect(binding.properties).toEqual({ remoteAccess: true });
		expect("version" in binding.properties).toBe(false);
		expect("charset" in binding.properties).toBe(false);
	});

	it("webHosting invents no PHP version when only the plan is set", () => {
		const binding = webHosting({ plan: "business" });
		expect(binding.properties).toEqual({ plan: "business" });
		expect("phpVersion" in binding.properties).toBe(false);
	});

	it("dnsZone invents no TTL when only wildcard is set", () => {
		const binding = dnsZone({ wildcard: true });
		expect(binding.properties).toEqual({ wildcard: true });
		expect("ttl" in binding.properties).toBe(false);
	});
});

describe("the core parse boundary still applies", () => {
	it("refuses a credential-shaped option key that bypassed the types", () => {
		const smuggled = extraOptions('{"password":"x"}');
		expect(refusalCode(() => vps(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		const smuggled = extraOptions('{"unknownKnob":1}');
		expect(vps(smuggled).properties).toEqual({ unknownKnob: 1 });
	});

	it("refuses a credential-shaped key on the worker factory too", () => {
		const smuggled = extraOptions('{"apiKey":"x"}');
		expect(refusalCode(() => vpsWorker(smuggled))).toBe(
			"SLOT_BINDING_CREDENTIAL_PROPERTY",
		);
	});
});

describe("factories are deterministic and hand back frozen records", () => {
	it.each(NO_ARG_FACTORIES)("%s is deep-equal across calls", (_name, call) => {
		expect(call()).toEqual(call());
	});

	it("repeats identical output for identical options", () => {
		const options = { template: "ubuntu-24-04", backups: true } as const;
		expect(vps(options)).toEqual(vps(options));
	});

	it.each(NO_ARG_FACTORIES)("%s returns a frozen record", (_name, call) => {
		const binding = call();
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
	});
});
