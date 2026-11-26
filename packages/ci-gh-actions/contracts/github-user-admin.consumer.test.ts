import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createGithubInstallationAdminVerifier } from "../src/app-registration-http.js";

it("verifies an installation owner using both declared GitHub user API interactions", async () => {
	// SAFETY: test-only hand-authored Pact; response bodies are parsed by the verifier.
	const pact = JSON.parse(
		readFileSync(
			new URL("./github-user-admin.pact.json", import.meta.url),
			"utf8",
		),
	) as {
		interactions: {
			request: { method: string; path: string };
			response: { status: number; body: object };
		}[];
	};
	expect(pact.interactions).toHaveLength(2);
	const matched: string[] = [];
	const verifier = createGithubInstallationAdminVerifier({
		github: {
			async appRequest(path) {
				expect(path).toBe("/app/installations/88");
				return Response.json({
					account: { id: 12, login: "test-org", type: "Organization" },
				});
			},
			async request() {
				throw new Error("unmatched App request");
			},
		},
		async getUserToken() {
			return "test-user-token";
		},
		fetch: async (url, init) => {
			const entry = pact.interactions[matched.length];
			if (!entry) throw new Error("unmatched user request");
			expect(new URL(String(url)).pathname).toBe(entry.request.path);
			expect(init?.method ?? "GET").toBe(entry.request.method);
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer test-user-token",
			);
			expect(init?.redirect).toBe("error");
			matched.push(entry.request.path);
			return Response.json(entry.response.body, {
				status: entry.response.status,
			});
		},
	});
	expect(
		await verifier({ accountId: "account", subject: "github-user" }, 88),
	).toBe(true);
	expect(matched).toEqual(pact.interactions.map((entry) => entry.request.path));
});
