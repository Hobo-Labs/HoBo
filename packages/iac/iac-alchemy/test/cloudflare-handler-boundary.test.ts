/* oxlint-disable unicorn/no-thenable -- These tests deliberately exercise response assimilation. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
	bindleCloudflareWorker,
	type CloudflareBindleContext,
	type CloudflareBindleEntrypoint,
	cloudflareBindings,
	inspectCloudflareWorker,
} from "../src/cloudflare-runtime.js";

function workerFor(entrypoint: CloudflareBindleEntrypoint) {
	return bindleCloudflareWorker(
		{
			name: "shop",
			resources: {
				web: {
					kind: "web",
					name: "web",
					stableId: "web:web",
					declaredAllow: [],
					dependsOn: [],
					annotations: [],
				},
			},
			edges: [],
			requirements: {},
			entrypoint: () => entrypoint,
		},
		"web",
	);
}

it("keeps private WeakMap and handler operations when callbacks replace intrinsics", async () => {
	const response = new Response("ok");
	const request = new Request("https://example.test/");
	const weakGet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
	const weakSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "set");
	const hasInstance = Object.getOwnPropertyDescriptor(
		Function,
		Symbol.hasInstance,
	);
	if (weakGet === undefined || weakSet === undefined)
		throw new Error("missing native WeakMap methods");
	const originalDescriptor = Object.getOwnPropertyDescriptor;
	const originalApply = Reflect.apply;
	let traps = 0;
	let receiverCorrect = false;
	let boundContext = false;
	const handler = function (this: { readonly fetch: () => Response }) {
		receiverCorrect = this === wrapper;
		return response;
	};
	Object.defineProperty(handler, "call", {
		get() {
			traps++;
			throw new Error("unexpected call getter");
		},
	});
	const wrapper = { fetch: handler };
	const entrypoint = (context?: CloudflareBindleContext) => {
		boundContext = cloudflareBindings(context) !== undefined;
		Object.defineProperty(Function, Symbol.hasInstance, {
			configurable: true,
			value() {
				traps++;
				throw new Error("unexpected hasInstance");
			},
		});
		Object.getOwnPropertyDescriptor = () => {
			traps++;
			throw new Error("unexpected descriptor replacement");
		};
		Reflect.apply = () => {
			traps++;
			throw new Error("unexpected apply replacement");
		};
		return wrapper;
	};
	let pending: Promise<Response> | undefined;
	let capturedEntrypoint: CloudflareBindleEntrypoint | undefined;
	try {
		Object.defineProperty(WeakMap.prototype, "get", {
			...weakGet,
			value() {
				traps++;
				return undefined;
			},
		});
		Object.defineProperty(WeakMap.prototype, "set", {
			...weakSet,
			value() {
				traps++;
				return this;
			},
		});
		const worker = workerFor(entrypoint);
		pending = worker.fetch(request, {});
		capturedEntrypoint = inspectCloudflareWorker(worker)?.entrypoint;
	} finally {
		Object.getOwnPropertyDescriptor = originalDescriptor;
		Reflect.apply = originalApply;
		Object.defineProperty(WeakMap.prototype, "get", weakGet);
		Object.defineProperty(WeakMap.prototype, "set", weakSet);
		if (hasInstance === undefined)
			Reflect.deleteProperty(Function, Symbol.hasInstance);
		else Object.defineProperty(Function, Symbol.hasInstance, hasInstance);
	}
	expect(pending).toBeDefined();
	expect(await pending).toBe(response);
	expect(capturedEntrypoint).toBe(entrypoint);
	expect(boundContext).toBe(true);
	expect(receiverCorrect).toBe(true);
	expect(traps).toBe(0);
});

it("rejects an accessor-backed fetch handler without reading it", async () => {
	let traps = 0;
	const worker = workerFor(() => ({
		get fetch() {
			traps++;
			throw new Error("unexpected fetch getter");
		},
	}));
	await expect(
		worker.fetch(new Request("https://example.test/"), {}),
	).rejects.toThrow("bindle entrypoint did not return an HTTP handler");
	expect(traps).toBe(0);
});

it("protects a synchronous response before the Worker resolves it", async () => {
	const thenProperty = "then";
	const response = new Response("ok");
	const request = new Request("https://example.test/");
	const original = Object.getOwnPropertyDescriptor(
		Object.prototype,
		thenProperty,
	);
	let traps = 0;
	const worker = workerFor(() => () => {
		Object.defineProperty(Object.prototype, thenProperty, {
			configurable: true,
			get() {
				traps++;
				throw new Error("unexpected then getter");
			},
		});
		return response;
	});
	let actual: Response | undefined;
	try {
		actual = await worker.fetch(request, {});
	} finally {
		if (original === undefined)
			Reflect.deleteProperty(Object.prototype, thenProperty);
		else Object.defineProperty(Object.prototype, thenProperty, original);
	}
	expect(actual).toBe(response);
	expect(traps).toBe(0);
});

it("observes and rejects a native Promise returned by the entrypoint factory", () => {
	const packageDir = fileURLToPath(new URL("../", import.meta.url));
	const directory = join(packageDir, "dist");
	expect(existsSync(join(directory, "cloudflare-runtime.js"))).toBe(true);
	const modulePath = pathToFileURL(
		join(directory, "cloudflare-runtime.js"),
	).href;
	const program = `
import { bindleCloudflareWorker } from ${JSON.stringify(modulePath)};
const declaration = { kind: 'web', name: 'web', stableId: 'web:web', declaredAllow: [], dependsOn: [], annotations: [] };
const rejected = Promise.reject(new Error('factory rejection'));
Object.defineProperty(rejected, 'fetch', { value() { throw new Error('must not run'); } });
const app = { name: 'shop', resources: { web: declaration }, edges: [], requirements: {}, entrypoint: () => () => rejected };
const worker = bindleCloudflareWorker(app, 'web');
try {
  await worker.fetch(new Request('https://example.test/'), {});
  process.exitCode = 1;
} catch (error) {
  if (error.message !== 'bindle entrypoint did not return an HTTP handler') process.exitCode = 2;
}
await new Promise((resolve) => setTimeout(resolve, 20));
`;
	const result = spawnSync(
		process.execPath,
		["--unhandled-rejections=strict", "--input-type=module", "-e", program],
		{
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, NODE_OPTIONS: "" },
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
});
