import { describe, expect, it } from "vitest";
import { resolveGitleaksGateScan } from "../ci/gitleaks-main-gate.mts";

describe("resolveGitleaksGateScan", () => {
	it("scopes main pushes to before..HEAD", () => {
		expect(
			resolveGitleaksGateScan("push", "abc123", (ref) => ref === "abc123"),
		).toEqual({ kind: "git", logOpts: "abc123..HEAD" });
	});

	it("falls back to detect when push before is the empty SHA", () => {
		expect(
			resolveGitleaksGateScan(
				"push",
				"0000000000000000000000000000000000000000",
				() => true,
			).kind,
		).toBe("detect");
	});

	it("falls back to detect when push before is not in the clone", () => {
		expect(resolveGitleaksGateScan("push", "missing", () => false).kind).toBe(
			"detect",
		);
	});

	it("scopes schedule to the last seven days", () => {
		expect(resolveGitleaksGateScan("schedule", undefined, () => false)).toEqual(
			{ kind: "git", logOpts: "--since=7.days" },
		);
	});
});
