import { expect, it } from "vitest";
import { createAppRegistration } from "../src/app-registration.js";
import {
	createAppRegistrationHandler,
	createGithubInstallationAdminVerifier,
} from "../src/app-registration-http.js";

const actor = { accountId: "alice", subject: "u1" };
function fixture() {
	const states = new Set<string>();
	let signedIn = true;
	let admin = true;
	const bindings: string[] = [];
	const app = createAppRegistration({
		appId: 42,
		states: {
			async issue(id) {
				states.add(id);
			},
			async consume(id) {
				return states.delete(id);
			},
		},
		authority: {
			async authorize() {
				return true;
			},
			async verifyInstallationAdmin() {
				return admin;
			},
		},
		vault: {
			async saveApp() {},
			async bindInstallation(_app, _id, account) {
				bindings.push(account);
			},
		},
		github: {
			async appRequest() {
				return Response.json({ id: 88, app_id: 42, suspended_at: null });
			},
			async request() {
				throw new Error("unexpected");
			},
		},
	});
	const handler = createAppRegistrationHandler({
		registration: app,
		async authenticate() {
			return signedIn ? actor : undefined;
		},
	});
	return {
		handler,
		bindings,
		deny: () => {
			signedIn = false;
		},
		denyAdmin: () => {
			admin = false;
		},
	};
}
it("authenticates and issues one-time state before binding a verified installation", async () => {
	const f = fixture();
	const issued = await f.handler(
		new Request("https://ci.test/v1/app-registration/state", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"purpose":"install"}',
		}),
	);
	if (!issued) throw new Error("missing response");
	expect(issued.status).toBe(200);
	const state = (await issued.json()).state;
	const url = `https://ci.test/v1/app-registration/install-callback?state=${state}&installation_id=88&setup_action=install`;
	expect((await f.handler(new Request(url)))?.status).toBe(200);
	expect(f.bindings).toEqual(["alice"]);
	expect((await f.handler(new Request(url)))?.status).toBe(403);
});
it("rejects unauthenticated callbacks, duplicate query parameters and oversized state bodies", async () => {
	const f = fixture();
	f.deny();
	expect(
		(
			await f.handler(
				new Request("https://ci.test/v1/app-registration/install-callback"),
			)
		)?.status,
	).toBe(401);
	const g = fixture();
	expect(
		(
			await g.handler(
				new Request(
					"https://ci.test/v1/app-registration/install-callback?state=a&state=b&installation_id=88&setup_action=install",
				),
			)
		)?.status,
	).toBe(400);
	expect(
		(
			await g.handler(
				new Request("https://ci.test/v1/app-registration/state", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "a".repeat(4097),
				}),
			)
		)?.status,
	).toBe(413);
	expect(g.bindings).toEqual([]);
});
it("checks a GitHub OAuth user against the installation owner or active organization admin", async () => {
	let kind = "User",
		role = "admin",
		userId = 7;
	let token: string | undefined = "oauth-secret";
	const sent: string[] = [];
	const verify = createGithubInstallationAdminVerifier({
		github: {
			async appRequest() {
				return Response.json({
					account: { id: 7, login: "test-org", type: kind },
				});
			},
			async request() {
				throw new Error("unexpected");
			},
		},
		async getUserToken() {
			return token;
		},
		fetch: async (url, init) => {
			sent.push(String(url));
			expect(init?.redirect).toBe("error");
			if (String(url).endsWith("/user")) return Response.json({ id: userId });
			return Response.json({ role, state: "active" });
		},
	});
	expect(await verify(actor, 88)).toBe(true);
	userId = 8;
	expect(await verify(actor, 88)).toBe(false);
	kind = "Organization";
	expect(await verify(actor, 88)).toBe(true);
	role = "member";
	expect(await verify(actor, 88)).toBe(false);
	token = undefined;
	const before = sent.length;
	expect(await verify(actor, 88)).toBe(false);
	expect(sent).toHaveLength(before);
});
