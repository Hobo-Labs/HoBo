import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { CLOUDFLARE_KV_MAX_VALUE_BYTES } from "../src/cloudflare-kv-protocol.js";

it("runs the actual proxy over workerd service bindings and native KV byte streams", async () => {
	const proxy = stripTypeScriptTypes(
		readFileSync(
			new URL("../src/cloudflare-kv-proxy.ts", import.meta.url),
			"utf8",
		),
		{ mode: "transform" },
	);
	const protocol = stripTypeScriptTypes(
		readFileSync(
			new URL("../src/cloudflare-kv-protocol.ts", import.meta.url),
			"utf8",
		),
		{ mode: "transform" },
	);
	const app = `export default { async fetch(request, env) {
		const url = new URL(request.url);
		const binding = url.pathname.startsWith('/reader/') ? env.READER : env.WRITER;
		const operation = url.pathname.split('/')[2];
		const headers = { 'x-hobo-kv-key': url.searchParams.get('key') ?? 'key' };
		const init = { method: 'POST', headers };
		if (operation === 'set') init.body = new Uint8Array([0, 255, 7]);
		return await binding.fetch(new Request('https://hobo-kv.internal/' + operation, init));
	} }`;
	const modules = [
		{ type: "ESModule" as const, path: "proxy.js", contents: proxy },
		{
			type: "ESModule" as const,
			path: "cloudflare-kv-protocol.js",
			contents: protocol,
		},
	];
	const workerd = new Miniflare({
		compatibilityDate: "2026-01-01",
		workers: [
			{
				name: "app",
				modules: true,
				script: app,
				serviceBindings: { READER: "reader", WRITER: "writer" },
			},
			{
				name: "reader",
				modules,
				kvNamespaces: { HOBO_KV_NAMESPACE: "read-store" },
				bindings: { HOBO_KV_MODE: "read-only", HOBO_KV_ALLOW: "get" },
			},
			{
				name: "writer",
				modules,
				kvNamespaces: { HOBO_KV_NAMESPACE: "write-store" },
				bindings: { HOBO_KV_MODE: "write-only", HOBO_KV_ALLOW: "set" },
			},
		],
	});
	try {
		const reader = await workerd.getKVNamespace("HOBO_KV_NAMESPACE", "reader");
		await reader.put("binary", new Uint8Array([0, 255, 7]).buffer);
		await reader.put("empty", new Uint8Array().buffer);
		await reader.put(
			"large",
			new Uint8Array(CLOUDFLARE_KV_MAX_VALUE_BYTES + 1).buffer,
		);
		const get = (path: string) =>
			workerd.dispatchFetch(`http://localhost/${path}`);
		const response = await get("reader/get?key=binary");
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array([0, 255, 7]),
		);
		const empty = await get("reader/get?key=empty");
		expect(empty.status).toBe(200);
		expect((await empty.arrayBuffer()).byteLength).toBe(0);
		expect((await get("reader/get?key=missing")).status).toBe(404);
		expect((await get("reader/get?key=large")).status).toBe(413);
		expect((await get("reader/set")).status).toBe(403);
		expect((await get("writer/get")).status).toBe(403);
		expect((await get("writer/delete")).status).toBe(403);
		expect((await get("writer/set")).status).toBe(204);
		const writer = await workerd.getKVNamespace("HOBO_KV_NAMESPACE", "writer");
		expect(
			new Uint8Array(
				(await writer.get("key", "arrayBuffer")) ?? new ArrayBuffer(0),
			),
		).toEqual(new Uint8Array([0, 255, 7]));
	} finally {
		await workerd.dispose();
	}
}, 60_000);
