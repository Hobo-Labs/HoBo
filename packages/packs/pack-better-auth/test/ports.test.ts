import { describe, expect, it } from "vitest";

import {
	BetterAuthConfigError,
	parseBetterAuthSecretRef,
} from "@hobo/auth-adapter-contract";
import { BetterAuthBundlePlanError } from "../src/errors.js";
import { parseBetterAuthBundlePortRefs } from "../src/ports.js";

describe("parseBetterAuthBundlePortRefs", () => {
	it("rejects signingSecretRef locators that embed userinfo credentials", () => {
		const syntheticPassword = `pw-${crypto.randomUUID().replaceAll("-", "")}`;
		const locator = `hobo-secret://operator%3A${syntheticPassword}@camp/auth/signing-key`;
		expect(() =>
			parseBetterAuthBundlePortRefs({
				relationalBindle: "auth_db",
				httpBindle: "auth_api",
				signingSecretRef: locator,
			}),
		).toThrow(BetterAuthConfigError);
		expect(() => parseBetterAuthSecretRef(locator)).toThrow(
			BetterAuthConfigError,
		);
	});

	it("accepts underscore bindle names and trims whitespace", () => {
		const refs = parseBetterAuthBundlePortRefs({
			relationalBindle: "  auth_db ",
			httpBindle: "auth_api",
			signingSecretRef: "hobo-secret://camp-prod/auth/signing-key",
		});
		expect(refs.relationalBindle).toBe("auth_db");
	});

	it("refuses bindle names outside the DNS label grammar", () => {
		expect(() =>
			parseBetterAuthBundlePortRefs({
				relationalBindle: "Auth_DB",
				httpBindle: "auth_api",
				signingSecretRef: "hobo-secret://camp-prod/auth/signing-key",
			}),
		).toThrow(BetterAuthBundlePlanError);
	});
});
