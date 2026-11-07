import { describe, expect, it } from "vitest";
import { githubApiUrl } from "../src/github.ts";

describe("githubApiUrl", () => {
	it("allows the poller's recent-completed-runs query", () => {
		expect(
			githubApiUrl(
				"/repos/o/r/actions/runs?status=completed&created=%3E%3D2026-11-02T10:00:00.000Z&per_page=50",
			),
		).toContain("status=completed");
	});
	it("rejects a created filter that is not a lower bound timestamp", () => {
		expect(() =>
			githubApiUrl("/repos/o/r/actions/runs?created=2026-11-02"),
		).toThrow("invalid GitHub API created");
	});
});
