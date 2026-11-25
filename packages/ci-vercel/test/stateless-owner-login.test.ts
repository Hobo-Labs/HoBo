import { describe, expect, it } from "vitest";
import { z } from "zod";
import { relayOwnerAccount } from "../src/stateless-composition.js";
import { ORIGIN, openStatelessRelay } from "./stateless-harness.js";

const Sealed = z.object({ device_code: z.string() });
const Session = z.object({ session_token: z.string() });
const Credential = z.object({ token: z.string(), expires_in: z.number() });

async function post(
	relay: Awaited<ReturnType<typeof openStatelessRelay>>["relay"],
	path: string,
	body: Readonly<Record<string, string>>,
	authorization?: string,
) {
	return relay.handle(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(authorization !== undefined ? { authorization } : undefined),
			},
			body: JSON.stringify(body),
		}),
	);
}

describe("the stateless relay's owner sign-in", () => {
	it("signs the owner in and serves the account API to the 15-minute account credential", async () => {
		const h = await openStatelessRelay({
			githubFor: async (request) => {
				const url = new URL(request.url);
				if (url.href === "https://github.com/login/device/code")
					return Response.json({
						device_code: "github-device-code",
						user_code: "ABCD-EFGH",
						verification_uri: "https://github.com/login/device",
						expires_in: 900,
						interval: 5,
					});
				if (url.href === "https://github.com/login/oauth/access_token")
					return Response.json({
						access_token: "ghu_owner",
						token_type: "bearer",
					});
				if (url.href === "https://api.github.com/user")
					return Response.json({ id: 42 });
				if (url.pathname === "/app/installations/10")
					return Response.json({
						account: { id: 42, login: "owner", type: "User" },
					});
				if (url.pathname.startsWith("/applications/"))
					return new Response(null, { status: 204 });
				return undefined;
			},
		});
		const device = Sealed.parse(
			await (await post(h.relay, "/v1/owner-login/device", {})).json(),
		);
		const session = Session.parse(
			await (
				await post(h.relay, "/v1/owner-login/token", {
					device_code: device.device_code,
				})
			).json(),
		);
		const credential = Credential.parse(
			await (
				await post(
					h.relay,
					"/v1/owner-login/credentials",
					{ ref: "owner://HOBO_CI_ACCOUNT_TOKEN", scope: "hobo ci status" },
					`Bearer ${session.session_token}`,
				)
			).json(),
		);
		expect(credential.expires_in).toBe(900);
		const policy = (authorization: string) =>
			h.relay.handle(
				new Request(`${ORIGIN}/v1/accounts/self/policy`, {
					headers: { authorization },
				}),
			);
		expect((await policy(`Bearer ${credential.token}`)).status).toBe(200);
		expect((await policy(`Bearer ${session.session_token}`)).status).toBe(401);
		h.clock.advance(900_000);
		expect((await policy(`Bearer ${credential.token}`)).status).toBe(401);
		const unknown = await post(h.relay, "/v1/owner-login/other", {});
		expect(unknown.status).toBe(404);
		await h.relay.close();
	});

	it("binds the bootstrap account's installations and scopes, and nothing for another account", () => {
		const tokens = JSON.stringify({
			tokens: [
				{
					accountId: "hobo-labs",
					installationIds: [10],
					tokenSha256: "a".repeat(64),
					scopes: ["policy:read"],
				},
				{
					accountId: "hobo-labs",
					installationIds: [10, 12],
					tokenSha256: "b".repeat(64),
					scopes: ["repositories:write"],
				},
				{
					accountId: "someone-else",
					installationIds: [20],
					tokenSha256: "c".repeat(64),
					scopes: ["policy:write"],
				},
			],
		});
		expect(relayOwnerAccount(tokens, "hobo-labs")).toEqual({
			accountId: "hobo-labs",
			installationIds: [10, 12],
			scopes: ["policy:read", "repositories:write"],
		});
		expect(relayOwnerAccount(tokens, "nobody")).toBeUndefined();
	});
});
