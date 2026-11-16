import { createTrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	checkedBy,
	openSecretStore,
	parseAppHandOffMode,
	parseHttpsOrigin,
	parseOnePasswordVaultId,
	parseProxyUrl,
	parsePublicOrigin,
	SettingParseError,
} from "../src/index.js";

// Parse, don't validate: each outside value becomes its branded type where it
// enters, or is refused there by name. Nothing past the parser can hold an
// invalid one.

describe("parsed settings", () => {
	it("keeps only an https origin, normalized", () => {
		expect(parseHttpsOrigin("X", "https://Connect.Example:8443/")).toBe(
			"https://connect.example:8443",
		);
		for (const bad of [
			"http://connect.example",
			"https://connect.example/v1",
			"https://u:p@connect.example",
			"connect.example",
		])
			expect(() => parseHttpsOrigin("OP_CONNECT_HOST", bad)).toThrow(
				SettingParseError,
			);
	});

	it("keeps only public origins for a tunnel", () => {
		expect(parsePublicOrigin("X", "https://abc.trycloudflare.com")).toBe(
			"https://abc.trycloudflare.com",
		);
		for (const bad of [
			"https://127.0.0.1",
			"https://10.1.2.3",
			"https://localhost",
		])
			expect(() => parsePublicOrigin("X", bad)).toThrow(SettingParseError);
	});

	it("keeps only a 1Password vault id's shape, and names the setting when refusing", () => {
		expect(
			parseOnePasswordVaultId("OP_VAULT_ID", "k2l3m4n5o6p7q8r9s0t1u2v3w4"),
		).toBe("k2l3m4n5o6p7q8r9s0t1u2v3w4");
		expect(() => parseOnePasswordVaultId("OP_VAULT_ID", "vault-1")).toThrow(
			/OP_VAULT_ID is not valid/u,
		);
	});

	it("parses the proxy and the hand-off mode, refusing anything else", () => {
		expect(parseProxyUrl("HTTPS_PROXY", "http://127.0.0.1:3128")).toBe(
			"http://127.0.0.1:3128",
		);
		expect(() => parseProxyUrl("HTTPS_PROXY", "socks://x")).toThrow(
			SettingParseError,
		);
		expect(parseAppHandOffMode("HOBO_APP_HANDOFF", undefined)).toBe("paste");
		expect(parseAppHandOffMode("HOBO_APP_HANDOFF", "store")).toBe("store");
		expect(() => parseAppHandOffMode("HOBO_APP_HANDOFF", "relay")).toThrow(
			SettingParseError,
		);
	});

	it("derives the setup page's check from the parser: one rule, one place", () => {
		const check = checkedBy(parseOnePasswordVaultId, "OP_VAULT_ID");
		expect(check("k2l3m4n5o6p7q8r9s0t1u2v3w4")).toBeUndefined();
		expect(check("vault-1")).toMatch(/26 lowercase letters and digits/u);
	});

	it("refuses a malformed 1Password vault id where the store opens, by name, not as a sign-in failure", async () => {
		const opening = await openSecretStore(
			"1password",
			{
				OP_VAULT_ID: "vault-1",
				OP_CONNECT_HOST: "https://connect.owner.example",
			},
			createTrustedVault(),
		);
		expect(opening).toMatchObject({ ok: false });
		expect(opening.ok ? "" : opening.message).toMatch(
			/OP_VAULT_ID is not valid/u,
		);
	});
});
