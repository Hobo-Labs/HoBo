import { createHash } from "node:crypto";
import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import type { BindleEntrypoint } from "../../../bindles/src/types.js";
import { captureAwsHttpGraph } from "../src/aws-http-graph.js";
import {
	AWS_HTTP_MAX_IN_FLIGHT,
	awsHttpBindings,
	createAwsBindleApplication,
} from "../src/aws-http-runtime.js";
import { startAwsHttpServer } from "../src/aws-http-server.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import { type AwsKvStore, createAwsDynamoKvStore } from "../src/aws-kv.js";
import { withAwsDynamoKv } from "../src/aws-kv-mapper.js";
import { createAwsS3Store } from "../src/aws-s3.js";
import { withAwsS3 } from "../src/aws-s3-mapper.js";

const body = new Uint8Array([4, 5]);
const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
function fixture(
	entrypoint: BindleEntrypoint,
	verify: () => boolean = () => true,
) {
	let calls = 0;
	const layer = Layer.mergeAll(
		Endpoint.of("http://localhost:4566"),
		Credentials.fromCredentials(
			{
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			},
			"us-east-1",
		),
		FetchHttpClient.layer,
		Layer.succeed(FetchHttpClient.Fetch, (_url, init) => {
			calls++;
			const target = new Headers(init?.headers).get("x-amz-target");
			if (target?.includes("GetItem"))
				return Promise.resolve(
					Response.json({ Item: { pk: { S: "key" }, value: { B: "AQI=" } } }),
				);
			return Promise.resolve(
				new Response(body, {
					status: 200,
					headers: {
						"content-length": "2",
						"content-type": "application/octet-stream",
						"x-amz-meta-hobo-digest": hash,
					},
				}),
			);
		}),
	);
	const kv = createAwsDynamoKvStore({
		grant: {
			tableName: "sessions",
			accountId: "000000000000",
			partition: "aws",
			region: "us-east-1",
			resourceEpoch: `sha256:${"a".repeat(64)}`,
			grantEpoch: `sha256:${"b".repeat(64)}`,
			allow: ["get"],
		},
		verify: () => true,
		layer,
	});
	const bucket = createAwsS3Store({
		grant: {
			bucketName: "assets-bucket",
			accountId: "000000000000",
			region: "us-east-1",
			resourceEpoch: `sha256:${"c".repeat(64)}`,
			grantEpoch: `sha256:${"d".repeat(64)}`,
			allow: ["read"],
		},
		verify: () => true,
		layer,
	});
	const neutral = bindle("shop", (b) => {
		const sessions = b.kv().allow("get");
		const assets = b.bucket().allow("read");
		const web = b
			.web(entrypoint)
			.with(sessionReplay({ enabled: false }))
			.dependsOn(sessions, assets);
		return { sessions, assets, web };
	});
	const target = withAwsS3(withAwsDynamoKv(neutral, { sessions: true }), {
		assets: true,
	});
	const options = {
		bindle: target,
		applicationName: "web",
		stores: { sessions: kv, assets: bucket },
		verifyBinding: verify,
	};
	return {
		app: createAwsBindleApplication(options),
		options,
		layer,
		kv,
		bucket,
		calls: () => calls,
	};
}

describe("AWS application graph capture", () => {
	it("captures sorted immutable bindings and rejects ambiguous graph data", () => {
		const f = fixture(() => () => new Response("ok"));
		const bindle = f.options.bindle;
		const graph = captureAwsHttpGraph(bindle, "web");
		expect(
			graph.bindings.map(({ name, environment }) => [name, environment]),
		).toEqual([
			["assets", "HOBO_RESOURCE_0"],
			["sessions", "HOBO_RESOURCE_1"],
		]);
		expect(Object.isFrozen(graph.bindings)).toBe(true);
		expect(Object.isFrozen(graph.bindings[0]?.allow)).toBe(true);
		let invoked = false;
		const accessor = Object.defineProperty(
			{ ...bindle.resources },
			"sessions",
			{
				enumerable: true,
				get() {
					invoked = true;
					throw new Error("getter invoked");
				},
			},
		);
		expect(() =>
			captureAwsHttpGraph({ ...bindle, resources: accessor }, "web"),
		).toThrow();
		expect(invoked).toBe(false);
		const sparse = [...bindle.edges];
		delete sparse[0];
		expect(() =>
			captureAwsHttpGraph({ ...bindle, edges: sparse }, "web"),
		).toThrow();
		expect(() =>
			captureAwsHttpGraph(
				{ ...bindle, edges: [...bindle.edges, { from: "web", to: "missing" }] },
				"web",
			),
		).toThrow();
		expect(() =>
			captureAwsHttpGraph(
				{ ...bindle, edges: [...bindle.edges, ...bindle.edges] },
				"web",
			),
		).toThrow();
		expect(() =>
			captureAwsHttpGraph(
				{ ...bindle, resources: new Proxy(bindle.resources, {}) },
				"web",
			),
		).toThrow();
	});
});

describe("AWS HTTP source", () => {
	it("resolves provisioned names once and fails closed on mismatches and revocation", async () => {
		let authorized = true;
		const f = fixture((context) => async () => {
			const resources = awsHttpBindings(context);
			return Response.json([
				...((await resources.kv("sessions").get("key")) ?? []),
			]);
		});
		const environment = {
			HOBO_RESOURCE_0: "assets-bucket",
			HOBO_RESOURCE_1: "sessions",
		};
		let resolutions = 0;
		const source = defineAwsHttpSource({
			bindle: f.options.bindle,
			applicationName: "web",
			environment,
			resolveStores: (bindings) => {
				resolutions++;
				expect(bindings.map(({ physicalName }) => physicalName)).toEqual([
					"assets-bucket",
					"sessions",
				]);
				return f.options.stores;
			},
			verifyBinding: () => authorized,
		});
		const request = () => new Request("https://app.test/");
		expect((await source.fetch(request())).status).toBe(200);
		expect((await source.fetch(request())).status).toBe(200);
		expect(resolutions).toBe(1);
		environment.HOBO_RESOURCE_1 = "different-table";
		expect((await source.fetch(request())).status).toBe(503);
		environment.HOBO_RESOURCE_1 = "sessions";
		authorized = false;
		expect((await source.fetch(request())).status).toBe(503);
	});
	it("cannot skip environment checks by replacing array iteration or push", async () => {
		let calls = 0;
		const f = fixture(() => () => {
			calls++;
			return new Response("ok");
		});
		const environment = {
			HOBO_RESOURCE_0: "assets-bucket",
			HOBO_RESOURCE_1: "sessions",
		};
		const source = defineAwsHttpSource({
			bindle: f.options.bindle,
			applicationName: "web",
			environment,
			resolveStores: () => f.options.stores,
			verifyBinding: () => true,
		});
		expect((await source.fetch(new Request("https://app.test/"))).status).toBe(
			200,
		);
		environment.HOBO_RESOURCE_1 = "changed";
		const iterator = Array.prototype[Symbol.iterator];
		const push = Array.prototype.push;
		const request = new Request("https://app.test/");
		let result: Promise<Response>;
		try {
			Reflect.set(Array.prototype, Symbol.iterator, function* () {});
			Reflect.set(Array.prototype, "push", () => 0);
			result = source.fetch(request);
		} finally {
			Reflect.set(Array.prototype, Symbol.iterator, iterator);
			Reflect.set(Array.prototype, "push", push);
		}
		expect((await result).status).toBe(503);
		expect(calls).toBe(1);
	});
	it("rejects a resource name changed while the handler is in flight", async () => {
		let finish: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const f = fixture(() => async () => {
			await pending;
			return new Response("ok");
		});
		const environment = {
			HOBO_RESOURCE_0: "assets-bucket",
			HOBO_RESOURCE_1: "sessions",
		};
		const source = defineAwsHttpSource({
			bindle: f.options.bindle,
			applicationName: "web",
			environment,
			resolveStores: () => f.options.stores,
			verifyBinding: () => true,
		});
		const result = source.fetch(new Request("https://app.test/"));
		environment.HOBO_RESOURCE_1 = "changed";
		finish?.();
		expect((await result).status).toBe(503);
	});
	it("serves an HTTP request and rejects invalid listeners", async () => {
		const f = fixture(
			() => async (request) =>
				new Response(
					request.method === "POST"
						? String((await request.arrayBuffer()).byteLength)
						: "hello",
				),
		);
		const source = defineAwsHttpSource({
			bindle: f.options.bindle,
			applicationName: "web",
			environment: {
				HOBO_RESOURCE_0: "assets-bucket",
				HOBO_RESOURCE_1: "sessions",
			},
			resolveStores: () => f.options.stores,
			verifyBinding: () => true,
		});
		await expect(
			startAwsHttpServer(source, "localhost:99/path"),
		).rejects.toThrow("endpoint");
		const server = await startAwsHttpServer(source, "127.0.0.1:0");
		try {
			const response = await fetch(`http://127.0.0.1:${server.address.port}/`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("hello");
			const post = await fetch(`http://127.0.0.1:${server.address.port}/`, {
				method: "POST",
				body: "hello",
			});
			expect(await post.text()).toBe("5");
			const oversized = await fetch(
				`http://127.0.0.1:${server.address.port}/`,
				{ method: "POST", body: "x".repeat(1_048_577) },
			);
			expect(oversized.status).toBe(413);
		} finally {
			await server.close();
		}
	});
	it("does not bind a store with the wrong physical name", async () => {
		const f = fixture(() => () => new Response("ok"));
		const options = {
			bindle: f.options.bindle,
			applicationName: "web",
			environment: { HOBO_RESOURCE_0: "wrong", HOBO_RESOURCE_1: "sessions" },
			resolveStores: () => f.options.stores,
			verifyBinding: () => true,
		};
		const response = await defineAwsHttpSource(options).fetch(
			new Request("https://app.test/"),
		);
		expect(response.status).toBe(503);
	});
});

describe("AWS Bindle HTTP resource bindings", () => {
	it("keeps denied responses at 503 when array prototypes change", async () => {
		let authorized = true;
		let calls = 0;
		const f = fixture(
			() => () => {
				calls++;
				return new Response("ok");
			},
			() => authorized,
		);
		authorized = false;
		const request = new Request("https://app.test/");
		const iterator = Array.prototype[Symbol.iterator];
		const push = Array.prototype.push;
		let result: Promise<Response>;
		try {
			Reflect.set(Array.prototype, Symbol.iterator, function* () {});
			Reflect.set(Array.prototype, "push", () => 0);
			result = f.app.fetch(request);
		} finally {
			Reflect.set(Array.prototype, Symbol.iterator, iterator);
			Reflect.set(Array.prototype, "push", push);
		}
		expect((await result).status).toBe(503);
		expect(calls).toBe(0);
	});
	it("keeps buffered response bytes when array push is replaced", async () => {
		const f = fixture(() => () => new Response(new Uint8Array([7, 8, 9])));
		const push = Array.prototype.push;
		let response: Response;
		try {
			Reflect.set(Array.prototype, "push", () => 0);
			response = await f.app.fetch(new Request("https://app.test/"));
		} finally {
			Reflect.set(Array.prototype, "push", push);
		}
		expect(response.status).toBe(200);
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
			7, 8, 9,
		]);
	});
	it("binds the exact declared stores and retires request-scoped capabilities", async () => {
		let retained: AwsKvStore | undefined;
		const f = fixture((context) => async () => {
			const resources = awsHttpBindings(context);
			retained = resources.kv("sessions");
			const value = await retained.get("key");
			const asset = await resources.bucket("assets").read("file");
			return Response.json({
				value: [...(value ?? [])],
				asset: [...(asset?.body ?? [])],
			});
		});
		const response = await f.app.fetch(new Request("https://app.test/"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ value: [1, 2], asset: [4, 5] });
		expect(f.calls()).toBe(2);
		await expect(retained?.get("key")).rejects.toMatchObject({
			code: "AWS_KV_DENIED",
		});
		expect(() =>
			awsHttpBindings({
				connector: () => {
					throw new Error("unused");
				},
			}),
		).toThrow("context is unavailable");
	});
	it("rejects forged, extra, mismatched or unauthorized stores", () => {
		const f = fixture(() => () => new Response("ok"));
		expect(() =>
			createAwsBindleApplication({
				...f.options,
				stores: { sessions: { ...f.kv }, assets: f.bucket },
			}),
		).toThrow("does not match");
		expect(() =>
			createAwsBindleApplication({
				...f.options,
				stores: { sessions: f.kv, assets: f.bucket, extra: f.kv },
			}),
		).toThrow("incomplete");
		expect(() =>
			createAwsBindleApplication({
				...f.options,
				stores: { sessions: f.bucket, assets: f.kv },
			}),
		).toThrow("does not match");
		expect(() =>
			createAwsBindleApplication({ ...f.options, verifyBinding: () => false }),
		).toThrow("not authorized");
		const broader = createAwsDynamoKvStore({
			grant: {
				tableName: "sessions",
				accountId: "000000000000",
				partition: "aws",
				region: "us-east-1",
				resourceEpoch: `sha256:${"a".repeat(64)}`,
				grantEpoch: `sha256:${"b".repeat(64)}`,
				allow: ["get", "set"],
			},
			verify: () => true,
			layer: f.layer,
		});
		expect(() =>
			createAwsBindleApplication({
				...f.options,
				stores: { sessions: broader, assets: f.bucket },
			}),
		).toThrow("does not match");
		const alias = bindle("shop", (b) => {
			const one = b.kv().allow("get");
			const two = b.kv().allow("get");
			return {
				one,
				two,
				web: b
					.web(() => () => new Response("ok"))
					.with(sessionReplay({ enabled: false }))
					.dependsOn(one, two),
			};
		});
		const aliasTarget = withAwsDynamoKv(alias, { one: true, two: true });
		expect(() =>
			createAwsBindleApplication({
				bindle: aliasTarget,
				applicationName: "web",
				stores: { one: f.kv, two: f.kv },
				verifyBinding: () => true,
			}),
		).toThrow("identities must be unique");
	});
	it("revalidates after handler construction and before returning", async () => {
		let allowed = true;
		let invoked = false;
		const f = fixture(
			() => {
				allowed = false;
				return () => {
					invoked = true;
					return new Response("unsafe");
				};
			},
			() => allowed,
		);
		expect((await f.app.fetch(new Request("https://app.test/"))).status).toBe(
			503,
		);
		expect(invoked).toBe(false);
	});
	it("does not expose a response after in-flight grant revocation", async () => {
		let allowed = true;
		let resume: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const f = fixture(
			() => async () => {
				entered?.();
				await gate;
				return new Response("unsafe");
			},
			() => allowed,
		);
		const pending = f.app.fetch(new Request("https://app.test/"));
		await started;
		allowed = false;
		resume?.();
		expect((await pending).status).toBe(503);
	});
	it("cannot skip grant checks by replacing Array.every", async () => {
		let allowed = true;
		let invoked = false;
		const descriptor = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"every",
		);
		const f = fixture(
			() => {
				Object.defineProperty(Array.prototype, "every", {
					value: () => true,
					configurable: true,
				});
				allowed = false;
				return () => {
					invoked = true;
					return new Response("unsafe");
				};
			},
			() => allowed,
		);
		let pending: Promise<Response>;
		try {
			pending = f.app.fetch(new Request("https://app.test/"));
		} finally {
			if (descriptor)
				Object.defineProperty(Array.prototype, "every", descriptor);
		}
		expect((await pending).status).toBe(503);
		expect(invoked).toBe(false);
	});
	it("keeps timed-out handlers charged against application capacity", {
		timeout: 30_000,
	}, async () => {
		let unblock: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		let blocked = true;
		const f = fixture(() => async () => {
			if (blocked) await gate;
			return new Response("ok");
		});
		try {
			const calls = Array.from({ length: AWS_HTTP_MAX_IN_FLIGHT }, () =>
				f.app.fetch(new Request("https://app.test/")),
			);
			expect((await f.app.fetch(new Request("https://app.test/"))).status).toBe(
				503,
			);
			expect(
				(await Promise.all(calls)).every((response) => response.status === 503),
			).toBe(true);
			expect((await f.app.fetch(new Request("https://app.test/"))).status).toBe(
				503,
			);
			blocked = false;
			unblock?.();
			await vi.waitFor(
				async () =>
					expect(
						(await f.app.fetch(new Request("https://app.test/"))).status,
					).toBe(200),
				{ timeout: 5000 },
			);
		} finally {
			unblock?.();
		}
	});

	it("cancels a response body when headers exceed the bound", async () => {
		let canceled = 0;
		const f = fixture(
			() => () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							canceled++;
						},
					}),
					{ headers: { "x-big": "a".repeat(16_385) } },
				),
		);
		expect((await f.app.fetch(new Request("https://app.test/"))).status).toBe(
			503,
		);
		expect(canceled).toBe(1);
	});

	it("accepts the exact response chunk bound and rejects one more", async () => {
		const make = (count: number) =>
			fixture(
				() => () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								for (let i = 0; i < count; i++)
									controller.enqueue(new Uint8Array([1]));
								controller.close();
							},
						}),
					),
			);
		const exact = await make(1024).app.fetch(new Request("https://app.test/"));
		expect(exact.status).toBe(200);
		expect((await exact.arrayBuffer()).byteLength).toBe(1024);
		expect(
			(await make(1025).app.fetch(new Request("https://app.test/"))).status,
		).toBe(503);
	});

	it("bounds response bodies and avoids assimilating a handler response", async () => {
		let getterCalls = 0;
		const f = fixture(() => () => {
			const response = new Response("ok");
			/* oxlint-disable unicorn/no-thenable -- SAFETY: the test supplies a hostile then getter. */
			// biome-ignore lint/suspicious/noThenProperty: exercise promise assimilation protection.
			Object.defineProperty(response, "then", {
				get() {
					getterCalls++;
					throw new Error("unexpected");
				},
			});
			/* oxlint-enable unicorn/no-thenable */
			return response;
		});
		expect(
			await (await f.app.fetch(new Request("https://app.test/"))).text(),
		).toBe("ok");
		expect(getterCalls).toBe(0);
		const cookies = fixture(
			() => () =>
				new Response("ok", {
					headers: [
						["set-cookie", "a=1"],
						["set-cookie", "b=2"],
					],
				}),
		);
		expect(
			(
				await cookies.app.fetch(new Request("https://app.test/"))
			).headers.getSetCookie(),
		).toEqual(["a=1", "b=2"]);
		const mismatch = fixture(
			() => () => new Response("ok", { headers: { "content-length": "3" } }),
		);
		expect(
			(await mismatch.app.fetch(new Request("https://app.test/"))).status,
		).toBe(503);
		const head = fixture(
			() => () => new Response(null, { headers: { "content-length": "3" } }),
		);
		expect(
			(
				await head.app.fetch(
					new Request("https://app.test/", { method: "HEAD" }),
				)
			).status,
		).toBe(200);
		const headers = fixture(
			() => () =>
				new Response("ok", { headers: { "x-big": "a".repeat(16_385) } }),
		);
		expect(
			(await headers.app.fetch(new Request("https://app.test/"))).status,
		).toBe(503);
		const large = fixture(() => () => new Response(new Uint8Array(1_048_577)));
		expect(
			(await large.app.fetch(new Request("https://app.test/"))).status,
		).toBe(503);
	});
});
