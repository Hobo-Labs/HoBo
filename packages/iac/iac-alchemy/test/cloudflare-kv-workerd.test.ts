import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { CLOUDFLARE_KV_MAX_VALUE_BYTES } from "../src/cloudflare-kv-protocol.js";

it("runs the actual proxy over workerd service bindings and native KV byte streams", async () => {
	const source = (name: string) =>
		stripTypeScriptTypes(
			readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
			{ mode: "transform" },
		);
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
		if (url.pathname === '/probe') return env.PROBE.fetch('https://probe.internal/');
		const binding = url.pathname.startsWith('/reader/') ? env.READER : env.WRITER;
		const operation = url.pathname.split('/')[2];
		const headers = { 'x-hobo-kv-key': url.searchParams.get('key') ?? 'key' };
		const init = { method: 'POST', headers };
		if (operation === 'set') init.body = new Uint8Array([0, 255, 7]);
		return await binding.fetch(new Request('https://hobo-kv.internal/' + operation, init));
	} }`;
	const probeSetup = `globalThis.probeClones = 0;
	for (const type of [Request, Response]) {
		const clone = type.prototype.clone;
		type.prototype.clone = function (...args) {
			globalThis.probeClones++;
			return Reflect.apply(clone, this, args);
		};
	}`;
	const probe = `import './probe-setup.js';
	import { cloudflareProtectResponse, cloudflareResponseStatus, cloudflareRequestUrl } from './cloudflare-web-options.js';
	export default { fetch() {
		let traps = 0;
		let cancellations = 0;
		const real = new Response(null, { status: 203 });
		const accepted = cloudflareProtectResponse(real);
		Object.defineProperty(real, 'status', { configurable: true, value: 204 });
		const snapshot = cloudflareResponseStatus(real);
		const hostile = new Response(null, { status: 203 });
		Object.defineProperty(hostile, 'status', { configurable: true, get() { traps++; return 200; } });
		const hostileAccepted = cloudflareProtectResponse(hostile);
		const fake = Object.create(null);
		Object.defineProperties(fake, { status: { value: 203 }, headers: { value: new Headers() }, body: { value: null } });
		const fakeAccepted = cloudflareProtectResponse(fake);
		const stalledBody = new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } });
		const stalledResponse = new Response(stalledBody);
		const stalledAccepted = cloudflareProtectResponse(stalledResponse);
		const nativeRequest = new Request('https://original.internal/');
		const url = cloudflareRequestUrl(nativeRequest);
		Object.defineProperty(nativeRequest, 'url', { configurable: true, value: 'https://replaced.internal/' });
		const urlSnapshot = cloudflareRequestUrl(nativeRequest);
		const badRequest = new Request('https://original.internal/');
		Object.defineProperty(badRequest, 'url', { configurable: true, get() { traps++; return 'https://replaced.internal/'; } });
		let badAccepted = true;
		try { cloudflareRequestUrl(badRequest); } catch { badAccepted = false; }
		return Response.json({ accepted, snapshot, hostileAccepted, fakeAccepted, stalledAccepted,
			clones: globalThis.probeClones, cancellations, url, urlSnapshot, badAccepted, traps });
	} }`;
	const modules = [
		{ type: "ESModule" as const, path: "proxy.js", contents: proxy },
		{
			type: "ESModule" as const,
			path: "cloudflare-kv-protocol.js",
			contents: protocol,
		},
		...[
			"async-boundary",
			"cloudflare-capacity",
			"cloudflare-native-promise",
			"cloudflare-native-await",
			"cloudflare-byte-stream",
			"cloudflare-web-options",
		].map((name) => ({
			type: "ESModule" as const,
			path: `${name}.js`,
			contents: source(name),
		})),
	];
	const workerd = new Miniflare({
		compatibilityDate: "2026-01-01",
		workers: [
			{
				name: "app",
				modules: true,
				script: app,
				serviceBindings: { READER: "reader", WRITER: "writer", PROBE: "probe" },
			},
			{
				name: "probe",
				compatibilityFlags: ["streams_enable_constructors"],
				modules: [
					{ type: "ESModule", path: "probe.js", contents: probe },
					{ type: "ESModule", path: "probe-setup.js", contents: probeSetup },
					...modules.slice(2),
				],
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
		const probeResponse = await get("probe");
		const probeText = await probeResponse.text();
		expect(probeResponse.status, probeText).toBe(200);
		expect(JSON.parse(probeText)).toEqual({
			accepted: true,
			snapshot: 203,
			hostileAccepted: false,
			fakeAccepted: false,
			stalledAccepted: true,
			clones: 0,
			cancellations: 0,
			url: "https://original.internal/",
			urlSnapshot: "https://original.internal/",
			badAccepted: false,
			traps: 0,
		});
		const response = await get("reader/get?key=binary");
		expect(response.status, await response.clone().text()).toBe(200);
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
