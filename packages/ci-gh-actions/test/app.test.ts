import { assertNoBindleProviderSelection } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { ciGithubAppBindle } from "../src/app.js";

describe("@hobo/ci-gh-actions app bindle", () => {
	it("declares the GitHub App API bindle inside @hobo/ci-gh-actions without provider selection", () => {
		expect(() =>
			assertNoBindleProviderSelection(ciGithubAppBindle),
		).not.toThrow();
		expect(ciGithubAppBindle.name).toBe("hobo-ci-github-app");
		expect(ciGithubAppBindle.resources.app?.kind).toBe("api");
	});
});
