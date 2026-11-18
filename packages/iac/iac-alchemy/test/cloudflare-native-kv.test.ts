import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Providers } from "@alchemy.run/cloudflare/Providers";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import type { ResourceClass } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/bindle.js";
import {
	cloudflareEventualKv,
	cloudflareKvGrant,
} from "../src/cloudflare-kv-protocol.js";
import {
	type CloudflareKvProxyEnvironment,
	cloudflareKvProxy,
} from "../src/cloudflare-kv-proxy.js";
import {
	cloudflareKvNamespaceClaim,
	cloudflareKvProxySource,
	cloudflareNativeKvBindleMappers,
} from "../src/cloudflare-native-kv.js";
import {
	bindleCloudflareWorker,
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	type CloudflareBindleContext,
	cloudflareBindings,
	withCloudflareEventualKv,
} from "../src/cloudflare-runtime.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { hashAlchemyPriorState } from "../src/plan.js";
import worker, {
	application,
	neutralApplication,
} from "./fixtures/cloudflare-kv-app.js";
import { application as writerApplication } from "./fixtures/cloudflare-kv-writer-app.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

const main = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-kv-app.ts",
);
const writerMain = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/cloudflare-kv-writer-app.ts",
);
const httpAnnotation = {
	provider: "hobo",
	option: "session-replay",
	config: { enabled: false },
};
const readGrant = {
	mode: "read-only" as const,
	grantEpoch: `sha256:${"1".repeat(64)}`,
	namespaceEpoch: `sha256:${"4".repeat(64)}`,
};

function appFor(
	mode: "read-only" | "write-only",
	allow: string[],
	entrypoint: (context?: CloudflareBindleContext) => () => Promise<Response>,
) {
	return withCloudflareEventualKv(
		{
			name: "app",
			resources: {
				cache: {
					kind: "kv",
					name: "cache",
					stableId: "kv:cache",
					declaredAllow: allow,
					dependsOn: [],
					annotations: [],
				},
				web: {
					kind: "web",
					name: "web",
					stableId: "web:web",
					declaredAllow: [],
					dependsOn: ["kv"],
					annotations: [httpAnnotation],
				},
			},
			edges: [{ from: "web", to: "cache" }],
			requirements: {},
			entrypoint: (name: string) => (name === "web" ? entrypoint : undefined),
		},
		{
			cache: {
				mode,
				grantEpoch: readGrant.grantEpoch,
				namespaceEpoch: readGrant.namespaceEpoch,
			},
		},
	);
}

function nativeNamespace() {
	const values = new Map<string, Uint8Array>();
	const calls: string[] = [];
	return {
		values,
		calls,
		binding: {
			async get(key: string, type: "stream") {
				calls.push(`get:${key}:${type}`);
				const value = values.get(key);
				return value === undefined
					? null
					: new Response(new Uint8Array(value)).body;
			},
			async put(key: string, value: ArrayBuffer) {
				calls.push(`put:${key}`);
				values.set(key, new Uint8Array(value.slice(0)));
			},
			async delete(key: string) {
				calls.push(`delete:${key}`);
				values.delete(key);
			},
		},
	};
}

function service(environment: CloudflareKvProxyEnvironment) {
	return {
		fetch: (request: Request) => cloudflareKvProxy.fetch(request, environment),
	};
}

function assessRequirements(requirements: {
	readonly require: readonly string[];
	readonly runtimes: readonly string[];
}) {
	return JSON.stringify(requirements.require) ===
		JSON.stringify(["http", "kv-eventual-read"]) &&
		JSON.stringify(requirements.runtimes) === JSON.stringify(["javascript"])
		? { status: "supported" as const }
		: {
				status: "unsupported" as const,
				reason: "only the declared JavaScript subset is available",
			};
}

describe("Cloudflare eventual KV JavaScript subset", () => {
	it("rejects inherited descriptor records and accessor grants", () => {
		let traps = 0;
		const fields = {
			mode: "read-only",
			grantEpoch: readGrant.grantEpoch,
			namespaceEpoch: readGrant.namespaceEpoch,
			allow: ["get"],
		};
		const previous = Object.entries(fields).map(
			([key]) =>
				[key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const,
		);
		const oldValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally malformed values exercise the untrusted input boundary.
		const missingChoice = { x: 1, y: 2, z: 3 } as never;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally malformed values exercise the untrusted input boundary.
		const missingGrant = { x: 1, y: 2, z: 3, w: 4 } as never;
		const choice = Object.defineProperty({ ...readGrant }, "mode", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("getter");
			},
		});
		for (const [key, value] of Object.entries(fields))
			Object.defineProperty(Object.prototype, key, {
				configurable: true,
				writable: true,
				value: { value, enumerable: true },
			});
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("inherited value");
			},
		});
		const errors: unknown[] = [];
		try {
			for (const run of [
				() => cloudflareEventualKv(missingChoice),
				() => cloudflareKvProxySource("app", "cache", missingGrant),
				() => cloudflareEventualKv(choice),
			])
				try {
					run();
				} catch (error) {
					errors.push(error);
				}
		} finally {
			if (oldValue === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", oldValue);
			for (const [key, old] of previous) {
				if (old === undefined) Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, old);
			}
		}
		expect(errors).toHaveLength(3);
		expect(traps).toBe(0);
	});

	it("rejects a proxied host grant without invoking its traps", () => {
		let traps = 0;
		const grant = new Proxy(
			{ ...readGrant, allow: ["get"] },
			{
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			},
		);
		expect(() => cloudflareKvProxySource("app", "cache", grant)).toThrow(
			"KV_GRANT_INVALID",
		);
		expect(traps).toBe(0);
	});

	it("rejects a proxied nested allow list before invoking its traps", () => {
		let traps = 0;
		const allow = new Proxy(["get"], {
			get() {
				traps++;
				throw new Error("trap");
			},
			ownKeys() {
				traps++;
				throw new Error("trap");
			},
		});
		const revoked = Proxy.revocable(["get"], {});
		revoked.revoke();
		for (const list of [allow, revoked.proxy])
			expect(() =>
				cloudflareKvProxySource("app", "cache", { ...readGrant, allow: list }),
			).toThrow("KV_GRANT_INVALID");
		expect(traps).toBe(0);
	});

	it("rejects sparse grant arrays even when an inherited descriptor claims their missing element", () => {
		const sparse: string[] = [];
		sparse.length = 1;
		const old = Object.getOwnPropertyDescriptor(Object.prototype, "0");
		Object.defineProperty(Object.prototype, "0", {
			configurable: true,
			writable: true,
			value: { value: "get", enumerable: true },
		});
		Object.defineProperty(sparse, "extra", {
			enumerable: true,
			value: "ignored",
		});
		let error: unknown;
		try {
			cloudflareKvGrant(
				"read-only",
				readGrant.grantEpoch,
				readGrant.namespaceEpoch,
				sparse,
			);
		} catch (caught) {
			error = caught;
		} finally {
			if (old === undefined) Reflect.deleteProperty(Object.prototype, "0");
			else Object.defineProperty(Object.prototype, "0", old);
		}
		expect(error).toMatchObject({ code: "KV_GRANT_INVALID" });
	});

	it("uses captured service invocation intrinsics for an eventual KV request", async () => {
		const native = nativeNamespace();
		let traps = 0;
		const app = appFor("read-only", ["get"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			await kv.get("key");
			return new Response("ok");
		});
		const oldGet = Reflect.get;
		const oldApply = Reflect.apply;
		const restore = () => {
			Reflect.get = oldGet;
			Reflect.apply = oldApply;
		};
		const real = service({
			HOBO_KV_MODE: "read-only",
			HOBO_KV_ALLOW: "get",
			HOBO_KV_NAMESPACE: native.binding,
		});
		const environment = Object.defineProperty({}, "HOBO_RESOURCE_0", {
			get() {
				Reflect.get = () => {
					traps++;
					throw new Error("get");
				};
				Reflect.apply = () => {
					traps++;
					throw new Error("apply");
				};
				return {
					fetch(request: Request) {
						restore();
						return real.fetch(request);
					},
				};
			},
		});
		try {
			await bindleCloudflareWorker(app, "web").fetch(
				new Request("https://app.test"),
				environment,
			);
		} finally {
			restore();
		}
		expect(native.calls).toEqual(["get:key:stream"]);
		expect(traps).toBe(0);
	});

	it("keeps the real Bindle provider-neutral and rejects invalid target choices", () => {
		expect(neutralApplication.resources.cache?.annotations).toEqual([]);
		expect(neutralApplication.requirements).toMatchObject({
			require: ["http", "kv-eventual-read"],
			runtimes: ["javascript"],
		});
		expect(
			assessRequirements({
				require: ["http", "kv"],
				runtimes: ["wasm"],
			}).status,
		).toBe("unsupported");
		expect(application.resources.cache?.annotations).toMatchObject([
			{ provider: "cloudflare", option: "eventual-kv" },
		]);
		expect(() =>
			withCloudflareEventualKv(neutralApplication, { missing: readGrant }),
		).toThrow("unknown resource");
		expect(() =>
			withCloudflareEventualKv(neutralApplication, { web: readGrant }),
		).toThrow("unannotated KV resource");
		const accessor = Object.defineProperty({}, "cache", {
			enumerable: true,
			get() {
				throw new Error("must not invoke accessors");
			},
		});
		expect(() =>
			withCloudflareEventualKv(neutralApplication, accessor),
		).toThrow("unannotated KV resource");
	});

	it("pins the proxy to an exact grant incarnation and canonical verbs", () => {
		const grant = {
			mode: "write-only" as const,
			grantEpoch: readGrant.grantEpoch,
			namespaceEpoch: readGrant.namespaceEpoch,
		};
		const source = (allow: string[], grantEpoch = grant.grantEpoch) =>
			cloudflareKvProxySource("kv-app", "cache", {
				...grant,
				grantEpoch,
				allow,
			}).resourceId;
		expect(source(["set", "delete"])).toBe(source(["delete", "set"]));
		expect(source(["set"])).not.toBe(source(["delete"]));
		expect(source(["set"])).not.toBe(
			source(["set"], `sha256:${"2".repeat(64)}`),
		);
		expect(source(["set"])).not.toBe(
			cloudflareKvProxySource("kv-app", "cache", {
				...readGrant,
				allow: ["get"],
			}).resourceId,
		);
		expect(() => source(["set"], "invalid")).toThrow("KV_GRANT_INVALID");
		const firstRead = cloudflareKvProxySource("kv-app", "cache", {
			...readGrant,
			allow: ["get"],
		});
		const renewedRead = cloudflareKvProxySource("kv-app", "cache", {
			...readGrant,
			grantEpoch: `sha256:${"3".repeat(64)}`,
			allow: ["get"],
		});
		expect(firstRead.resourceId).not.toBe(renewedRead.resourceId);
	});

	it("requires independent authorization of the proxy source before mapping", () => {
		for (const sourceFence of [
			undefined,
			{
				sourceDigest: `sha256:${"a".repeat(64)}`,
				environmentDigest: `sha256:${"b".repeat(64)}`,
				proofRef: "test:host",
				verify: () => false,
			},
		]) {
			const mappingOptions =
				sourceFence === undefined
					? {
							workerModules: { web: main },
							verifyNamespace: () => true,
							verifyGrant: () => true,
						}
					: {
							workerModules: { web: main },
							sourceFence,
							verifyNamespace: () => true,
							verifyGrant: () => true,
						};
			expect(() =>
				mapBindleToAlchemy(
					application,
					cloudflareNativeKvBindleMappers(mappingOptions),
					{ assessRequirements: () => ({ status: "supported" }) },
				),
			).toThrow(/SOURCE_FENCE_(REQUIRED|UNVERIFIED)/u);
		}
	});

	it("refuses namespace creation when ownership or migration is not independently authorized", () => {
		expect(() =>
			mapBindleToAlchemy(
				application,
				cloudflareNativeKvBindleMappers({
					workerModules: { web: main },
					sourceFence: {
						sourceDigest: `sha256:${"a".repeat(64)}`,
						environmentDigest: `sha256:${"b".repeat(64)}`,
						proofRef: "test:host",
						verify: () => true,
					},
					verifyNamespace: () => false,
					verifyGrant: () => true,
				}),
				{ assessRequirements: () => ({ status: "supported" }) },
			),
		).toThrow("KV_NAMESPACE_UNVERIFIED");
	});

	it("refuses a grant the independent host authority does not authorize", () => {
		expect(() =>
			mapBindleToAlchemy(
				application,
				cloudflareNativeKvBindleMappers({
					workerModules: { web: main },
					sourceFence: {
						sourceDigest: `sha256:${"a".repeat(64)}`,
						environmentDigest: `sha256:${"b".repeat(64)}`,
						proofRef: "test:host",
						verify: () => true,
					},
					verifyNamespace: () => true,
					verifyGrant: () => false,
				}),
				{ assessRequirements: () => ({ status: "supported" }) },
			),
		).toThrow("KV_GRANT_UNVERIFIED");
	});
	it.each(["namespace", "grant"] as const)(
		"rejects and observes an asynchronous KV %s verifier",
		async (field) => {
			const rejected = Promise.reject(new Error("authority unavailable"));
			const invalid = () => rejected as never;
			expect(() =>
				mapBindleToAlchemy(
					application,
					cloudflareNativeKvBindleMappers({
						workerModules: { web: main },
						sourceFence: {
							sourceDigest: `sha256:${"a".repeat(64)}`,
							environmentDigest: `sha256:${"b".repeat(64)}`,
							proofRef: "test:host",
							verify: () => true,
						},
						verifyNamespace: field === "namespace" ? invalid : () => true,
						verifyGrant: field === "grant" ? invalid : () => true,
					}),
					{ assessRequirements: () => ({ status: "supported" }) },
				),
			).toThrow(
				field === "namespace" ? "KV_NAMESPACE_UNVERIFIED" : "KV_GRANT_UNVERIFIED",
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
	);

	it("reads binary, empty and missing values through an isolated read-only proxy", async () => {
		const native = nativeNamespace();
		native.values.set("bin\u0000雪", new Uint8Array([0, 255, 127]));
		native.values.set("empty", new Uint8Array());
		const app = appFor("read-only", ["get"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			expect(await kv.get("bin\u0000雪")).toEqual(
				new Uint8Array([0, 255, 127]),
			);
			expect(await kv.get("empty")).toEqual(new Uint8Array());
			expect(await kv.exists("empty")).toBe(true);
			expect(await kv.get("missing")).toBeUndefined();
			expect(await kv.exists("missing")).toBe(false);
			await expect(
				kv.set({ key: "no", value: new Uint8Array([1]) }),
			).rejects.toMatchObject({ code: "KV_OPERATION_DENIED" });
			return new Response("ok");
		});
		const handler = bindleCloudflareWorker(app, "web");
		const result = await handler.fetch(new Request("https://app.test"), {
			HOBO_RESOURCE_0: service({
				HOBO_KV_MODE: "read-only",
				HOBO_KV_ALLOW: "get",
				HOBO_KV_NAMESPACE: native.binding,
			}),
		});
		expect(await result.text()).toBe("ok");
		expect(native.calls.every((call) => call.startsWith("get:"))).toBe(true);
	});

	it("enforces every write verb in the isolated proxy even if the app bypasses its wrapper", async () => {
		const native = nativeNamespace();
		const environment = {
			HOBO_KV_MODE: "write-only" as const,
			HOBO_KV_ALLOW: "set" as const,
			HOBO_KV_NAMESPACE: native.binding,
		};
		const request = (path: string) =>
			new Request(`https://hobo-kv.internal/${path}`, {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
				body: new Uint8Array([1]),
			});
		expect(
			(await cloudflareKvProxy.fetch(request("get"), environment)).status,
		).toBe(403);
		expect(
			(await cloudflareKvProxy.fetch(request("delete"), environment)).status,
		).toBe(403);
		expect(
			(await cloudflareKvProxy.fetch(request("set"), environment)).status,
		).toBe(204);
		expect(native.calls).toEqual(["put:key"]);
	});

	it("exhaustively rejects unauthorized combinations of proxy mode, allow list and operation", async () => {
		const modes = ["read-only", "write-only", "invalid"] as const;
		const grants = [
			"get",
			"set",
			"delete",
			"delete,set",
			"set,delete",
			"",
			"get,set",
		] as const;
		const operations = ["get", "set", "delete", "other"] as const;
		const permitted = new Set([
			"read-only/get/get",
			"write-only/set/set",
			"write-only/delete/delete",
			"write-only/delete,set/set",
			"write-only/delete,set/delete",
		]);
		for (const mode of modes) {
			for (const grant of grants) {
				for (const operation of operations) {
					const native = nativeNamespace();
					const allowed = permitted.has(`${mode}/${grant}/${operation}`);
					const response = await cloudflareKvProxy.fetch(
						new Request(`https://hobo-kv.internal/${operation}`, {
							method: "POST",
							headers: { "x-hobo-kv-key": "key" },
						}),
						{
							// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the test deliberately sends malformed external bindings.
							HOBO_KV_MODE:
								mode as CloudflareKvProxyEnvironment["HOBO_KV_MODE"],
							// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed grant strings are intentional negative cases.
							HOBO_KV_ALLOW:
								grant as CloudflareKvProxyEnvironment["HOBO_KV_ALLOW"],
							HOBO_KV_NAMESPACE: native.binding,
						},
					);
					expect(response.status, `${mode}/${grant}/${operation}`).toBe(
						allowed ? (operation === "get" ? 404 : 204) : 403,
					);
					expect(native.calls.length, `${mode}/${grant}/${operation}`).toBe(
						allowed ? 1 : 0,
					);
				}
			}
		}
	});

	it("allows an explicitly granted delete without granting writes or reads", async () => {
		const native = nativeNamespace();
		const app = appFor("write-only", ["delete"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			await kv.delete("key");
			await expect(kv.get("key")).rejects.toMatchObject({
				code: "KV_OPERATION_DENIED",
			});
			await expect(
				kv.set({ key: "key", value: new Uint8Array() }),
			).rejects.toMatchObject({
				code: "KV_OPERATION_DENIED",
			});
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "write-only",
					HOBO_KV_ALLOW: "delete",
					HOBO_KV_NAMESPACE: native.binding,
				}),
			},
		);
		expect(native.calls).toEqual(["delete:key"]);
	});

	it("reports an unknown mutation outcome and never retries a failed native write", async () => {
		const native = nativeNamespace();
		const app = appFor("write-only", ["set"], (context) => async () => {
			await expect(
				cloudflareBindings(context)
					.kv("cache")
					.set({ key: "key", value: new Uint8Array([7]) }),
			).rejects.toMatchObject({ code: "KV_MUTATION_OUTCOME_UNKNOWN" });
			return new Response("ok");
		});
		const handler = bindleCloudflareWorker(app, "web");
		const environment = {
			HOBO_KV_MODE: "write-only" as const,
			HOBO_KV_ALLOW: "set" as const,
			HOBO_KV_NAMESPACE: {
				...native.binding,
				async put(key: string, value: ArrayBuffer) {
					await native.binding.put(key, value);
					throw new Error("lost acknowledgment");
				},
			},
		};
		await handler.fetch(new Request("https://app.test"), {
			HOBO_RESOURCE_0: service(environment),
		});
		expect(native.calls).toEqual(["put:key"]);
		expect(native.values.get("key")).toEqual(new Uint8Array([7]));
	});

	it("reports backend read failures and does not return fabricated absence", async () => {
		const native = nativeNamespace();
		const app = appFor("read-only", ["get"], (context) => async () => {
			await expect(
				cloudflareBindings(context).kv("cache").get("key"),
			).rejects.toMatchObject({ code: "KV_READ_UNAVAILABLE" });
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "read-only",
					HOBO_KV_ALLOW: "get",
					HOBO_KV_NAMESPACE: {
						...native.binding,
						async get() {
							throw new Error("native read unavailable");
						},
					},
				}),
			},
		);
	});

	it("cancels an oversized native read stream before buffering it", async () => {
		const native = nativeNamespace();
		let canceled = false;
		const app = appFor("read-only", ["get"], (context) => async () => {
			await expect(
				cloudflareBindings(context).kv("cache").get("key"),
			).rejects.toMatchObject({ code: "KV_READ_UNAVAILABLE" });
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "read-only",
					HOBO_KV_ALLOW: "get",
					HOBO_KV_NAMESPACE: {
						...native.binding,
						async get() {
							return new ReadableStream<Uint8Array>({
								type: "bytes",
								start(controller) {
									controller.enqueue(
										new Uint8Array(CLOUDFLARE_KV_MAX_VALUE_BYTES),
									);
									controller.enqueue(new Uint8Array(1));
								},
								cancel() {
									canceled = true;
								},
							});
						},
					},
				}),
			},
		);
		expect(canceled).toBe(true);
	});

	it("fails closed and cancels a native stream without BYOB support", async () => {
		const native = nativeNamespace();
		let canceled = false;
		const response = await cloudflareKvProxy.fetch(
			new Request("https://hobo-kv.internal/get", {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
			}),
			{
				HOBO_KV_MODE: "read-only",
				HOBO_KV_ALLOW: "get",
				HOBO_KV_NAMESPACE: {
					...native.binding,
					async get() {
						return new ReadableStream<Uint8Array>({
							cancel() {
								canceled = true;
							},
						});
					},
				},
			},
		);
		expect(response.status).toBe(413);
		expect(canceled).toBe(true);
	});

	it.each([
		["read-only", []],
		["read-only", ["get", "set"]],
		["write-only", ["get"]],
		["write-only", ["set", "get"]],
	] as const)("rejects incompatible %s grants %j before binding", (mode, allow) => {
		const app = appFor(
			mode,
			[...allow],
			() => async () => new Response("unused"),
		);
		expect(() => bindleCloudflareWorker(app, "web")).toThrow("allow list");
	});

	it("rejects invalid keys and oversized values before touching the namespace", async () => {
		const native = nativeNamespace();
		const app = appFor("write-only", ["set"], (context) => async () => {
			const kv = cloudflareBindings(context).kv("cache");
			for (const key of ["", ".", "..", "a".repeat(513), "\ud800"])
				await expect(
					kv.set({ key, value: new Uint8Array() }),
				).rejects.toMatchObject({ code: "KV_KEY_INVALID" });
			await expect(
				kv.set({
					key: "ok",
					value: new Uint8Array(CLOUDFLARE_KV_MAX_VALUE_BYTES + 1),
				}),
			).rejects.toMatchObject({ code: "KV_VALUE_INVALID" });
			return new Response("ok");
		});
		await bindleCloudflareWorker(app, "web").fetch(
			new Request("https://app.test"),
			{
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "write-only",
					HOBO_KV_ALLOW: "set",
					HOBO_KV_NAMESPACE: native.binding,
				}),
			},
		);
		expect(native.calls).toEqual([]);
	});

	it("maps and applies real Alchemy Namespace and private proxy Worker resources", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-kv-"));
		const before = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const created: { type: string; news: object; bindings?: object[] }[] = [];
			const uncertain: string[] = [];
			let admissions = 0;
			let revokeOnFinancialRevalidation = false;
			let revokeNamespaceOnFinancialRevalidation = false;
			let namespaceAuthorized = true;
			let revokeGrantOnFinancialRevalidation = false;
			let grantAuthorized = true;
			const proxySource = cloudflareKvProxySource("kv-app", "cache", {
				...readGrant,
				allow: ["get"],
			});
			const namespaceClaim = cloudflareKvNamespaceClaim(
				"kv-app",
				"cache",
				readGrant.namespaceEpoch,
			);
			const appSource = {
				resourceId: "web",
				resourceType: "Cloudflare.Worker",
				bindleName: "kv-app",
				applicationName: "web",
				sourceKind: "worker",
				sourcePath: main,
			};
			const sourceRequirements = [proxySource, appSource];
			const proxyContentDigest = () =>
				createHash("sha256")
					.update(readFileSync(proxySource.sourcePath))
					.update(
						readFileSync(
							join(
								dirname(proxySource.sourcePath),
								"cloudflare-kv-protocol.ts",
							),
						),
					)
					.digest("hex");
			const approvedProxyDigest = proxyContentDigest();
			let presentedProxyDigest = approvedProxyDigest;
			let proxyAuthorized = true;
			const sourceFence = {
				sourceDigest: `sha256:${"a".repeat(64)}`,
				environmentDigest: `sha256:${"b".repeat(64)}`,
				proofRef: "test:host",
				verify: (claim: typeof proxySource) =>
					proxyAuthorized &&
					presentedProxyDigest === approvedProxyDigest &&
					proxyContentDigest() === approvedProxyDigest &&
					sourceRequirements.some(
						(requirement) =>
							requirement.resourceId === claim.resourceId &&
							requirement.resourceType === claim.resourceType &&
							requirement.bindleName === claim.bindleName &&
							requirement.applicationName === claim.applicationName &&
							requirement.sourceKind === claim.sourceKind &&
							requirement.sourcePath === claim.sourcePath,
					),
			};
			const namespaceProvider = Provider.succeed(Namespace, {
				reconcile: ({ news }) =>
					Effect.sync(() => {
						created.push({ type: Namespace.Type, news });
						return {
							...news,
							title: news.title ?? "cache",
							namespaceId: "ns",
							accountId: "account",
							supportsUrlEncoding: undefined,
						};
					}),
				delete: () => Effect.void,
			});
			/* oxlint-disable anti-slop/no-chained-type-assertions -- SAFETY: this provider is a narrowly scoped test double for beta.87's overloaded Worker class. */
			const workerProvider = Provider.succeed(
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: beta.87's overloaded Worker class is narrower than Provider.succeed's test port.
				Worker as unknown as ResourceClass<Worker>,
				{
					reconcile: ({ news, bindings, fqn }) =>
						Effect.sync(() => {
							created.push({ type: Worker.Type, news, bindings });
							// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this provider double supplies the workerName used by the service binding.
							return {
								...news,
								workerName: fqn,
							} as unknown as Worker["Attributes"];
						}),
					delete: () => Effect.void,
				},
			);
			/* oxlint-enable anti-slop/no-chained-type-assertions */
			const providers = Layer.effect(
				Providers,
				Provider.collection([Namespace, Worker]),
			).pipe(Layer.provide(Layer.mergeAll(namespaceProvider, workerProvider)));
			const mappers = cloudflareNativeKvBindleMappers({
				workerModules: { web: main },
				sourceFence,
				verifyNamespace: (claim) =>
					namespaceAuthorized &&
					JSON.stringify(claim) === JSON.stringify(namespaceClaim),
				verifyGrant: (claim) =>
					grantAuthorized &&
					claim.proxyResourceId === proxySource.resourceId &&
					claim.grantEpoch === readGrant.grantEpoch &&
					claim.mode === "read-only" &&
					JSON.stringify(claim.allow) === JSON.stringify(["get"]),
			});
			const coverage = describeAlchemyPrimitiveSupport(
				[{ factory: "kv", allowVerbs: ["get", "set", "delete"] }],
				mappers,
			);
			expect(coverage[0]).toMatchObject({
				status: "partial",
				supportedOperations: ["get", "set", "delete"],
			});
			const mapped = mapBindleToAlchemy(application, mappers, {
				assessRequirements,
			});
			const states: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
			const state = inMemoryState(states);
			const stack = Stack(
				"App",
				{ providers, state },
				mapped.pipe(Effect.map(() => ({}))),
			);
			const proxyId = proxySource.resourceId;
			const target = alchemyTarget({
				targetId: "yard",
				tenantId: "tenant",
				stackName: "App",
				stage: "test",
				programResourceId: "app",
				sourceDigest: `sha256:${"a".repeat(64)}`,
				inventoryEvidenceRef: "inventory:1",
				resources: [
					{
						resourceId: namespaceClaim.resourceId,
						resourceType: "Cloudflare.KV.Namespace",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "kv",
					},
					{
						resourceId: proxyId,
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
					{
						resourceId: "web",
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
				],
			});
			const makeProvider = (
				currentTarget = target,
				currentSources = sourceRequirements,
				currentStack = stack,
			) =>
				createAlchemyIacProvider({
					stateOwnership: testStateOwnership,
					stack: currentStack,
					target: currentTarget,
					runtimeLayer: Alchemist.layer(),
					runtimeDirectory: join(directory, "runtime"),
					route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` })
						.port,
					resolveRoute: ({ requestId }) => ({
						requestId: requestId ?? "request",
						operation: testOperation,
					}),
					composite: {
						proofRef: "test:host",
						environmentDigest: `sha256:${"b".repeat(64)}`,
						sourceRequirements: currentSources,
						verifyEnvironment: () => true,
						verifyPlan: ({ sourceClaims }) => {
							expect(sourceClaims).toHaveLength(2);
							expect(sourceClaims).toEqual(
								expect.arrayContaining([
									expect.objectContaining(proxySource),
									expect.objectContaining(appSource),
								]),
							);
							return true;
						},
					},
					financial: {
						assess: (plan) => ({ plan }),
						admit: async (requestId) => {
							admissions++;
							return {
								requestId,
								targetId: "yard",
								status: "admitted",
								code: "",
								message: "",
								budget: { evaluation: "allowed", reservation: "held" },
								reservation: { reservationId: `iac:${requestId}` },
								requestDigest: `sha256:${"c".repeat(64)}`,
								inventoryHash: `sha256:${"d".repeat(64)}`,
								modelHash: `sha256:${"e".repeat(64)}`,
								quoteHash: `sha256:${"f".repeat(64)}`,
							};
						},
						revalidate: () => {
							if (revokeOnFinancialRevalidation) proxyAuthorized = false;
							if (revokeNamespaceOnFinancialRevalidation)
								namespaceAuthorized = false;
							if (revokeGrantOnFinancialRevalidation) grantAuthorized = false;
							return true;
						},
						uncertain: (id) => {
							uncertain.push(id);
						},
					},
				});
			const provider = makeProvider();
			const program = {
				programId: "p",
				deploymentId: "d",
				resourceId: "app",
				provider: "cloudflare",
				driver: "external",
				action: "apply" as const,
				stackName: "App",
				operationGeneration: "generation-1",
			};
			for (const altered of [
				{ ...readGrant, grantEpoch: `sha256:${"7".repeat(64)}` },
				{ ...readGrant, namespaceEpoch: `sha256:${"8".repeat(64)}` },
			]) {
				const mismatched = withCloudflareEventualKv(neutralApplication, {
					cache: altered,
				});
				const mapping = mapBindleToAlchemy(
					mismatched,
					cloudflareNativeKvBindleMappers({
						workerModules: { web: main },
						sourceFence: { ...sourceFence, verify: () => true },
						verifyNamespace: () => true,
						verifyGrant: () => true,
					}),
					{ assessRequirements },
				);
				const mismatchedStack = Stack(
					"App",
					{ providers, state: inMemoryState() },
					mapping.pipe(Effect.map(() => ({}))),
				);
				await expect(
					makeProvider(target, sourceRequirements, mismatchedStack).preview(
						program,
					),
				).rejects.toThrow("PLAN_UNAVAILABLE");
			}
			expect(created).toEqual([]);
			expect((await provider.preview(program)).changes).toBe(3);
			await expect(
				makeProvider(target, [appSource]).preview(program),
			).rejects.toThrow("SOURCE_FENCE_INCOMPLETE");
			await expect(
				makeProvider(target, [
					{ ...proxySource, sourcePath: `${proxySource.sourcePath}.changed` },
					appSource,
				]).preview(program),
			).rejects.toThrow("SOURCE_FENCE_INCOMPLETE");
			const incompleteTarget = alchemyTarget({
				...target,
				resources: target.resources.filter(
					(entry) => entry.resourceId !== proxyId,
				),
			});
			await expect(
				makeProvider(incompleteTarget).preview(program),
			).rejects.toThrow("TARGET_INVENTORY_INCOMPLETE");
			await expect(
				makeProvider(incompleteTarget).applyWithAdmission(program, "missing"),
			).rejects.toThrow("PREVIEW_REQUIRED");
			expect(admissions).toBe(0);
			proxyAuthorized = false;
			await expect(provider.preview(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			expect(created).toEqual([]);
			proxyAuthorized = true;
			presentedProxyDigest = "changed";
			await expect(provider.preview(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			expect(created).toEqual([]);
			presentedProxyDigest = approvedProxyDigest;

			await expect(
				provider.applyWithAdmission(program, "stale-preview"),
			).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
			const revokedProvider = makeProvider();
			await revokedProvider.preview(program);
			revokeOnFinancialRevalidation = true;
			await expect(
				revokedProvider.applyWithAdmission(program, "revoked"),
			).rejects.toMatchObject({ requiresReconciliation: true });
			expect(uncertain).toContain("iac:revoked");
			expect(created).toEqual([]);
			revokeOnFinancialRevalidation = false;
			proxyAuthorized = true;
			const namespaceRevokedProvider = makeProvider();
			await namespaceRevokedProvider.preview(program);
			revokeNamespaceOnFinancialRevalidation = true;
			await expect(
				namespaceRevokedProvider.applyWithAdmission(
					program,
					"namespace-revoked",
				),
			).rejects.toMatchObject({ requiresReconciliation: true });
			expect(uncertain).toContain("iac:namespace-revoked");
			expect(created).toEqual([]);
			revokeNamespaceOnFinancialRevalidation = false;
			namespaceAuthorized = true;
			const grantRevokedProvider = makeProvider();
			await grantRevokedProvider.preview(program);
			revokeGrantOnFinancialRevalidation = true;
			await expect(
				grantRevokedProvider.applyWithAdmission(program, "grant-revoked"),
			).rejects.toMatchObject({ requiresReconciliation: true });
			expect(uncertain).toContain("iac:grant-revoked");
			expect(created).toEqual([]);
			revokeGrantOnFinancialRevalidation = false;
			grantAuthorized = true;
			await provider.preview(program);
			await provider.applyWithAdmission(program, "request");
			expect(
				created.filter((entry) => entry.type === Namespace.Type),
			).toHaveLength(1);
			expect(
				created.filter((entry) => entry.type === Worker.Type),
			).toHaveLength(2);
			const proxy = created.find(
				(entry) =>
					"workersDev" in entry.news && entry.news.workersDev === false,
			);
			expect(proxy?.news).toMatchObject({
				workersDev: false,
				domain: null,
				routes: [],
				env: { HOBO_KV_MODE: "read-only", HOBO_KV_ALLOW: "get" },
			});
			const appWorker = created.find(
				(entry) => entry.type === Worker.Type && entry !== proxy,
			);
			expect(appWorker?.news).toMatchObject({
				env: {
					HOBO_RESOURCE_0: expect.objectContaining({ workerName: proxyId }),
				},
			});
			expect(appWorker?.bindings).toMatchObject([
				{
					data: {
						bindings: [
							{ type: "service", name: "HOBO_RESOURCE_0", service: proxyId },
						],
					},
				},
			]);
			expect(proxy?.bindings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						data: expect.objectContaining({
							bindings: [
								expect.objectContaining({
									type: "kv_namespace",
									name: "HOBO_KV_NAMESPACE",
								}),
							],
						}),
					}),
				]),
			);
			const native = nativeNamespace();
			native.values.set("greeting", new TextEncoder().encode("hello"));
			const result = await worker.fetch(new Request("https://app.test"), {
				HOBO_RESOURCE_0: service({
					HOBO_KV_MODE: "read-only",
					HOBO_KV_ALLOW: "get",
					HOBO_KV_NAMESPACE: native.binding,
				}),
			});
			expect(await result.text()).toBe("hello");

			const writerGrant = {
				mode: "write-only" as const,
				grantEpoch: `sha256:${"2".repeat(64)}`,
				namespaceEpoch: readGrant.namespaceEpoch,
				allow: ["set"],
			};
			const writerSource = cloudflareKvProxySource(
				"kv-app",
				"cache",
				writerGrant,
			);
			const writerAppSource = { ...appSource, sourcePath: writerMain };
			const nextSources = [proxySource, writerSource, writerAppSource];
			const previousState = states.App?.test?.[proxyId];
			expect(previousState).toBeDefined();
			const trustedPriorDigest = hashAlchemyPriorState(previousState);
			const nextFence = {
				...sourceFence,
				verify: (claim: typeof proxySource) =>
					nextSources.some(
						(expected) =>
							expected.resourceId === claim.resourceId &&
							expected.resourceType === claim.resourceType &&
							expected.bindleName === claim.bindleName &&
							expected.applicationName === claim.applicationName &&
							expected.sourceKind === claim.sourceKind &&
							expected.sourcePath === claim.sourcePath,
					),
			};
			const writerMapped = mapBindleToAlchemy(
				writerApplication,
				cloudflareNativeKvBindleMappers({
					workerModules: { web: writerMain },
					sourceFence: nextFence,
					verifyNamespace: (claim) =>
						JSON.stringify(claim) === JSON.stringify(namespaceClaim),
					verifyGrant: (claim) =>
						claim.proxyResourceId === writerSource.resourceId &&
						claim.grantEpoch === writerGrant.grantEpoch &&
						claim.mode === "write-only" &&
						JSON.stringify(claim.allow) === JSON.stringify(["set"]),
				}),
				{
					assessRequirements: (requirements) =>
						JSON.stringify(requirements.require) ===
							JSON.stringify(["http", "kv-eventual-write"]) &&
						JSON.stringify(requirements.runtimes) ===
							JSON.stringify(["javascript"])
							? { status: "supported" }
							: { status: "unsupported", reason: "unrecognized requirements" },
				},
			);
			const writerStack = Stack(
				"App",
				{ providers, state },
				writerMapped.pipe(Effect.map(() => ({}))),
			);
			const updateTarget = alchemyTarget({
				targetId: target.targetId,
				tenantId: target.tenantId,
				stackName: target.stackName,
				stage: target.stage,
				programResourceId: target.programResourceId,
				sourceDigest: target.sourceDigest,
				inventoryEvidenceRef: target.inventoryEvidenceRef,
				resources: [
					...target.resources,
					{
						resourceId: writerSource.resourceId,
						resourceType: "Cloudflare.Worker",
						providerId: "cloudflare",
						providerAccountRef: "account",
						productId: "worker",
					},
				],
			});
			let retiredAndDrained = false;
			const updateProvider = (updateScope = updateTarget) =>
				createAlchemyIacProvider({
					stateOwnership: testStateOwnership,
					stack: writerStack,
					target: updateScope,
					runtimeLayer: Alchemist.layer(),
					runtimeDirectory: join(directory, "runtime-update"),
					route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` })
						.port,
					resolveRoute: ({ requestId }) => ({
						requestId: requestId ?? "update",
						operation: testOperation,
					}),
					composite: {
						proofRef: "test:host",
						environmentDigest: `sha256:${"b".repeat(64)}`,
						sourceRequirements: nextSources,
						verifyEnvironment: () => true,
						verifyPlan: ({ scope, historicalSources }) => {
							expect(scope.map(({ resourceId }) => resourceId)).toEqual(
								expect.arrayContaining([proxyId, writerSource.resourceId]),
							);
							expect(historicalSources).toContainEqual({
								resourceId: proxyId,
								resourceType: "Cloudflare.Worker",
								priorStateDigest: trustedPriorDigest,
							});
							return retiredAndDrained;
						},
					},
					financial: {
						assess: (plan) => ({ plan }),
						admit: async (requestId) => ({
							requestId,
							targetId: "yard",
							status: "admitted",
							code: "",
							message: "",
							budget: { evaluation: "allowed", reservation: "held" },
							reservation: { reservationId: `iac:${requestId}` },
							requestDigest: `sha256:${"c".repeat(64)}`,
							inventoryHash: `sha256:${"d".repeat(64)}`,
							modelHash: `sha256:${"e".repeat(64)}`,
							quoteHash: `sha256:${"f".repeat(64)}`,
						}),
						revalidate: () => true,
						uncertain: () => {},
					},
				});
			const updatedProgram = {
				...program,
				operationGeneration: "generation-2",
			};
			const missingOld = alchemyTarget({
				...updateTarget,
				resources: updateTarget.resources.filter(
					(entry) => entry.resourceId !== proxyId,
				),
			});
			await expect(
				updateProvider(missingOld).preview(updatedProgram),
			).rejects.toThrow("TARGET_INVENTORY_INCOMPLETE");
			const nextProvider = updateProvider();
			await expect(nextProvider.preview(updatedProgram)).rejects.toThrow(
				"COMPOSITE_PLAN_UNVERIFIED",
			);
			retiredAndDrained = true;
			await nextProvider.preview(updatedProgram);
			await nextProvider.applyWithAdmission(updatedProgram, "update");
			const staleWrite = new Request("https://hobo-kv.internal/set", {
				method: "POST",
				headers: { "x-hobo-kv-key": "greeting" },
				body: "unexpected",
			});
			expect(
				(
					await cloudflareKvProxy.fetch(staleWrite, {
						HOBO_KV_MODE: "read-only",
						HOBO_KV_ALLOW: "get",
						HOBO_KV_NAMESPACE: native.binding,
					})
				).status,
			).toBe(403);
			expect(native.values.get("greeting")).toEqual(
				new TextEncoder().encode("hello"),
			);
		} finally {
			if (before === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = before;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
