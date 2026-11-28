import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createAppRegistration } from "../src/app-registration.js";

it("executes manifest conversion and app installation identity contract through shipped callbacks", async () => {
	// SAFETY: hand-authored Pact is test input; runtime parses the provider responses.
	const pact = JSON.parse(
		readFileSync(
			new URL("./app-registration-boundary.pact.json", import.meta.url),
			"utf8",
		),
	) as {
		interactions: {
			request: { method: string; path: string };
			response: { status: number; body: object };
		}[];
	};
	expect(pact.interactions).toHaveLength(2);
	const pending = new Set<string>();
	const matched: string[] = [];
	const actor = { accountId: "example", subject: "user" };
	const registration = createAppRegistration({
		appId: 42,
		states: {
			async issue(digest) {
				pending.add(digest);
			},
			async consume(digest) {
				return pending.delete(digest);
			},
		},
		authority: {
			async authorize() {
				return true;
			},
			async verifyInstallationAdmin() {
				return true;
			},
		},
		vault: { async saveApp() {}, async bindInstallation() {} },
		fetch: async (url, options) => {
			const entry = pact.interactions[0];
			if (!entry) throw new Error("missing interaction");
			expect(new URL(String(url)).pathname).toBe(entry.request.path);
			expect(options?.method).toBe(entry.request.method);
			matched.push(entry.request.path);
			return Response.json(entry.response.body, {
				status: entry.response.status,
			});
		},
		github: {
			async appRequest(path) {
				const entry = pact.interactions[1];
				if (!entry) throw new Error("missing interaction");
				expect(path).toBe(entry.request.path);
				expect(entry.request.method).toBe("GET");
				matched.push(path);
				return Response.json(entry.response.body, {
					status: entry.response.status,
				});
			},
			async request() {
				throw new Error("unmatched interaction");
			},
		},
	});
	await registration.completeRegistration(
		actor,
		await registration.begin(actor, "register"),
		"test-code",
	);
	await registration.completeInstallation(
		actor,
		await registration.begin(actor, "install"),
		88,
	);
	expect(matched).toEqual(pact.interactions.map((entry) => entry.request.path));
});
