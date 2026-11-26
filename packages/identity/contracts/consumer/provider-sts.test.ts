import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createInMemoryProviderStsExchange,
	mintOidcFederationAssertion,
	type TokenScope,
} from "../../src/index.js";

// Consumer contract for the ProviderSTS boundary (ai-native-agent-auth.md §6.2:
// "token exchange (AssumeRoleWithWebIdentity / WIF / federated cred)"). The
// pact was lifted from the identity-auth XAA epic proof; the in-memory STS is the
// consumer honouring the recorded exchange shape (a narrowed, resource-scoped
// provider token reference), with no real cloud STS.

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(join(packageRoot, "../pacts/provider-sts.pact.json"), "utf8"),
);

const NOW = "2026-06-25T15:00:00.000Z";

describe("ProviderSTS token-exchange boundary (consumer contract)", () => {
	it("names the identity reference consumer and the ProviderSTS provider", () => {
		expect(pact.consumer.name).toBe("IdentityReferenceApp");
		expect(pact.provider.name).toBe("ProviderSTS");
	});

	it("exchanges an SVID-bound OIDC assertion for the narrowed provider token the pact records", () => {
		const interaction = pact.interactions[0];
		// SAFETY: assertion to `nteraction.request.body as { audience: string; subject: string; scope: TokenScope; };` is required at this boundary.
		const request = interaction.request.body as {
			audience: string;
			subject: string;
			scope: TokenScope;
		};
		// SAFETY: assertion to `nteraction.response.body as { tokenRef: string; expiresInSeconds: number; narrowed: boolean; };` is required at this boundary.
		const expected = interaction.response.body as {
			tokenRef: string;
			expiresInSeconds: number;
			narrowed: boolean;
		};

		const sts = createInMemoryProviderStsExchange({
			provider: request.audience,
			audience: request.audience,
			ttlSeconds: expected.expiresInSeconds,
		});
		const assertion = mintOidcFederationAssertion({
			issuer: "https://identity.yard.example",
			subject: request.subject,
			audience: request.audience,
			scope: request.scope,
			now: NOW,
		});
		const result = sts.exchange({
			oidcToken: assertion.token,
			audience: request.audience,
			subject: request.subject,
			scope: request.scope,
			now: NOW,
		});

		expect(result.status).toBe("exchanged");
		if (result.status !== "exchanged") return;
		expect(result.credential.tokenRef).toBe(expected.tokenRef);
		expect(result.credential.expiresInSeconds).toBe(expected.expiresInSeconds);
		expect(result.credential.narrowed).toBe(expected.narrowed);
		expect(result.credential.flow).toBe("oidc-federation");
	});
});
