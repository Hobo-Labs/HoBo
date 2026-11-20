import { describe, expect, it } from "vitest";
import { DirectiveSchema } from "../src/client/directive-schema.js";

describe("DirectiveSchema directive url allowlist", () => {
	it("accepts absolute http(s) navigate and post directives", () => {
		expect(
			DirectiveSchema.parse({
				kind: "navigate",
				url: "https://vercel.com/a/install/new",
			}),
		).toEqual({ kind: "navigate", url: "https://vercel.com/a/install/new" });
		expect(
			DirectiveSchema.parse({
				kind: "post",
				url: "http://127.0.0.1:9411/github/settings/apps/new?state=s",
				fields: { manifest: "{}" },
			}),
		).toEqual({
			kind: "post",
			url: "http://127.0.0.1:9411/github/settings/apps/new?state=s",
			fields: { manifest: "{}" },
		});
	});

	it.each(
		[
			"javascript:alert(1)",
			"jAvasCrIpT:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox",
			"file:///etc/passwd",
			"ftp://example.com/pub",
			"//example.com/handoff",
			"/connect/handoff",
			"",
		].map((url) => [url] as const),
	)("rejects model-composed directive url %j", (url) => {
		expect(DirectiveSchema.safeParse({ kind: "navigate", url }).success).toBe(
			false,
		);
		expect(
			DirectiveSchema.safeParse({
				kind: "post",
				url,
				fields: { manifest: "{}" },
			}).success,
		).toBe(false);
	});
});
