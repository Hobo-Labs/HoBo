import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("preserves Cloudflare HTTP handler behavior in workerd", async () => {
	const names = [
		"async-boundary",
		"code-unit-order",
		"cloudflare-capacity",
		"cloudflare-native-await",
		"cloudflare-native-promise",
		"cloudflare-byte-stream",
		"cloudflare-web-options",
		"cloudflare-kv-protocol",
		"cloudflare-r2-client",
		"cloudflare-r2-protocol",
		"cloudflare-runtime",
	];
	const modules = names.map((name) => ({
		type: "ESModule" as const,
		path: `${name}.js`,
		contents: stripTypeScriptTypes(
			readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
			{ mode: "transform" },
		),
	}));
	const entry = `
import { bindleCloudflareWorker } from './cloudflare-runtime.js';
import { cloudflareRequestBodyUsed, cloudflareResponseHeader } from './cloudflare-web-options.js';
function workerFor(factory, kind = 'web') {
  const declaration = { kind, name: 'web', stableId: kind + ':web', declaredAllow: [], dependsOn: [], annotations: [] };
  return bindleCloudflareWorker({ name: 'shop', resources: { web: declaration }, edges: [], requirements: {}, entrypoint: () => factory }, 'web');
}
export default { async fetch() {
  const request = () => new Request('https://example.test/');
  let receiver = false;
  class Handler { fetch() { receiver = this instanceof Handler; return new Response('class'); } }
  const classResult = await workerFor(() => new Handler()).fetch(request(), {});
  const uiResult = await workerFor(() => () => new Response('ui works'), 'ui').fetch(request(), {});
  const uiBody = await uiResult.text();
  const frozen = Object.freeze(new Response(null, { status: 204 }));
  const frozenResult = await workerFor(() => () => frozen).fetch(request(), {});
  const large = new Response('large', { headers: { 'x-hobo-kv-key': 'x'.repeat(8193) } });
  const largeResult = await workerFor(() => () => large).fetch(request(), {});
  let receiptRejected = false;
  try { cloudflareResponseHeader(large, 'x-hobo-kv-key'); } catch { receiptRejected = true; }
  class ResponsePromise extends Promise {}
  const subResponse = new Response('subclass');
  const subclass = new ResponsePromise((resolve) => resolve(subResponse));
  const subclassResult = await workerFor(() => () => subclass).fetch(request(), {});
  const restored = Object.getOwnPropertyDescriptor(subclass, 'constructor') === undefined;
  const post = new Request('https://example.test/', { method: 'POST', body: 'body' });
  const usedBefore = cloudflareRequestBodyUsed(post);
  await post.text();
  const usedAfter = cloudflareRequestBodyUsed(post);
  return Response.json({ classStatus: classResult.status, uiStatus: uiResult.status, uiBody, receiver, frozenSame: frozenResult === frozen,
    largeSame: largeResult === large, receiptRejected, subclassSame: subclassResult === subResponse,
    restored, usedBefore, usedAfter });
} }`;
	const workerd = new Miniflare({
		compatibilityDate: "2026-01-01",
		modules: [
			{ type: "ESModule", path: "app.js", contents: entry },
			...modules,
		],
	});
	try {
		const response = await workerd.dispatchFetch("http://localhost/");
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(JSON.parse(body)).toEqual({
			classStatus: 200,
			uiStatus: 200,
			uiBody: "ui works",
			receiver: true,
			frozenSame: true,
			largeSame: true,
			receiptRejected: true,
			subclassSame: true,
			restored: true,
			usedBefore: false,
			usedAfter: true,
		});
	} finally {
		await workerd.dispose();
	}
});
