import { describe, expect, it } from "vitest";
import { createAgent37Transport } from "../src/index.js";

const request = {
	method: "GET" as const,
	url: "https://api.agent37.com/v1/instances",
	headers: {},
	timeoutMs: 20_000,
	maxResponseBytes: 64 * 1024,
};

function jsonResponse(
	status: number,
	code = "internal_error",
	retryAfter?: string,
) {
	const headers = new Headers({ "content-type": "application/json" });
	if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
	return new Response(JSON.stringify({ error: { code, message: "test" } }), {
		status,
		headers,
	});
}

describe("Agent37 transport", () => {
	it("allows only the two documented HTTPS hosts", async () => {
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
			url: "https://sandbox.agent37.app/v1/instances/i_test/exec",
		});
		expect(hosts).toEqual(["api.agent37.com", "sandbox.agent37.app"]);

		for (const url of [
			"https://evil.example/v1/instances",
			"http://api.agent37.com/v1/instances",
			"https://api.agent37.com.evil.example/v1/instances",
		]) {
			await expect(transport({ ...request, url })).rejects.toMatchObject({
				name: "TransportGuardError",
			});
		}
		expect(hosts).toHaveLength(2);
	});

	it.each([
		[503, "no_capacity"],
		[409, "try_again"],
		[500, "internal_error"],
		[502, "provisioning_failed"],
	])("retries %i %s with jitter", async (status, code) => {
		let calls = 0;
		const delays: number[] = [];
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1 ? jsonResponse(status, code) : jsonResponse(200);
			},
			retryBaseDelayMs: 100,
			random: () => 0.5,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		expect((await transport(request)).status).toBe(200);
		expect(calls).toBe(2);
		expect(delays).toEqual([150]);
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

	it("honors numeric Retry-After over exponential jitter", async () => {
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
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		await transport(request);
		expect(delays).toEqual([2_000]);
	});

	it("honors HTTP-date Retry-After using the injected clock", async () => {
		const delays: number[] = [];
		let calls = 0;
		const now = Date.parse("2026-11-20T00:00:00.000Z");
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1
					? jsonResponse(503, "no_capacity", "Fri, 20 Nov 2026 00:00:03 GMT")
					: jsonResponse(200);
			},
			now: () => now,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		await transport(request);
		expect(delays).toEqual([3_000]);
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

	it("does not retry an ambiguous transport failure", async () => {
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

	it.each([
		[503, "no_capacity"],
		[409, "try_again"],
		[500, "internal_error"],
	])("does not replay a non-idempotent POST after %i %s", async (status, code) => {
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
		const response = await transport({
			...request,
			method: "POST",
			url: "https://sandbox.agent37.app/v1/instances/i_test/exec",
			body: JSON.stringify({ command: "printf ready" }),
		});
		expect(response.status).toBe(status);
		expect(calls).toBe(1);
	});

	it("caps Retry-After at the transport timeout bound", async () => {
		const delays: number[] = [];
		let calls = 0;
		const transport = createAgent37Transport({
			fetchImpl: async () => {
				calls += 1;
				return calls === 1
					? jsonResponse(503, "no_capacity", "1000000")
					: jsonResponse(200);
			},
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		await transport(request);
		expect(delays).toEqual([905_000]);
	});
});
