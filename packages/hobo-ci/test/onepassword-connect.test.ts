import {
	createOnePasswordSecretsPort,
	onePasswordBinding,
} from "@hobo/adapter-1password";
import { describe, expect, it } from "vitest";

import { parseHttpsOrigin } from "../src/index.js";
import { createOnePasswordConnectClient } from "../src/onepassword-connect.js";

// 1Password Connect through the same SecretsPort as the SDK: one Password
// item per secret, its value in the `password` field, a bearer token only.

const VAULT = "k2l3m4n5o6p7q8r9s0t1u2v3w4";
const CONNECT_HOST = parseHttpsOrigin(
	"OP_CONNECT_HOST",
	"https://connect.owner.example",
);
const binding = onePasswordBinding({
	vaultId: VAULT,
	authMode: "service-account",
});

function connect(token = "connect-token") {
	const items = new Map<string, { id: string; title: string; value: string }>();
	const seen: string[] = [];
	const http = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`)
			return new Response(null, { status: 401 });
		const base = `/v1/vaults/${VAULT}/items`;
		const view = (i: { id: string; title: string; value: string }) => ({
			id: i.id,
			title: i.title,
			category: "PASSWORD",
			vault: { id: VAULT },
			version: 1,
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
		if (url.pathname === base && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			expect(body.category).toBe("PASSWORD");
			expect(body.fields[0]).toMatchObject({
				id: "password",
				type: "CONCEALED",
				purpose: "PASSWORD",
			});
			const item = {
				id: `i${items.size + 1}`,
				title: body.title,
				value: body.fields[0].value,
			};
			items.set(item.id, item);
			return Response.json(view(item));
		}
		if (url.pathname === base)
			return Response.json(
				[...items.values()].map((i) => ({
					id: i.id,
					title: i.title,
					vault: { id: VAULT },
				})),
			);
		const item = items.get(url.pathname.slice(base.length + 1));
		if (item === undefined) return new Response(null, { status: 404 });
		if (init?.method === "PUT")
			item.value = JSON.parse(String(init.body)).fields[0].value;
		return Response.json(view(item));
	};
	return { http, seen };
}

describe("1Password Connect", () => {
	it("writes, reads and replaces a secret with only a bearer token", async () => {
		const server = connect();
		const port = createOnePasswordSecretsPort({
			client: createOnePasswordConnectClient({
				host: CONNECT_HOST,
				token: "connect-token",
				fetch: server.http,
			}),
			binding,
		});
		await port.put("HOBO_CD_VERCEL_TOKEN", "first");
		expect((await port.access("HOBO_CD_VERCEL_TOKEN")).material).toBe("first");
		await port.put("HOBO_CD_VERCEL_TOKEN", "second");
		expect((await port.access("HOBO_CD_VERCEL_TOKEN")).material).toBe("second");
		expect(await port.access("MISSING")).toMatchObject({
			code: "secret-not-found",
		});
	});

	it("reads as denied, not missing, until the owner's token reaches the request", async () => {
		const port = createOnePasswordSecretsPort({
			client: createOnePasswordConnectClient({
				host: CONNECT_HOST,
				token: "placeholder",
				fetch: connect().http,
			}),
			binding,
		});
		const read = await port.access("HOBO_CD_SETTINGS");
		expect(read.status).toBe("denied");
		expect(read).not.toMatchObject({ code: "secret-not-found" });
	});
});
