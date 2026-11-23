import type { CommandRunInput, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	OWNER_CAPTURE_LINE_PREFIX,
	type OwnerChannel,
	type SecretStoreOpening,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	OWNER_DEVICE_LINE_PREFIX,
	prepareVercelConnection,
	VERCEL_DEVICE_AUTHORIZATION_URL,
	VERCEL_DEVICE_TOKEN_URL,
} from "../../src/index.js";

const LOOPBACK = /\b(127\.0\.0\.1|localhost)\b/u;
const CONNECT = "https://connect.owner.example";
const OWNER_TOKEN = "owner-connect-token";

function heldChannel() {
	const held = new Map<string, string>();
	const channel: OwnerChannel & { deposit(name: string, value: string): void } =
		{
			openUrl: async () => undefined,
			captureSecret: async ({ name }) => {
				const value = held.get(name);
				held.delete(name);
				return value;
			},
			holds: (name) => held.has(name),
			deposit(name, value) {
				held.set(name, value);
			},
		};
	return channel;
}

function handOff(see: (line: string) => void): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: see,
		// SAFETY: the preparation reads only progress and these output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	// SAFETY: the preparation reads only progress and these output flags.
	return {
		action: "up",
		projectDir: "/box/project",
		whatIf: false,
		yes: false,
		handOff: true,
		run: run as CommandRunInput,
	};
}

const noPage = () => {
	throw new Error("a handed-off run serves no page");
};

function text(shown: readonly string[], outcome: PrepareOutcome): string {
	return [
		...shown,
		...(outcome.kind === "refused"
			? [outcome.result.message, ...(outcome.result.remediation ?? [])]
			: []),
	].join("\n");
}

describe("EVAL store choice: a handed-off run asks, never assumes", () => {
	it("refuses with all three stores and what each needs when none was chosen", async () => {
		const shown: string[] = [];
		const outcome = await prepareVercelConnection(
			handOff((l) => shown.push(l)),
			{
				env: {},
				locator: { read: async () => ({}), write: async () => undefined },
				startPage: noPage,
			},
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_CHOICE" },
		});
		const all = text(shown, outcome);
		for (const store of ["infisical", "1password", "bitwarden"])
			expect(all).toContain(`${store}:`);
		expect(all).toMatch(/INFISICAL_PROJECT_ID/u);
		expect(all).toMatch(/OP_VAULT_ID/u);
		// Each store says HoBo sets up its own access; nothing by hand.
		expect(all).not.toMatch(/Create Identity|Issue token|create a token/u);
		expect(all).not.toMatch(LOOPBACK);
	});
});

function connectServer() {
	const items = new Map<
		string,
		{ id: string; title: string; value: string; version: number }
	>();
	let next = 1;
	const http = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.origin === CONNECT) {
			const bearer = new Headers(init?.headers).get("authorization")?.slice(7);
			if (bearer !== OWNER_TOKEN) return new Response(null, { status: 401 });
			const base = "/v1/vaults/k2l3m4n5o6p7q8r9s0t1u2v3w4/items";
			if (url.pathname === base && (init?.method ?? "GET") === "GET")
				return Response.json(
					[...items.values()].map((i) => ({
						id: i.id,
						title: i.title,
						vault: { id: "k2l3m4n5o6p7q8r9s0t1u2v3w4" },
					})),
				);
			if (url.pathname === base && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				const field = body.fields.find(
					(f: { id: string }) => f.id === "password",
				);
				const item = {
					id: `item-${next++}`,
					title: body.title,
					value: field.value,
					version: 1,
				};
				items.set(item.id, item);
				return Response.json(view(item), { status: 200 });
			}
			const id = url.pathname.slice(base.length + 1);
			const item = items.get(id);
			if (item === undefined) return new Response(null, { status: 404 });
			if (init?.method === "PATCH") {
				const body = JSON.parse(String(init.body));
				expect(body).toEqual([
					{
						op: "add",
						path: "/fields/password/value",
						value: expect.any(String),
					},
				]);
				item.value = body[0].value;
				item.version += 1;
			}
			return Response.json(view(item));
		}
		if (String(input) === VERCEL_DEVICE_AUTHORIZATION_URL)
			return Response.json({
				device_code: "dc",
				user_code: "AAAA-BBBB",
				verification_uri: "https://vercel.com/device",
				verification_uri_complete:
					"https://vercel.com/device?user_code=AAAA-BBBB",
				expires_in: 600,
				interval: 5,
			});
		if (String(input) === VERCEL_DEVICE_TOKEN_URL)
			return Response.json({ access_token: "vercel-token" });
		if (String(input).startsWith("https://api.vercel.com/v2/teams"))
			return Response.json({
				teams: [{ id: "team_abc", slug: "acme" }],
				pagination: { next: null },
			});
		return new Response("{}", { status: 404 });
	};
	const view = (i: {
		id: string;
		title: string;
		value: string;
		version: number;
	}) => ({
		id: i.id,
		title: i.title,
		category: "PASSWORD",
		vault: { id: "k2l3m4n5o6p7q8r9s0t1u2v3w4" },
		version: i.version,
		fields: [
			{
				id: "password",
				label: "password",
				type: "CONCEALED",
				purpose: "PASSWORD",
				value: i.value,
			},
		],
	});
	return { http, items };
}

describe("EVAL store choice: 1Password through the owner's Connect server", () => {
	it("asks for the Connect token through HoBo's capture, then connects Vercel into the owner's vault", async () => {
		const shown: string[] = [];
		const connect = connectServer();
		const channel = heldChannel();
		const run = () =>
			prepareVercelConnection(
				handOff((line) => shown.push(line)),
				{
					env: {
						HOBO_SECRET_STORE: "1password",
						OP_VAULT_ID: "k2l3m4n5o6p7q8r9s0t1u2v3w4",
						OP_CONNECT_HOST: CONNECT,
					},
					locator: { read: async () => ({}), write: async () => undefined },
					ownerChannel: channel,
					fetch: connect.http,
					sleep: async () => undefined,
					startPage: noPage,
				},
			);
		const asked = text(shown, await run());
		expect(asked).toContain(
			`${OWNER_CAPTURE_LINE_PREFIX} name=OP_CONNECT_TOKEN guide=https://`,
		);
		expect(asked).not.toMatch(/credential form|egress/u);
		channel.deposit("OP_CONNECT_TOKEN", OWNER_TOKEN);
		const outcome = await run();
		if (outcome.kind !== "ready")
			throw new Error(`refused: ${JSON.stringify(outcome)}`);
		expect(
			shown.some((l) => l.startsWith(`${OWNER_DEVICE_LINE_PREFIX} `)),
		).toBe(true);
		const titles = [...connect.items.values()].map((i) => i.title).sort();
		expect(titles).toEqual(
			expect.arrayContaining([
				"HOBO_CD_VERCEL_TOKEN",
				"HOBO_CD_VERCEL_TEAM_ID",
				"HOBO_CD_VERCEL_INSTALLATION_ID",
			]),
		);
		expect(shown.join("\n")).not.toContain(OWNER_TOKEN);
		expect(shown.join("\n")).not.toMatch(LOOPBACK);
	});
});

describe("EVAL store choice: a provided token is never the owner's choice", () => {
	it("still asks the owner to choose, marking the configured store, and opens none", async () => {
		const shown: string[] = [];
		let opened = false;
		const outcome = await prepareVercelConnection(
			handOff((l) => shown.push(l)),
			{
				env: { BWS_ACCESS_TOKEN: "0.machine.secret:key" },
				locator: { read: async () => ({}), write: async () => undefined },
				openStore: async () => {
					opened = true;
					return { ok: false, message: "must not open", remediation: [] };
				},
				startPage: noPage,
			},
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_CHOICE" },
		});
		const all = text(shown, outcome);
		expect(all).toMatch(/bitwarden \(configured here/u);
		expect(all).not.toMatch(/infisical \(configured here/u);
		expect(opened).toBe(false);
		expect(all).not.toContain("0.machine.secret:key");
	});
});

describe("EVAL store choice: Bitwarden Secrets Manager through its API, from any box", () => {
	const ids = {
		BWS_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001",
		BWS_PROJECT_ID: "00000000-0000-4000-8000-000000000002",
	};

	it("once chosen, signs in with the environment's access token from the vault and connects Vercel, asking the owner for no credential", async () => {
		const shown: string[] = [];
		const port = createMemorySecretsPort({ id: "memory" });
		let signedInWith: string | undefined;
		let opened: string | undefined;
		const outcome = await prepareVercelConnection(
			handOff((line) => {
				shown.push(line);
			}),
			{
				// The owner chose Bitwarden; the environment provides its sign-in.
				env: {
					...ids,
					HOBO_SECRET_STORE: "bitwarden",
					BWS_ACCESS_TOKEN: "0.machine.secret:key",
				},
				locator: { read: async () => ({}), write: async () => undefined },
				openStore: async (
					id,
					_coordinates,
					signIn,
				): Promise<SecretStoreOpening> => {
					opened = id;
					signedInWith = signIn.reveal("BWS_ACCESS_TOKEN");
					return {
						ok: true,
						store: {
							id: "bitwarden",
							port,
							reference: (name) => `bws://project/${name}`,
						},
					};
				},
				fetch: vercelOnly(),
				sleep: async () => undefined,
				handOffTimeoutMs: 200,
				startPage: noPage,
			},
		);
		if (outcome.kind !== "ready")
			throw new Error(`refused: ${JSON.stringify(outcome)}`);
		expect(opened).toBe("bitwarden");
		expect(signedInWith).toBe("0.machine.secret:key");
		expect((await port.access("HOBO_CD_VERCEL_TOKEN")).status).toBe("ok");
		const all = shown.join("\n");
		expect(
			shown.some((l) => l.startsWith(`${OWNER_CAPTURE_LINE_PREFIX} `)),
		).toBe(false);
		expect(all).not.toMatch(/terminal/u);
		expect(all).not.toContain("0.machine.secret:key");
	});

	it("without a token or API key asks for the API key through HoBo's capture, never env or a terminal", async () => {
		const shown: string[] = [];
		const asked: string[] = [];
		const outcome = await prepareVercelConnection(
			handOff((l) => shown.push(l)),
			{
				env: { HOBO_SECRET_STORE: "bitwarden" },
				locator: { read: async () => ({}), write: async () => undefined },
				ownerChannel: heldChannel(),
				fetch: async (input) => {
					asked.push(String(input));
					return Response.json({ error: "invalid_client" }, { status: 400 });
				},
				sleep: async () => undefined,
				startPage: noPage,
			},
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_BITWARDEN_NEEDS_API_KEY" },
		});
		const all = text(shown, outcome);
		for (const name of ["BW_CLIENTID", "BW_CLIENTSECRET"])
			expect(all).toMatch(
				new RegExp(
					`^${OWNER_CAPTURE_LINE_PREFIX} name=${name} guide=https://vault\\.bitwarden\\.com/\\S*security-keys$`,
					"mu",
				),
			);
		expect(asked).toEqual([]);
		expect(all).not.toMatch(/terminal/u);
		expect(all).not.toMatch(/environment's settings|credential form|egress/u);
	});
});

describe("EVAL store choice: Bitwarden with only the owner's API key", () => {
	it("says exactly what to fix when Bitwarden rejects the API key, and never prints it", async () => {
		const shown: string[] = [];
		const secret = "Zq8pX1vL0rT5mN3bW7yK2cD9fG4hJ6";
		const outcome = await prepareVercelConnection(
			handOff((l) => shown.push(l)),
			{
				env: {
					HOBO_SECRET_STORE: "bitwarden",
					BW_CLIENTID: "user.0c7e4c1a-7a0e-4a65-9c2e-2f1b8f0d1e2a",
					BW_CLIENTSECRET: secret,
				},
				locator: { read: async () => ({}), write: async () => undefined },
				fetch: async () =>
					Response.json({ error: "invalid_client" }, { status: 400 }),
				sleep: async () => undefined,
				startPage: noPage,
			},
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_BITWARDEN_API_KEY_REJECTED" },
		});
		const all = text(shown, outcome);
		expect(all).toMatch(/View API key/u);
		expect(all).not.toContain(secret);
	});
});

/** Vercel's device grant, approved at once. */
function vercelOnly(): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url === VERCEL_DEVICE_AUTHORIZATION_URL)
			return Response.json({
				device_code: "dc",
				user_code: "AAAA-BBBB",
				verification_uri: "https://vercel.com/device",
				verification_uri_complete:
					"https://vercel.com/device?user_code=AAAA-BBBB",
				expires_in: 600,
				interval: 5,
			});
		if (url === VERCEL_DEVICE_TOKEN_URL)
			return Response.json({ access_token: "vercel-token" });
		if (url.startsWith("https://api.vercel.com/v2/teams"))
			return Response.json({
				teams: [{ id: "team_abc", slug: "acme" }],
				pagination: { next: null },
			});
		return new Response("{}", { status: 404 });
	};
}
