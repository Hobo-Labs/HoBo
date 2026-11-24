import { describe, expect, it } from "vitest";
import { hostCredentials } from "../src/cd-runtime.js";
import { OwnerCredentialUnavailable } from "../src/owner-store-session.js";

const scope = "test";

async function refusal(ref: string): Promise<OwnerCredentialUnavailable> {
	try {
		await hostCredentials().resolve(ref, scope);
	} catch (error) {
		if (error instanceof OwnerCredentialUnavailable) return error;
		throw error;
	}
	throw new Error(`expected ${ref} to be refused`);
}

describe("the CD host's default credential resolver", () => {
	it("resolves no GitHub job token, even inside a GitHub Actions job", async () => {
		const refused = await refusal("github-job://GITHUB_TOKEN");
		expect(refused.reason).toBe("unsupported-ref");
	});

	it("reads no credential from the process environment", async () => {
		const environment = await refusal(["env:", "/", "/NPM_TOKEN"].join(""));
		expect(environment.reason).toBe("environment-ref");
		expect(environment.message).toContain("owner://<NAME>");
		const owner = await refusal("owner://CLOUDFLARE_API_TOKEN");
		expect(owner.reason).toBe("no-session");
		expect(owner.message).toContain("choose_secret_store");
	});
});
