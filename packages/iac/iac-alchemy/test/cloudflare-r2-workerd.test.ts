import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("runs the actual bounded object client and proxy over workerd R2 and service bindings", async () => {
	const source = (name: string) =>
		stripTypeScriptTypes(
			readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
			{ mode: "transform" },
		);
	const protocol = {
		type: "ESModule" as const,
		path: "cloudflare-r2-protocol.js",
		contents: source("cloudflare-r2-protocol"),
	};
	const dependencies = [
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
	}));
	const app = `import { createCloudflareR2Store } from './cloudflare-r2-client.js';
	import { cloudflareR2Digest } from './cloudflare-r2-protocol.js';
	export default {async fetch(request,env) {
		const path=new URL(request.url).pathname;
		const store=createCloudflareR2Store(env.PROXY,['read','write','delete']);
		try {
			if(path==='/write') {const body=new Uint8Array([0,255,7]); await store.write({name:'雪',contentType:'text/plain; charset=utf-8',size:body.byteLength,digest:await cloudflareR2Digest(body.buffer),body});return new Response(null,{status:204});}
			if(path==='/read') {const value=await store.read('雪');return Response.json(value&&{...value,body:[...value.body]});}
			if(path==='/without-content-type') {await store.read('missing-type');return new Response('unexpected');}
			if(path==='/external') {const value=await store.read('external');return Response.json(value&&{...value,body:[...value.body]});}
			if(path==='/empty') {const value=await store.read('empty');return Response.json(value&&{...value,body:[...value.body]});}
			if(path==='/large') {await store.read('large');return new Response('unexpected');}
			if(path==='/denied') return env.READER.fetch('https://hobo-r2.internal/delete',{method:'POST',headers:{'x-hobo-r2-key':'external'}});
			if(path==='/delete') {await store.delete('雪');return new Response(null,{status:204});}
			return new Response(null,{status:404});
		} catch(error) {return Response.json({code:error.code},{status:500});}
	}}`;
	const proxyModules = [
		{
			type: "ESModule" as const,
			path: "cloudflare-r2-proxy.js",
			contents: source("cloudflare-r2-proxy"),
		},
		protocol,
		...dependencies,
	];
	const workerd = new Miniflare({
		compatibilityDate: "2026-01-01",
		workers: [
			{
				name: "app",
				modules: [
					{ type: "ESModule", path: "app.js", contents: app },
					{
						type: "ESModule",
						path: "cloudflare-r2-client.js",
						contents: source("cloudflare-r2-client"),
					},
					protocol,
					...dependencies,
				],
				serviceBindings: { PROXY: "proxy", READER: "reader" },
			},
			{
				name: "proxy",
				modules: proxyModules,
				r2Buckets: { HOBO_R2_BUCKET: "objects" },
				bindings: { HOBO_R2_ALLOW: "delete,read,write" },
			},
			{
				name: "reader",
				modules: proxyModules,
				r2Buckets: { HOBO_R2_BUCKET: "objects" },
				bindings: { HOBO_R2_ALLOW: "read" },
			},
		],
	});
	try {
		const bucket = await workerd.getR2Bucket("HOBO_R2_BUCKET", "proxy");
		await bucket.put("missing-type", new Uint8Array([4]));
		await bucket.put("external", new Uint8Array([8]), {
			httpMetadata: { contentType: "text/plain" },
		});
		await bucket.put("empty", new Uint8Array(), {
			httpMetadata: { contentType: "application/octet-stream" },
		});
		await bucket.put("large", new Uint8Array(1_048_577), {
			httpMetadata: { contentType: "application/octet-stream" },
		});
		const get = (path: string) =>
			workerd.dispatchFetch(`http://localhost${path}`);
		const written = await get("/write");
		expect(written.status, await written.clone().text()).toBe(204);
		expect(await (await get("/read")).json()).toMatchObject({
			name: "雪",
			contentType: "text/plain; charset=utf-8",
			size: 3,
			body: [0, 255, 7],
		});
		expect(await (await get("/without-content-type")).json()).toEqual({
			code: "R2_METADATA_UNSUPPORTED",
		});
		expect(await (await get("/external")).json()).toMatchObject({
			name: "external",
			contentType: "text/plain",
			size: 1,
			body: [8],
		});
		expect(await (await get("/empty")).json()).toMatchObject({
			name: "empty",
			size: 0,
			body: [],
		});
		expect(await (await get("/large")).json()).toEqual({
			code: "R2_OBJECT_TOO_LARGE",
		});
		expect((await get("/denied")).status).toBe(403);
		expect((await get("/delete")).status).toBe(204);
		expect(await bucket.get("雪")).toBeNull();
	} finally {
		await workerd.dispose();
	}
}, 60_000);
