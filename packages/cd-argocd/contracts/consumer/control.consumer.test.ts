import type { CdContext, CredentialResolver } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import { createArgoCdControlClient } from "../../src/client.js";
import { loadPact, pactTransport } from "./pact-transport.js";

const REV = "9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5";

const ctx: CdContext = {
	tenant: "acme",
	principal: { kind: "service", id: "cd" },
	now: () => Date.parse("2026-11-12T12:00:00.000Z"),
};

const credentials: CredentialResolver = {
	async resolve() {
		return { token: "synthetic-token" };
	},
};

const config = {
	apiBaseUrl: "https://argo.example",
	application: "hobo-prod",
	appNamespace: "argocd",
	tokenRef: "owner://SYNTHETIC_ARGO_TOKEN",
};

describe("Argo CD control boundary (consumer side of the pact)", () => {
	const pact = loadPact("cd_argocd_control");

	for (const interaction of pact.interactions) {
		it(`${interaction.description}`, async () => {
			const http = pactTransport([interaction]);
			const client = createArgoCdControlClient(config, http, credentials);
			if (interaction.request.method === "GET") {
				const verdict = await client.observeSync(
					{
						name: config.application,
						namespace: config.appNamespace,
						revision: REV,
					},
					ctx,
				);
				if (interaction.providerState === "converged")
					expect(verdict.state).toBe("converged");
			} else {
				const synced = await client.requestSync(
					{
						name: config.application,
						namespace: config.appNamespace,
						revision: REV,
						manual: true,
					},
					ctx,
				);
				expect(synced.ok).toBe(true);
			}
			expect(http.served()).toBe(1);
		});
	}
});
