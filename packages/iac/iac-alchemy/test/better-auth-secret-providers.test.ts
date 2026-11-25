import { describe, expect, it } from "vitest";

import {
	BETTER_AUTH_HOST_DOTENV_FIXTURE,
	parseBetterAuthHostDotEnv,
} from "./better-auth-host-harness.js";
import {
	mergeBetterAuthConstructionDotEnv,
	resolveBetterAuthSecretProviderStack,
} from "./better-auth-secret-providers.js";

describe("better-auth host secret providers", () => {
	it("uses dotenv only for local stages and dotenv+infisical for ci stages", () => {
		expect(resolveBetterAuthSecretProviderStack({ stage: "dev" })).toEqual(["dotenv"]);
		expect(resolveBetterAuthSecretProviderStack({ stage: "ci-pr-3014" })).toEqual([
			"dotenv",
			"infisical",
		]);
	});

	it("merges dotenv layers with later overrides for construction-time auth keys", () => {
		const merged = mergeBetterAuthConstructionDotEnv(BETTER_AUTH_HOST_DOTENV_FIXTURE, {
			HOBO_AUTH_BASE_PATH: "/api/v2/auth",
		});
		const inputs = parseBetterAuthHostDotEnv(merged);
		expect(inputs.configInput.basePath).toBe("/api/v2/auth");
	});
});