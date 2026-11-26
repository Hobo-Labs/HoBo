import { describe, expect, it } from "vitest";
import {
	AGENT37_MAX_REQUEST_BYTES,
	createAgent37Transport,
} from "../src/index.js";

const request = {
	method: "GET" as const,
	url: "https://api.agent37.com/v1/instances",
	headers: {},
	timeoutMs: 20_000,
	maxResponseBytes: 4096,
};

function jsonResponse(
	status: number,
	code = "internal_error",
	retryAfter?: string,
) {
	const headers = new Headers({ "content-type": "application/json" });
	if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
	return new Response(JSON.stringify({ error: { code, message: "fixture" } }), {
		status,
		headers,
	});
}

describe("Agent37 transport authority and bounds", () => {
	it("allows only documented HTTPS origins and /v1 paths", async () => {
		const hosts: string[] = [];
		const transport = createAgent37Transport({
			fetchImpl: async (input) => {
				hosts.push(new URL(new Request(input).url).host);
				return jsonResponse(200);
			},
		});
		await transport(request);
		await transport({
			...request,
			url: "https://sandbox.agent37.app/v1/instances/i_one/exec",
		});
		expect(hosts).toEqual(["api.agent37.com", "sandbox.agent37.app"]);
		for (const url of [
			"http://api.agent37.com/v1/instances",
			"https://evil.example/v1/instances",
			"https://api.agent37.com.evil.example/v1/instances",
			"https://api.agent37.com:444/v1/instances",
			"https://api.agent37.com/v2/instances",
			"https://api.agent37.com/v1/instances/%2f%2e%2e%2fusage",
		]) {
			await expect(transport({ ...request, url })).rejects.toMatchObject({
				name: "TransportGuardError",
			});
		}
		expect(hosts).toHaveLength(2);
	});

	it("uses manual redirect handling and refuses redirect responses", async () => {
		let redirect: RequestRedirect | undefined;
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async (_input, init) => {
				calls += 1;
				redirect = init?.redirect;
				return new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/v1/instances" },
				});
			},
		});
		await expect(transport(request)).rejects.toMatchObject({
			name: "TransportGuardError",
			code: "TRANSPORT_REDIRECT_REFUSED",
		});
		expect(redirect).toBe("manual");
		expect(calls).toBe(1);
	});

	it("rejects streamed responses above the per-request byte bound", async () => {
		const transport = createAgent37Transport({
			fetchImpl: async () => new Response("x".repeat(200)),
		});
		await expect(
			transport({ ...request, maxResponseBytes: 100 }),
		).rejects.toMatchObject({ code: "TRANSPORT_BODY_TOO_LARGE" });
	});

	it("rejects oversized request bodies before fetch", async () => {
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse(200);
			},
		});
		await expect(
			transport({
				...request,
				method: "POST",
				url: "https://sandbox.agent37.app/v1/instances/i_one/exec",
				body: "x".repeat(AGENT37_MAX_REQUEST_BYTES + 1),
			}),
		).rejects.toThrow("request body exceeds");
		expect(calls).toBe(0);
	});
});

describe("Agent37 transport retries", () => {
	it.each([
		[503, "no_capacity"],
		[409, "try_again"],
		[500, "internal_error"],
		[502, "provisioning_failed"],
	])("retries GET after %i %s with jitter", async (status, code) => {
		let calls = 0;
		const delays: number[] = [];
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1 ? jsonResponse(status, code) : jsonResponse(200);
			},
			retryBaseDelayMs: 100,
			random: () => 0.5,
			sleep: async (delay) => {
				delays.push(delay);
			},
		});
		expect((await transport(request)).status).toBe(200);
		expect(calls).toBe(2);
		expect(delays).toEqual([150]);
	});

	it("retries HEAD", async () => {
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1 ? jsonResponse(500) : jsonResponse(200);
			},
			sleep: async () => {},
		});
		expect((await transport({ ...request, method: "HEAD" })).status).toBe(200);
		expect(calls).toBe(2);
	});

	it.each([
		[429, "rate_limited"],
		[402, "insufficient_balance"],
		[409, "instance_limit_reached"],
		[400, "invalid_request"],
		[401, "invalid_api_key"],
	])("does not retry %i %s", async (status, code) => {
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse(status, code);
			},
			sleep: async () => {
				throw new Error("unexpected retry");
			},
		});
		expect((await transport(request)).status).toBe(status);
		expect(calls).toBe(1);
	});

	it.each([
		"POST",
		"DELETE",
	] as const)("never automatically replays %s", async (method) => {
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse(503, "no_capacity");
			},
			sleep: async () => {
				throw new Error("unexpected retry");
			},
		});
		const response = await transport({
			...request,
			method,
			url:
				method === "POST"
					? "https://sandbox.agent37.app/v1/instances/i_one/exec"
					: request.url,
		});
		expect(response.status).toBe(503);
		expect(calls).toBe(1);
	});

	it("does not retry ambiguous network failures", async () => {
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				throw new Error("connection reset");
			},
		});
		await expect(transport(request)).rejects.toThrow("connection reset");
		expect(calls).toBe(1);
	});

	it("honors numeric Retry-After", async () => {
		const delays: number[] = [];
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1
					? jsonResponse(503, "no_capacity", "2")
					: jsonResponse(200);
			},
			retryBaseDelayMs: 100,
			sleep: async (delay) => {
				delays.push(delay);
			},
		});
		await transport(request);
		expect(delays).toEqual([2000]);
	});

	it("honors HTTP-date Retry-After with an injected clock", async () => {
		const delays: number[] = [];
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1
					? jsonResponse(503, "no_capacity", "Fri, 20 Nov 2026 00:00:03 GMT")
					: jsonResponse(200);
			},
			now: () => Date.parse("2026-11-20T00:00:00.000Z"),
			sleep: async (delay) => {
				delays.push(delay);
			},
		});
		await transport(request);
		expect(delays).toEqual([3000]);
	});

	it("stops at the configured attempt bound", async () => {
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse(503);
			},
			maxAttempts: 2,
			sleep: async () => {},
		});
		expect((await transport(request)).status).toBe(503);
		expect(calls).toBe(2);
	});

	it("caps each delay and the cumulative retry window", async () => {
		const delays: number[] = [];
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse(503, "no_capacity", "600000");
			},
			maxAttempts: 4,
			sleep: async (delay) => {
				delays.push(delay);
			},
		});
		expect((await transport(request)).status).toBe(503);
		expect(calls).toBe(2);
		expect(delays).toEqual([905000]);
	});
});
