import { describe, expect, it } from "vitest";

import { renderSuccess } from "../src/shell/render.js";

const context = {
	cwd: "/tmp",
	projectDir: null,
	identity: null,
	clients: { readApi: "stub", runtime: "stub" },
} as const;

describe("renderSuccess", () => {
	it("prints a refusal's code and each remediation line", () => {
		const out = renderSuccess({
			verb: "ci",
			flags: { json: false, quiet: false } as Parameters<
				typeof renderSuccess
			>[0]["flags"],
			context,
			result: {
				ok: false,
				status: "needs-connection",
				code: "HOBO_CI_STORE_NEEDS_SIGN_IN",
				message: "The store must open without a page.",
				remediation: ["First path.", "Second path."],
				data: {},
			},
		});
		expect(out.stdout).toContain("HOBO_CI_STORE_NEEDS_SIGN_IN");
		expect(out.stdout).toContain("- First path.\n- Second path.");
	});

	it("prints a refusal's code even when it has no remediation", () => {
		const out = renderSuccess({
			verb: "ci",
			flags: { json: false, quiet: false } as Parameters<
				typeof renderSuccess
			>[0]["flags"],
			context,
			result: {
				ok: false,
				code: "HOBO_CI_REFUSED",
				message: "Cannot continue.",
			},
		});
		expect(out.exitCode).toBe(1);
		expect(out.stdout).toContain("HOBO_CI_REFUSED");
	});
});
