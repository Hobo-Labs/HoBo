/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these tests intentionally replace the platform timer. */
import { expect, it, vi } from "vitest";
import { cloudflareKvProxy } from "../src/cloudflare-kv-proxy.js";
import writer from "./fixtures/cloudflare-kv-writer-app.js";

type TimerFailure = "setup-failure" | "early-fire";

function failNextTimer(mode: TimerFailure) {
	const timer = vi.spyOn(globalThis, "setTimeout");
	if (mode === "setup-failure")
		timer.mockImplementationOnce(() => {
			throw new Error("timer unavailable");
		});
	else
		timer.mockImplementationOnce((callback) => {
			callback();
			return 0 as never;
		});
	return timer;
}

it.each([
	"setup-failure",
	"early-fire",
] as const)("does not dispatch native KV work when its timer has %s", async (mode) => {
	const get = vi.fn(async () => null);
	const native = {
		get,
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	};
	const request = new Request("https://hobo-kv.internal/get", {
		method: "POST",
		headers: { "x-hobo-kv-key": "key" },
	});
	vi.resetModules();
	const timer = failNextTimer(mode);
	let response: Response;
	try {
		const { cloudflareKvProxy: timedProxy } = await import(
			"../src/cloudflare-kv-proxy.js"
		);
		response = await timedProxy.fetch(request, {
			HOBO_KV_MODE: "read-only",
			HOBO_KV_ALLOW: "get",
			HOBO_KV_NAMESPACE: native,
		});
	} finally {
		timer.mockRestore();
	}
	expect(response.status).toBe(502);
	expect(get).not.toHaveBeenCalled();
});

it.each([
	"setup-failure",
	"early-fire",
] as const)("does not pull a KV byte stream when its timer has %s", async (mode) => {
	let pulls = 0;
	let cancellations = 0;
	const stream = new ReadableStream<Uint8Array>({
		type: "bytes",
		pull(controller) {
			pulls++;
			controller.close();
		},
		cancel() {
			cancellations++;
		},
	});
	vi.resetModules();
	const timer = failNextTimer(mode);
	try {
		const { readCloudflareKvBytes: timedRead } = await import(
			"../src/cloudflare-kv-protocol.js"
		);
		await expect(timedRead(stream)).rejects.toThrow();
	} finally {
		timer.mockRestore();
	}
	expect(pulls).toBe(0);
	expect(cancellations).toBe(1);
});

it.each([
	"setup-failure",
	"early-fire",
] as const)("does not dispatch a KV service mutation when its timer has %s", async (mode) => {
	const fetch = vi.fn(async () => new Response(null, { status: 204 }));
	const request = new Request("https://application.test/");
	vi.resetModules();
	const timer = failNextTimer(mode);
	try {
		const { default: timedWriter } = await import(
			"./fixtures/cloudflare-kv-writer-app.js"
		);
		await expect(
			timedWriter.fetch(request, { HOBO_RESOURCE_0: { fetch } }),
		).rejects.toMatchObject({
			code: "KV_MUTATION_OUTCOME_UNKNOWN",
		});
	} finally {
		timer.mockRestore();
	}
	expect(fetch).not.toHaveBeenCalled();
});

it("retires a native KV read that resolves after its timeout", async () => {
	vi.useFakeTimers();
	vi.resetModules();
	let finish: (value: ReadableStream<Uint8Array>) => void = () => {};
	const result = new Promise<ReadableStream<Uint8Array>>((resolve) => {
		finish = resolve;
	});
	const get = vi.fn(() => result);
	let cancellations = 0;
	try {
		const { cloudflareKvProxy: timedProxy } = await import(
			"../src/cloudflare-kv-proxy.js"
		);
		const pending = timedProxy.fetch(
			new Request("https://hobo-kv.internal/get", {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
			}),
			{
				HOBO_KV_MODE: "read-only",
				HOBO_KV_ALLOW: "get",
				HOBO_KV_NAMESPACE: {
					get,
					put: vi.fn(async () => {}),
					delete: vi.fn(async () => {}),
				},
			},
		);
		for (let tick = 0; tick < 100 && get.mock.calls.length === 0; tick++)
			await Promise.resolve();
		expect(get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await pending).status).toBe(502);
		finish(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancellations++;
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(cancellations).toBe(1);
		expect(get).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("bounds a native mutation wait without claiming the timed-out write stopped", async () => {
	vi.useFakeTimers();
	vi.resetModules();
	try {
		const { cloudflareKvProxy: timedProxy } = await import(
			"../src/cloudflare-kv-proxy.js"
		);
		let finish: (() => void) | undefined;
		let completed = false;
		const result = timedProxy.fetch(
			new Request("https://hobo-kv.internal/set", {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
			}),
			{
				HOBO_KV_MODE: "write-only",
				HOBO_KV_ALLOW: "set",
				HOBO_KV_NAMESPACE: {
					get: async () => null,
					delete: async () => {},
					async put() {
						await new Promise<void>((resolve) => {
							finish = resolve;
						});
						completed = true;
					},
				},
			},
		);
		for (let tick = 0; tick < 100 && finish === undefined; tick++)
			await Promise.resolve();
		expect(finish).toBeDefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await result).status).toBe(502);
		expect(completed).toBe(false);
		finish?.();
		await vi.runAllTicks();
		expect(completed).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

it("transfers saturated late KV reads to cancellation and recovers capacity", async () => {
	vi.useFakeTimers();
	vi.resetModules();
	try {
		const { cloudflareKvProxy: timedProxy } = await import(
			"../src/cloudflare-kv-proxy.js"
		);
		const { CLOUDFLARE_NATIVE_MAX_OUTSTANDING: maximum } = await import(
			"../src/cloudflare-capacity.js"
		);
		const finish: ((stream: ReadableStream<Uint8Array>) => void)[] = [];
		let cancellations = 0;
		const get = vi.fn(
			() =>
				new Promise<ReadableStream<Uint8Array>>((resolve) => {
					finish.push(resolve);
				}),
		);
		const environment = {
			HOBO_KV_MODE: "read-only" as const,
			HOBO_KV_ALLOW: "get" as const,
			HOBO_KV_NAMESPACE: {
				get,
				put: async () => {},
				delete: async () => {},
			},
		};
		const request = () =>
			new Request("https://hobo-kv.internal/get", {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
			});
		const pending = Array.from({ length: maximum }, () =>
			timedProxy.fetch(request(), environment),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(get).toHaveBeenCalledTimes(maximum);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(
			(await Promise.all(pending)).every((response) => response.status === 502),
		).toBe(true);
		for (const resolve of finish)
			resolve(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancellations++;
					},
				}),
			);
		await vi.advanceTimersByTimeAsync(0);
		expect(cancellations).toBe(maximum);
		const fresh = {
			...environment,
			HOBO_KV_NAMESPACE: {
				...environment.HOBO_KV_NAMESPACE,
				get: async () => null,
			},
		};
		expect((await timedProxy.fetch(request(), fresh)).status).toBe(404);
	} finally {
		vi.useRealTimers();
	}
});

it("retires a late service response and keeps a mutation outcome unknown", async () => {
	vi.useFakeTimers();
	vi.resetModules();
	let finish: (value: Response) => void = () => {};
	const result = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	const fetch = vi.fn(() => result);
	let cancellations = 0;
	try {
		const { default: timedWriter } = await import(
			"./fixtures/cloudflare-kv-writer-app.js"
		);
		const pending = timedWriter.fetch(
			new Request("https://application.test/"),
			{
				HOBO_RESOURCE_0: { fetch },
			},
		);
		const observed = expect(pending).rejects.toMatchObject({
			code: "KV_MUTATION_OUTCOME_UNKNOWN",
		});
		for (let tick = 0; tick < 100 && fetch.mock.calls.length === 0; tick++)
			await Promise.resolve();
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		await observed;
		finish(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancellations++;
					},
				}),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(cancellations).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("retires an error response body while preserving mutation uncertainty", async () => {
	let cancellations = 0;
	const fetch = vi.fn(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancellations++;
					},
				}),
				{ status: 502 },
			),
	);
	await expect(
		writer.fetch(new Request("https://application.test/"), {
			HOBO_RESOURCE_0: { fetch },
		}),
	).rejects.toMatchObject({ code: "KV_MUTATION_OUTCOME_UNKNOWN" });
	expect(cancellations).toBe(1);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("observes a deadline fired by a native callback that then throws", async () => {
	let expire = () => {};
	const timer = vi
		.spyOn(globalThis, "setTimeout")
		.mockImplementationOnce((callback) => {
			expire = callback;
			return 0 as never;
		});
	const get = vi.fn(() => {
		expire();
		throw new Error("native request failed");
	});
	try {
		const response = await cloudflareKvProxy.fetch(
			new Request("https://hobo-kv.internal/get", {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
			}),
			{
				HOBO_KV_MODE: "read-only",
				HOBO_KV_ALLOW: "get",
				HOBO_KV_NAMESPACE: {
					get,
					put: vi.fn(async () => {}),
					delete: vi.fn(async () => {}),
				},
			},
		);
		expect(response.status).toBe(502);
		expect(get).toHaveBeenCalledTimes(1);
	} finally {
		timer.mockRestore();
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
});
