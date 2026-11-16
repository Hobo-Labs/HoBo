import { describe, expect, it } from "vitest";

import { renderSuccess } from "../src/shell/render.js";

// A command that does not succeed shows, in human output, its code and every
// way forward: a refusal that names only its message is a dead end.

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
			// SAFETY: the renderer reads only these output flags.
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
});
