import { describe, expect, it } from "vitest";
import { GITHUB_JOB_TOKEN_REF, hostCredentials } from "../src/cd-runtime.js";
import { OwnerCredentialUnavailable } from "../src/owner-store-session.js";

const scope = "test";

async function refusal(
	env: Readonly<Record<string, string | undefined>>,
	ref: string,
): Promise<OwnerCredentialUnavailable> {
	try {
		await hostCredentials(env).resolve(ref, scope);
	} catch (error) {
		if (error instanceof OwnerCredentialUnavailable) return error;
		throw error;
	}
	throw new Error(`expected ${ref} to be refused`);
}

describe("the CD host's default credential resolver", () => {
	it("resolves a GitHub Actions job's own token only inside that job", async () => {
		await expect(
			hostCredentials({
				GITHUB_ACTIONS: "true",
				GITHUB_TOKEN: "per-job-token",
			}).resolve(GITHUB_JOB_TOKEN_REF, scope),
		).resolves.toEqual({ token: "per-job-token" });
		const outside = await refusal(
			{ GITHUB_TOKEN: "a-stored-token" },
			GITHUB_JOB_TOKEN_REF,
		);
		expect(outside.reason).toBe("unsupported-ref");
	});

	it("reads no other credential from the process environment", async () => {
		const env = {
			GITHUB_ACTIONS: "true",
			NPM_TOKEN: "npm-from-environment",
			CLOUDFLARE_API_TOKEN: "cloudflare-from-environment",
		};
		const environment = await refusal(
			env,
			["env:", "/", "/NPM_TOKEN"].join(""),
		);
		expect(environment.reason).toBe("environment-ref");
		expect(environment.message).toContain("owner://<NAME>");
		const owner = await refusal(env, "owner://CLOUDFLARE_API_TOKEN");
		expect(owner.reason).toBe("no-session");
		expect(owner.message).toContain("choose_secret_store");
		expect(owner.message).not.toContain("cloudflare-from-environment");
	});
});
