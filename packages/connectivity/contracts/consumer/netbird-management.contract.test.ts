import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseTenantId } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { createNetbirdOverlay } from "../../src/overlay/netbird.js";
import { createNetbirdApiClient } from "../../src/overlay/netbird-api.js";
import { createPactFetch, requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("NetbirdManagementApi consumer contract", () => {
	it("enroll, peers, DNS, and overlay join via pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = requirePact(pacts, "NetbirdManagementApi");
		const fetchImpl = createPactFetch(pact);

		const api = createNetbirdApiClient({
			managementUrl: "https://nb.example.com",
			accessToken: "token",
			setupKey: "setup-key",
			fetchImpl,
		});
		const enrolled = await api.enrollPeer({ name: "j1" });
		expect(enrolled.enrolled).toBe(true);
		expect(enrolled.peer?.ip).toBe("100.64.0.5");

		const peers = await api.listPeers();
		expect(peers[0]?.dnsLabel).toBe("j1.nb.local");

		const group = await api.upsertDnsNameserverGroup({
			name: "hobo-acme",
			nameservers: [{ ip: "100.100.100.100" }],
			domains: ["hobo.test"],
			enabled: true,
		});
		expect(group.domains).toContain("hobo.test");

		const overlay = createNetbirdOverlay({ api });
		const join = await overlay.join({
			tenantId: parseTenantId("acme"),
			hostname: "j1",
			tags: ["tenant:acme", "role:junction"],
		});
		expect(join.ready).toBe(true);

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
	});
});
