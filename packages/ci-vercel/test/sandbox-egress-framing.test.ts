import { describe, expect, it } from "vitest";
import { createVerifiedSandboxEgressHandler } from "../src/sandbox-egress-proxy.js";

const metadata = {
	host: "relay.example",
	teamId: "team-1",
	projectId: "project-1",
	sandboxId: "sbx_123",
	sandboxName: "ci-123",
};

function handler(
	transport: Parameters<
		typeof createVerifiedSandboxEgressHandler
	>[0]["transport"],
	timeoutMs?: number,
) {
	return createVerifiedSandboxEgressHandler({
		teamId: metadata.teamId,
		projectId: metadata.projectId,
		hosts: ["github.com"],
		ledger: {
			async reserveSandboxEgress() {
				return true;
			},
		},
		resolve: async () => ["8.8.8.8"],
		transport,
		timeoutMs,
	});
}

describe("sandbox egress HTTP framing", () => {
	it("preserves a verified fixed upload length for upstream storage APIs", async () => {
		const seen: { length: string | null; body: string }[] = [];
		const proxy = handler(async (input) => {
			seen.push({
				length: input.headers.get("content-length"),
				body: input.body ? await new Response(input.body).text() : "",
			});
			return new Response(null, { status: 201 });
		});
		const result = await proxy(
			new Request("https://github.com/upload", {
				method: "PUT",
				headers: { "content-length": "4" },
				body: "test",
			}),
			metadata,
		);
		expect(result.status).toBe(201);
		expect(seen).toEqual([{ length: "4", body: "test" }]);
	});

	it("allows streamed uploads without inventing a fixed content length", async () => {
		let observed = "";
		const proxy = handler(async (input) => {
			expect(input.headers.has("content-length")).toBe(false);
			observed = input.body ? await new Response(input.body).text() : "";
			return new Response(null, { status: 204 });
		});
		const result = await proxy(
			new Request("https://github.com/upload", {
				method: "POST",
				body: "chunks",
			}),
			metadata,
		);
		expect(result.status).toBe(204);
		expect(observed).toBe("chunks");
	});

	it.each([
		["3", "four"],
		["5", "four"],
	])("rejects an upload whose declared length %s differs from its body", async (length, body) => {
		const proxy = handler(async (input) => {
			if (input.body) await new Response(input.body).arrayBuffer();
			return new Response(null, { status: 201 });
		});

		const result = await proxy(
			new Request("https://github.com/upload", {
				method: "PUT",
				headers: { "content-length": length },
				body,
			}),
			metadata,
		);
		expect(result.status).toBeGreaterThanOrEqual(400);
	});

	it("rejects ambiguous transfer framing before contacting upstream", async () => {
		let contacted = false;
		const proxy = handler(async () => {
			contacted = true;
			return new Response(null, { status: 201 });
		});
		const result = await proxy(
			new Request("https://github.com/upload", {
				method: "PUT",
				headers: { "content-length": "4", "transfer-encoding": "chunked" },
				body: "test",
			}),
			metadata,
		);
		expect(result.status).toBeGreaterThanOrEqual(400);
		expect(contacted).toBe(false);
	});

	it("rejects a content length nominated as a hop-by-hop header", async () => {
		let contacted = false;
		const proxy = handler(async () => {
			contacted = true;
			return new Response(null, { status: 201 });
		});
		const result = await proxy(
			new Request("https://github.com/upload", {
				method: "PUT",
				headers: { "content-length": "4", connection: "Content-Length" },
				body: "test",
			}),
			metadata,
		);
		expect(result.status).toBeGreaterThanOrEqual(400);
		expect(contacted).toBe(false);
	});

	it("rejects an early successful upstream response and cancels the source", async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel() {
				cancelled = true;
			},
		});
		const proxy = handler(async (input) => {
			if (!input.body) throw new Error("missing body");
			void new Response(input.body).arrayBuffer().catch(() => {});
			return new Response(null, { status: 201 });
		});
		const init = {
			method: "PUT",
			headers: { "content-length": "5" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBeGreaterThanOrEqual(400);
		expect(cancelled).toBe(true);
	});

	it("allows a successful response after all declared bytes while EOF arrives shortly after", async () => {
		let release: (() => void) | undefined;
		let received: (() => void) | undefined;
		const eof = new Promise<void>((resolve) => {
			release = resolve;
		});
		const upstreamReceived = new Promise<void>((resolve) => {
			received = resolve;
		});
		let sent = false;
		const source = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(new TextEncoder().encode("four"));
					return;
				}
				await eof;
				controller.close();
			},
		});
		const proxy = handler(async (input) => {
			if (!input.body) throw new Error("missing body");
			const reader = input.body.getReader();
			expect((await reader.read()).value).toEqual(
				new TextEncoder().encode("four"),
			);
			void reader.read().catch(() => {});
			received?.();
			return new Response(null, { status: 201 });
		});
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const attempt = proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		await upstreamReceived;
		release?.();
		expect((await attempt).status).toBe(201);
	});

	it("cancels a stalled EOF after an early successful response", async () => {
		let cancelled = false;
		let sent = false;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(new TextEncoder().encode("four"));
					return;
				}
				return new Promise<void>(() => {});
			},
			cancel() {
				cancelled = true;
			},
		});
		const proxy = handler(async (input) => {
			if (!input.body) throw new Error("missing body");
			const reader = input.body.getReader();
			await reader.read();
			void reader.read().catch(() => {});
			return new Response(null, { status: 201 });
		});
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBe(503);
		expect(cancelled).toBe(true);
	});

	it.each([
		401, 413,
	])("preserves an early upstream %i while cancelling upload", async (status) => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				cancelled = true;
			},
		});
		const proxy = handler(
			async () =>
				new Response("rejected", {
					status,
					headers: {
						"retry-after": "60",
						"content-length": "8",
						connection: "close",
					},
				}),
		);
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBe(status);
		expect(result.headers.get("retry-after")).toBe("60");
		expect(result.headers.has("content-length")).toBe(false);
		expect(result.headers.has("connection")).toBe(false);
		expect(await result.text()).toBe("");
		expect(cancelled).toBe(true);
	});

	it("does not relay early rejection headers when the response quota is exhausted", async () => {
		let calls = 0;
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				cancelled = true;
			},
		});
		const proxy = createVerifiedSandboxEgressHandler({
			teamId: metadata.teamId,
			projectId: metadata.projectId,
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress() {
					return ++calls === 1;
				},
			},
			resolve: async () => ["8.8.8.8"],
			transport: async () =>
				new Response(null, { status: 413, headers: { "retry-after": "60" } }),
		});
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBe(503);
		expect(result.headers.has("retry-after")).toBe(false);
		expect(cancelled).toBe(true);
	});

	it("cancels the upload immediately while an early rejection waits on the quota ledger", async () => {
		let calls = 0;
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				cancelled = true;
			},
		});
		const proxy = createVerifiedSandboxEgressHandler({
			teamId: metadata.teamId,
			projectId: metadata.projectId,
			hosts: ["github.com"],
			ledger: {
				async reserveSandboxEgress() {
					if (++calls === 1) return true;
					expect(cancelled).toBe(true);
					return new Promise<boolean>(() => {});
				},
			},
			resolve: async () => ["8.8.8.8"],
			transport: async () => new Response(null, { status: 413 }),
			timeoutMs: 25,
		});
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBe(503);
		expect(calls).toBe(2);
		expect(cancelled).toBe(true);
	});

	it("fails promptly and aborts upstream if the upload source errors", async () => {
		let transportAborted = false;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("client disconnected"));
			},
		});
		const proxy = handler(async (input) => {
			if (!input.body) throw new Error("missing body");
			void new Response(input.body).arrayBuffer().catch(() => {});
			input.signal.addEventListener(
				"abort",
				() => {
					transportAborted = true;
				},
				{ once: true },
			);
			return new Promise<Response>(() => {});
		});
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBeGreaterThanOrEqual(400);
		expect(transportAborted).toBe(true);
	});

	it("cancels a pending source read when the client aborts", async () => {
		let cancelled = false;
		let started: (() => void) | undefined;
		const uploadStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const source = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				cancelled = true;
			},
		});
		const proxy = handler(async (input) => {
			if (!input.body) throw new Error("missing body");
			void new Response(input.body).arrayBuffer().catch(() => {});
			started?.();
			return new Promise<Response>(() => {});
		});
		const abort = new AbortController();
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
			signal: abort.signal,
		};
		const attempt = proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		await uploadStarted;
		abort.abort();
		expect((await attempt).status).toBeGreaterThanOrEqual(400);
		expect(cancelled).toBe(true);
	});

	it("cancels a stalled upload and upstream transport when its deadline expires", async () => {
		let cancelled = false;
		let transportAborted = false;
		const source = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				cancelled = true;
			},
		});
		const proxy = handler(async (input) => {
			if (!input.body) throw new Error("missing body");
			void new Response(input.body).arrayBuffer().catch(() => {});
			input.signal.addEventListener(
				"abort",
				() => {
					transportAborted = true;
				},
				{ once: true },
			);
			return new Promise<Response>(() => {});
		}, 25);
		const init = {
			method: "PUT",
			headers: { "content-length": "4" },
			body: source,
			duplex: "half",
		};
		const result = await proxy(
			new Request("https://github.com/upload", init),
			metadata,
		);
		expect(result.status).toBe(503);
		expect(cancelled).toBe(true);
		expect(transportAborted).toBe(true);
	});

	it("preserves object size metadata on HEAD responses", async () => {
		const proxy = handler(
			async () =>
				new Response(null, {
					status: 200,
					headers: { "content-length": "1234" },
				}),
		);
		const result = await proxy(
			new Request("https://github.com/file", { method: "HEAD" }),
			metadata,
		);
		expect(result.headers.get("content-length")).toBe("1234");
	});

	it("allows HEAD metadata for an object larger than the transfer limit", async () => {
		const proxy = handler(
			async () =>
				new Response(null, {
					status: 200,
					headers: { "content-length": "10000000" },
				}),
		);
		const result = await proxy(
			new Request("https://github.com/file", { method: "HEAD" }),
			metadata,
		);
		expect(result.status).toBe(200);
		expect(result.headers.get("content-length")).toBe("10000000");
	});

	it("preserves content length for an unchanged response body", async () => {
		const proxy = handler(
			async () =>
				new Response("data", {
					status: 200,
					headers: { "content-length": "4" },
				}),
		);
		const result = await proxy(
			new Request("https://github.com/file"),
			metadata,
		);
		expect(result.headers.get("content-length")).toBe("4");
		expect(await result.text()).toBe("data");
	});

	it("aborts a response whose declared length does not match its body", async () => {
		const proxy = handler(
			async () =>
				new Response("abc", {
					status: 200,
					headers: { "content-length": "4" },
				}),
		);
		const result = await proxy(
			new Request("https://github.com/file"),
			metadata,
		);
		await expect(result.text()).rejects.toThrow(
			"sandbox response length mismatch",
		);
	});
});
