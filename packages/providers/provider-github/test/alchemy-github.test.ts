import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import {
	assertNoStoredGitHubActionSecrets,
	createAlchemyGitHubAppCredentials,
	declareAlchemyGitHubIntegration,
	declareAlchemyGitHubRelease,
	GitHub,
} from "../src/index.js";

describe("@hobo/provider-github @alchemy.run/github integration", () => {
	it("constructs GitHub App credentials layer and refuses stored secret/variable resources", () => {
		const credentials = createAlchemyGitHubAppCredentials({
			appId: "123456",
			installationId: 789012,
			privateKeyPem: Redacted.make("synthetic-github-app-pem-material"),
		});
		expect(credentials).toBeDefined();
		expect(GitHub.fromApp).toBeTypeOf("function");

		for (const forbidden of [
			"Secret",
			"Secrets",
			"Variable",
			"Variables",
			"PersonalAccessToken",
		]) {
			expect(() => assertNoStoredGitHubActionSecrets(forbidden)).toThrow();
		}
	});

	it("declares GitHub repository, webhook, and release Alchemy resources", () => {
		const integration = declareAlchemyGitHubIntegration({
			owner: "Hobo-Labs",
			repository: "HoBo",
			visibility: "private",
			webhookUrl: "https://relay.example.test/hooks/github",
		});
		expect(integration).toBeDefined();

		const release = declareAlchemyGitHubRelease({
			id: "ReleaseV1",
			owner: "Hobo-Labs",
			repository: "HoBo",
			tagName: "v0.1.0",
			name: "HoBo v0.1.0",
		});
		expect(release).toBeDefined();
	});
});
