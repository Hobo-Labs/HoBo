/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these tests intentionally replace the platform timer. */
import { expect, it, vi } from "vitest";

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
] as const)("does not dispatch native R2 work when its timer has %s", async (mode) => {
	const get = vi.fn(async () => null);
	const native = {
		get,
		put: vi.fn(async () => null),
		delete: vi.fn(async () => {}),
	};
	const request = new Request("https://hobo-r2.internal/read", {
		method: "POST",
		headers: { "x-hobo-r2-key": "key" },
	});
	vi.resetModules();
	const timer = failNextTimer(mode);
	let response: Response;
	try {
		const { cloudflareR2Proxy } = await import("../src/cloudflare-r2-proxy.js");
		response = await cloudflareR2Proxy.fetch(request, {
			HOBO_R2_ALLOW: "read",
			HOBO_R2_BUCKET: native,
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
] as const)("does not pull an R2 byte stream when its timer has %s", async (mode) => {
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
		const { readCloudflareR2Bytes } = await import(
			"../src/cloudflare-r2-protocol.js"
		);
		await expect(readCloudflareR2Bytes(stream)).rejects.toThrow();
	} finally {
		timer.mockRestore();
	}
	expect(pulls).toBe(0);
	expect(cancellations).toBe(1);
});

it.each([
	"setup-failure",
	"early-fire",
] as const)("does not dispatch an R2 service mutation when its timer has %s", async (mode) => {
	const fetch = vi.fn(
		async () =>
			new Response(null, {
				status: 204,
				headers: { "x-hobo-r2-key": "key" },
			}),
	);
	vi.resetModules();
	const timer = failNextTimer(mode);
	try {
		const { createCloudflareR2Store } = await import(
			"../src/cloudflare-r2-client.js"
		);
		const store = createCloudflareR2Store({ fetch }, ["delete"]);
		await expect(store.delete("key")).rejects.toMatchObject({
			code: "R2_MUTATION_OUTCOME_UNKNOWN",
		});
	} finally {
		timer.mockRestore();
	}
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	"setup-failure",
	"early-fire",
] as const)("does not start an R2 digest when its timer has %s", async (mode) => {
	const digest = vi
		.spyOn(crypto.subtle, "digest")
		.mockResolvedValue(new ArrayBuffer(32));
	vi.resetModules();
	const timer = failNextTimer(mode);
	let calls = 0;
	try {
		const { cloudflareR2Digest } = await import(
			"../src/cloudflare-r2-protocol.js"
		);
		await expect(
			cloudflareR2Digest(new Uint8Array([1]).buffer),
		).rejects.toMatchObject({ code: "R2_DIGEST_UNAVAILABLE" });
	} finally {
		calls = digest.mock.calls.length;
		timer.mockRestore();
		digest.mockRestore();
	}
	expect(calls).toBe(0);
});

it("observes a deadline fired by a native callback that then throws", async () => {
	let expire = () => {};
	vi.resetModules();
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
		const { cloudflareR2Proxy } = await import("../src/cloudflare-r2-proxy.js");
		const response = await cloudflareR2Proxy.fetch(
			new Request("https://hobo-r2.internal/read", {
				method: "POST",
				headers: { "x-hobo-r2-key": "key" },
			}),
			{
				HOBO_R2_ALLOW: "read",
				HOBO_R2_BUCKET: {
					get,
					put: vi.fn(async () => null),
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

it("transfers saturated late R2 reads to cancellation and recovers capacity", async () => {
	vi.useFakeTimers();
	vi.resetModules();
	try {
		const { cloudflareR2Proxy } = await import("../src/cloudflare-r2-proxy.js");
		const { CLOUDFLARE_NATIVE_MAX_OUTSTANDING: maximum } = await import(
			"../src/cloudflare-capacity.js"
		);
		const finish: ((object: {
			key: string;
			size: number;
			body: ReadableStream<Uint8Array>;
		}) => void)[] = [];
		let cancellations = 0;
		const get = vi.fn(
			() =>
				new Promise<{
					key: string;
					size: number;
					body: ReadableStream<Uint8Array>;
				}>((resolve) => {
					finish.push(resolve);
				}),
		);
		const environment = {
			HOBO_R2_ALLOW: "read",
			HOBO_R2_BUCKET: { get, put: async () => null, delete: async () => {} },
		};
		const request = () =>
			new Request("https://hobo-r2.internal/read", {
				method: "POST",
				headers: { "x-hobo-r2-key": "key" },
			});
		const pending = Array.from({ length: maximum }, () =>
			cloudflareR2Proxy.fetch(request(), environment),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(get).toHaveBeenCalledTimes(maximum);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(
			(await Promise.all(pending)).every((response) => response.status === 502),
		).toBe(true);
		for (const resolve of finish)
			resolve({
				key: "key",
				size: 1,
				body: new ReadableStream<Uint8Array>({
					cancel() {
						cancellations++;
					},
				}),
			});
		await vi.advanceTimersByTimeAsync(0);
		expect(cancellations).toBe(maximum);
		const fresh = {
			...environment,
			HOBO_R2_BUCKET: { ...environment.HOBO_R2_BUCKET, get: async () => null },
		};
		expect((await cloudflareR2Proxy.fetch(request(), fresh)).status).toBe(404);
	} finally {
		vi.useRealTimers();
	}
});
