import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createRelayOwnerLogin,
	RELAY_OWNER_CREDENTIALS_PATH,
	RELAY_OWNER_DEVICE_PATH,
	RELAY_OWNER_SESSION_SECONDS,
	RELAY_OWNER_TOKEN_PATH,
	type RelayOwnerAccount,
} from "../src/index.js";

const ORIGIN = "https://relay.example";
const USER_TOKEN = "ghu_owner_user_token_never_leaves_the_relay";
const INSTALLATION_TOKEN = "ghs_installation_token_for_org_repo";
const GITHUB_DEVICE_CODE = "github-device-code-kept-sealed";

const account: RelayOwnerAccount = {
	accountId: "hobo-labs",
	installationIds: [10],
	scopes: ["policy:read", "repositories:write"],
};

type Owner = "user" | "org-admin" | "org-member" | "stranger";

function stand(
	options: {
		owner?: Owner;
		answers?: readonly Readonly<Record<string, string | number>>[];
		deviceFlow?: boolean;
		account?: RelayOwnerAccount | undefined;
	} = {},
) {
	let now = 1_800_000_000_000;
	const answers = [
		...(options.answers ?? [{ error: "authorization_pending" }]),
	];
	const calls: string[] = [];
	const bodies: string[] = [];
	const installationAccount =
		options.owner === "org-admin" || options.owner === "org-member"
			? { id: 77, login: "Org", type: "Organization" }
			: { id: 42, login: "owner", type: "User" };
	const fetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
		bodies.push(String(init?.body ?? ""));
		if (url.href === "https://github.com/login/device/code")
			return options.deviceFlow === false
				? Response.json({ error: "device_flow_disabled" }, { status: 400 })
				: Response.json({
						device_code: GITHUB_DEVICE_CODE,
						user_code: "ABCD-EFGH",
						verification_uri: "https://github.com/login/device",
						expires_in: 900,
						interval: 5,
					});
		if (url.href === "https://github.com/login/oauth/access_token")
			return Response.json(answers.shift() ?? { error: "expired_token" });
		if (url.href === "https://api.github.com/user")
			return Response.json({
				id: options.owner === "stranger" ? 99 : 42,
			});
		if (url.href === "https://api.github.com/user/memberships/orgs/Org")
			return Response.json({
				role: options.owner === "org-admin" ? "admin" : "member",
				state: "active",
			});
		if (url.pathname === "/applications/Iv1.relay/token")
			return new Response(null, { status: 204 });
		return new Response(null, { status: 404 });
	};
	const login = createRelayOwnerLogin({
		publicOrigin: ORIGIN,
		clientId: "Iv1.relay",
		clientSecret: "client-secret",
		sealingKey: randomBytes(32),
		github: {
			request: async () => new Response(null, { status: 404 }),
			appRequest: async (path) => {
				if (path === "/app/installations/10")
					return Response.json({ account: installationAccount });
				if (path === "/repos/Org/Repo/installation")
					return Response.json({ id: 10 });
				if (path === "/repos/Other/Repo/installation")
					return Response.json({ id: 11 });
				return new Response(null, { status: 404 });
			},
		},
		installationToken: async (id) =>
			id === 10 ? INSTALLATION_TOKEN : Promise.reject(new Error("no")),
		account: async () => ("account" in options ? options.account : account),
		fetch,
		now: () => now,
	});
	const post = async (
		path: string,
		body: Readonly<Record<string, string>>,
		authorization?: string,
	) => {
		const response = await login.handle(
			new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(authorization !== undefined ? { authorization } : undefined),
				},
				body: JSON.stringify(body),
			}),
		);
		if (response === undefined) throw new Error(`${path} not routed`);
		const text = await response.text();
		return {
			status: response.status,
			text,
			json: z.json().parse(JSON.parse(text)),
		};
	};
	return {
		login,
		calls,
		bodies,
		post,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const Device = z.object({
	device_code: z.string(),
	user_code: z.string(),
	verification_uri: z.string(),
	expires_in: z.number(),
	interval: z.number(),
});
const Session = z.object({ session_token: z.string(), expires_in: z.number() });
const Credential = z.object({ token: z.string(), expires_in: z.number() });

async function signIn(relay: ReturnType<typeof stand>) {
	const device = Device.parse(
		(await relay.post(RELAY_OWNER_DEVICE_PATH, {})).json,
	);
	const token = await relay.post(RELAY_OWNER_TOKEN_PATH, {
		device_code: device.device_code,
	});
	return { device, token };
}

const confirmed = [
	{ error: "authorization_pending" },
	{ access_token: USER_TOKEN, token_type: "bearer" },
];

describe("the relay's owner sign-in", () => {
	it("hands out a sealed device code and keeps GitHub's code to itself", async () => {
		const relay = stand();
		const started = await relay.post(RELAY_OWNER_DEVICE_PATH, {});
		expect(started.status).toBe(200);
		const device = Device.parse(started.json);
		expect(device).toMatchObject({
			user_code: "ABCD-EFGH",
			verification_uri: "https://github.com/login/device",
			expires_in: 900,
			interval: 5,
		});
		expect(device.device_code).toMatch(/^[A-Za-z0-9_-]{40,1000}$/u);
		expect(started.text).not.toContain(GITHUB_DEVICE_CODE);
		expect(relay.bodies[0]).toBe("client_id=Iv1.relay");
	});

	it("binds the owner who administers the installation, then drops the user token", async () => {
		const relay = stand({ answers: confirmed });
		const device = Device.parse(
			(await relay.post(RELAY_OWNER_DEVICE_PATH, {})).json,
		);
		const pending = await relay.post(RELAY_OWNER_TOKEN_PATH, {
			device_code: device.device_code,
		});
		expect(pending).toMatchObject({
			status: 400,
			json: { error: "authorization_pending" },
		});
		const signed = await relay.post(RELAY_OWNER_TOKEN_PATH, {
			device_code: device.device_code,
		});
		expect(signed.status).toBe(200);
		const session = Session.parse(signed.json);
		expect(session.expires_in).toBe(RELAY_OWNER_SESSION_SECONDS);
		expect(signed.text).not.toContain(USER_TOKEN);
		expect(relay.calls).toContain(
			"DELETE https://api.github.com/applications/Iv1.relay/token",
		);
	});

	it("binds an organization administrator, and refuses a member or a stranger", async () => {
		for (const [owner, status] of [
			["org-admin", 200],
			["org-member", 403],
			["stranger", 403],
		] as const) {
			const relay = stand({
				owner,
				answers: [{ access_token: USER_TOKEN, token_type: "bearer" }],
			});
			const { token } = await signIn(relay);
			expect(token.status, owner).toBe(status);
			if (status === 403) expect(token.json).toEqual({ error: "not_owner" });
			expect(relay.calls).toContain(
				"DELETE https://api.github.com/applications/Iv1.relay/token",
			);
		}
	});

	it("passes GitHub's refusals on in RFC 8628 terms", async () => {
		for (const [answer, expected] of [
			[
				{ error: "slow_down", interval: 10 },
				{ error: "slow_down", interval: 10 },
			],
			[{ error: "access_denied" }, { error: "access_denied" }],
			[{ error: "expired_token" }, { error: "expired_token" }],
		] as const) {
			const { token } = await signIn(stand({ answers: [answer] }));
			expect(token).toMatchObject({ status: 400, json: expected });
		}
	});

	it("refuses a forged, foreign or expired device code", async () => {
		const relay = stand({ answers: confirmed });
		expect(
			(
				await relay.post(RELAY_OWNER_TOKEN_PATH, {
					device_code: "A".repeat(52),
				})
			).json,
		).toEqual({ error: "invalid_request" });
		const other = stand();
		const foreign = Device.parse(
			(await other.post(RELAY_OWNER_DEVICE_PATH, {})).json,
		);
		expect(
			(
				await relay.post(RELAY_OWNER_TOKEN_PATH, {
					device_code: foreign.device_code,
				})
			).json,
		).toEqual({ error: "invalid_request" });
		const device = Device.parse(
			(await relay.post(RELAY_OWNER_DEVICE_PATH, {})).json,
		);
		relay.advance(901_000);
		expect(
			(
				await relay.post(RELAY_OWNER_TOKEN_PATH, {
					device_code: device.device_code,
				})
			).json,
		).toEqual({ error: "expired_token" });
	});

	it("says when Device Flow is off or no account is configured", async () => {
		expect(
			(await stand({ deviceFlow: false }).post(RELAY_OWNER_DEVICE_PATH, {}))
				.json,
		).toEqual({ error: "device_flow_unavailable" });
		expect(
			(await stand({ account: undefined }).post(RELAY_OWNER_DEVICE_PATH, {}))
				.json,
		).toEqual({ error: "not_configured" });
	});

	it("refuses browsers from other origins and other methods", async () => {
		const relay = stand();
		const foreign = await relay.login.handle(
			new Request(`${ORIGIN}${RELAY_OWNER_DEVICE_PATH}`, {
				method: "POST",
				headers: { origin: "https://attacker.example" },
			}),
		);
		expect(foreign?.status).toBe(403);
		const get = await relay.login.handle(
			new Request(`${ORIGIN}${RELAY_OWNER_DEVICE_PATH}`),
		);
		expect(get?.status).toBe(405);
		expect(
			await relay.login.handle(new Request(`${ORIGIN}/v1/other`)),
		).toBeUndefined();
	});
});

describe("credentials for a signed-in session", () => {
	async function session() {
		const relay = stand({ answers: confirmed.slice(1) });
		const { token } = await signIn(relay);
		return {
			relay,
			bearer: `Bearer ${Session.parse(token.json).session_token}`,
		};
	}

	it("mints a short-lived installation token for a repository the account binds", async () => {
		const { relay, bearer } = await session();
		const answer = await relay.post(
			RELAY_OWNER_CREDENTIALS_PATH,
			{ ref: "github-app://Org/Repo", scope: "hobo ci status" },
			bearer,
		);
		expect(answer).toMatchObject({
			status: 200,
			json: { token: INSTALLATION_TOKEN, expires_in: 60 },
		});
		expect(
			(
				await relay.post(
					RELAY_OWNER_CREDENTIALS_PATH,
					{ ref: "github-app://Other/Repo", scope: "s" },
					bearer,
				)
			).json,
		).toEqual({ error: "not_bound" });
		expect(
			(
				await relay.post(
					RELAY_OWNER_CREDENTIALS_PATH,
					{ ref: "github-app://Missing/Repo", scope: "s" },
					bearer,
				)
			).json,
		).toEqual({ error: "not_bound" });
	});

	it("mints a 15-minute account credential the account API accepts, and nothing else", async () => {
		const { relay, bearer } = await session();
		const answer = await relay.post(
			RELAY_OWNER_CREDENTIALS_PATH,
			{ ref: "owner://HOBO_CI_ACCOUNT_TOKEN", scope: "hobo ci status" },
			bearer,
		);
		const credential = Credential.parse(answer.json);
		expect(credential.expires_in).toBe(900);
		expect(
			await relay.login.authenticate(`Bearer ${credential.token}`),
		).toEqual(account);
		expect(await relay.login.authenticate(bearer)).toBeUndefined();
		relay.advance(900_000);
		expect(
			await relay.login.authenticate(`Bearer ${credential.token}`),
		).toBeUndefined();
		for (const ref of [
			"owner://HOBO_CI_GITHUB_APP_PRIVATE_KEY",
			"owner://HOSTINGER_API_TOKEN",
		])
			expect(
				(
					await relay.post(
						RELAY_OWNER_CREDENTIALS_PATH,
						{ ref, scope: "s" },
						bearer,
					)
				).json,
			).toEqual({ error: "not_resolvable" });
	});

	it("refuses without a session, with a forged one, and once it expired", async () => {
		const { relay, bearer } = await session();
		const body = { ref: "github-app://Org/Repo", scope: "s" };
		expect((await relay.post(RELAY_OWNER_CREDENTIALS_PATH, body)).json).toEqual(
			{ error: "session_required" },
		);
		expect(
			(
				await relay.post(
					RELAY_OWNER_CREDENTIALS_PATH,
					body,
					`Bearer ${"S".repeat(52)}`,
				)
			).json,
		).toEqual({ error: "session_required" });
		relay.advance(RELAY_OWNER_SESSION_SECONDS * 1000);
		expect(
			(await relay.post(RELAY_OWNER_CREDENTIALS_PATH, body, bearer)).status,
		).toBe(401);
	});
});
