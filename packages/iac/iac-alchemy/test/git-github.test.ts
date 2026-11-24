import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import {
	assertAllowedGitHubResourceKind,
	createHoboGitHubAppCredentialsLayer,
	declareHoboGitHubRepositoryStack,
	describeAlchemyGitHostSpec,
	Git,
} from "../src/git/index.js";

describe("@hobo/iac-alchemy/git (@alchemy.run/git and @alchemy.run/github)", () => {
	it("builds self-hosted @alchemy.run/git host specifications and rejects reserved owners", () => {
		const spec = describeAlchemyGitHostSpec({
			hostName: "hobo-git-core",
			stage: "prod",
			owner: "hobo-labs",
			blobStorage: "r2",
			registry: "durable-object",
		});
		expect(spec.blobStorage).toBe("r2");
		expect(spec.defaultBranch).toBe("main");
		expect(spec.protectedBranches).toEqual(["main"]);
		expect(spec.zeroOid).toBe(Git.ZERO_OID);
		expect(spec.maxPackBytes).toBe(Git.MAX_PACK_BYTES);

		expect(() =>
			describeAlchemyGitHostSpec({
				hostName: "hobo-git-core",
				stage: "prod",
				owner: "api",
				blobStorage: "s3",
			}),
		).toThrow();
	});

	it("authenticates @alchemy.run/github exclusively via GitHub App owner:// credentials and refuses secret/variable resources", async () => {
		const credentialsLayer = await Effect.runPromise(
			createHoboGitHubAppCredentialsLayer({
				appId: "998877",
				installationId: 445566,
				privateKeyLocator: "owner://HOBO_GITHUB_APP_PRIVATE_KEY",
				resolveCredential: async (locator) => {
					if (locator === "owner://HOBO_GITHUB_APP_PRIVATE_KEY") {
						return "synthetic-app-key-pem-material";
					}
					throw new Error(`unexpected locator ${locator}`);
				},
			}),
		);
		expect(credentialsLayer).toBeDefined();

		for (const forbidden of [
			"Secret",
			"Secrets",
			"Variable",
			"Variables",
			"PersonalAccessToken",
		]) {
			expect(() => assertAllowedGitHubResourceKind(forbidden)).toThrow();
		}

		const stackProgram = declareHoboGitHubRepositoryStack({
			repositoryId: "HoboRepo",
			owner: "Hobo-Labs",
			name: "HoBo",
			visibility: "private",
			defaultBranch: "main",
			webhookId: "HoboCiHook",
			webhookUrl: "https://relay.example.test/webhook",
			webhookSigningSecret: Redacted.make("synthetic-webhook-hmac-key"),
			branchProtectionId: "MainProtection",
			protectedBranchPattern: "main",
		});
		expect(stackProgram).toBeDefined();
	});
});
