import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseTenantId } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { createTailscaleOverlay } from "../../src/overlay/tailscale.js";
import { createTailscaleApiClient } from "../../src/overlay/tailscale-api.js";
import { createPactFetch, requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("TailscaleControlApi consumer contract", () => {
	it("API client and overlay MagicDNS use pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = requirePact(pacts, "TailscaleControlApi");
		const fetchImpl = createPactFetch(pact);

		const api = createTailscaleApiClient({
			apiKey: "tskey-api-pact",
			tailnet: "example.com",
			apiBase: "https://api.tailscale.com/api/v2",
			fetchImpl,
		});
		const prefs = await api.setDnsPreferences({ magicDNS: true });
		expect(prefs.magicDNS).toBe(true);
		const map = await api.putSplitDns(["hobo.test"], ["100.100.100.100"]);
		expect(map["hobo.test"]).toContain("100.100.100.100");
		const devices = await api.listDevices();
		expect(devices[0]?.id).toBe("n1");

		const overlay = createTailscaleOverlay({
			apiKey: "tskey-api-pact",
			tailnet: "example.com",
			apiBase: "https://api.tailscale.com/api/v2",
			fetchImpl,
			run: (args) => {
				if (args[0] === "set") return { ok: true, stdout: "", stderr: "" };
				return { ok: false, stdout: "", stderr: "no" };
			},
		});
		const configureMagicDns = must(
			overlay.configureMagicDns,
			"overlay.configureMagicDns",
		);
		const magic = await configureMagicDns({
			tenantId: parseTenantId("acme"),
			domains: ["hobo.test"],
			nameservers: ["100.100.100.100"],
		});
		expect(magic.applied).toBe(true);
		expect(magic.notes.join(" ")).toMatch(/controlPlaneApplied=true/);
	});
});
