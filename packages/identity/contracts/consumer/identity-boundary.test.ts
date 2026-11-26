import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { IdentityService } from "../../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/identity-boundary.pact.json"),
		"utf8",
	),
);

const ISSUER_URL = "https://identity.yard.example";

describe("Identity service boundary consumer contract", () => {
	it("names the gateway consumer and identity provider", () => {
		expect(pact.consumer.name).toBe("@hobo/gateway");
		expect(pact.provider.name).toBe("IdentityServiceBoundary");
	});

	it("the provider's contract evidence satisfies the recorded boundary interaction", () => {
		const service = new IdentityService({
			issuerUrl: ISSUER_URL,
			genesisKeyId: "yard-genesis-2026-07",
		});
		expect(pact.interactions[0]?.response.body).toEqual(
			service.contractEvidence(),
		);
	});
});
