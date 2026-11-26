import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createCloudflareDnsProvider } from "../../src/dns/cloudflare-provider.js";
import { createPactFetch, requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("CloudflareDnsApi consumer contract", () => {
	it("createCloudflareDnsProvider upserts via pact mock fetch", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = requirePact(pacts, "CloudflareDnsApi");
		const fetchImpl = createPactFetch(pact);

		const provider = createCloudflareDnsProvider({
			apiToken: "test-token",
			zoneId: "zone-1",
			apiBase: "https://api.cloudflare.com/v4",
			fetchImpl,
		});

		await provider.upsert(parseTenantId("acme"), "example.com", {
			name: "web.myapp.hobo.example.com",
			type: "CNAME",
			content: "funnel.ts.net",
			gatewayTarget: true,
			ttl: 300,
		});

		const listed = await provider.list(parseTenantId("acme"), "example.com");
		expect(listed.some((r) => r.type === "CNAME")).toBe(true);
	});
});
