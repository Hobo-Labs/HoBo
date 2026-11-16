import type { CommandRunInput, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	OWNER_CREDENTIAL_LINE_PREFIX,
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

// EVAL: the owner chooses their secret store (Infisical, 1Password or
// Bitwarden), and a handed-off `hobo cd up` on a box they cannot reach does
// what that store allows: it asks for the choice when none was made, signs in
// to 1Password through the owner's Connect server with a token the egress
// proxy injects (the run never holds it), and uses Bitwarden Secrets
// Manager through its API with the access token the environment provides,
// moved into the run's vault: no owner credential, no terminal.

const LOOPBACK = /\b(127\.0\.0\.1|localhost)\b/u;
const CONNECT = "https://connect.owner.example";
const OWNER_TOKEN = "owner-connect-token";

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
		expect(all).toMatch(/OP_CONNECT_HOST/u);
		expect(all).not.toMatch(LOOPBACK);
	});
});

/**
 * The owner's 1Password Connect server behind the agent's egress proxy: the
 * proxy replaces the run's placeholder bearer with the owner's token once
 * the owner saved it in the session's credential form.
 */
function connectBehindProxy() {
	let saved: string | undefined;
	const items = new Map<
		string,
		{ id: string; title: string; value: string; version: number }
	>();
	let next = 1;
	const http = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.origin === CONNECT) {
			const bearer =
				saved ?? new Headers(init?.headers).get("authorization")?.slice(7);
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
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body));
				item.value = body.fields.find(
					(f: { id: string }) => f.id === "password",
				).value;
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
	return {
		http,
		items,
		save: (token: string) => {
			saved = token;
		},
	};
}

describe("EVAL store choice: 1Password through the owner's Connect server", () => {
	it("waits for the Connect token in the credential form, then connects Vercel into the owner's vault", async () => {
		const shown: string[] = [];
		const connect = connectBehindProxy();
		const outcome = await prepareVercelConnection(
			handOff((line) => {
				shown.push(line);
				if (line.startsWith(`${OWNER_CREDENTIAL_LINE_PREFIX} `)) {
					expect(line).toContain("host=connect.owner.example");
					connect.save(OWNER_TOKEN);
				}
			}),
			{
				env: {
					HOBO_SECRET_STORE: "1password",
					OP_VAULT_ID: "k2l3m4n5o6p7q8r9s0t1u2v3w4",
					OP_CONNECT_HOST: CONNECT,
				},
				locator: { read: async () => ({}), write: async () => undefined },
				fetch: connect.http,
				sleep: async () => undefined,
				handOffTimeoutMs: 200,
				startPage: noPage,
			},
		);
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
			shown.some((l) => l.startsWith(`${OWNER_CREDENTIAL_LINE_PREFIX} `)),
		).toBe(false);
		expect(all).not.toMatch(/terminal/u);
		expect(all).not.toContain("0.machine.secret:key");
	});

	it("without a token says how the environment provides one, never the owner's terminal", async () => {
		const shown: string[] = [];
		const outcome = await prepareVercelConnection(
			handOff((l) => shown.push(l)),
			{
				env: { ...ids, HOBO_SECRET_STORE: "bitwarden" },
				locator: { read: async () => ({}), write: async () => undefined },
				sleep: async () => undefined,
				handOffTimeoutMs: 200,
				startPage: noPage,
			},
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_NEEDS_SIGN_IN" },
		});
		const all = text(shown, outcome);
		expect(all).toMatch(/BWS_ACCESS_TOKEN in the environment's settings/u);
		expect(all).not.toMatch(/terminal/u);
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
