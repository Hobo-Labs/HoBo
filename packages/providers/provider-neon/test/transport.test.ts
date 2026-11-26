import { describe, expect, it } from "vitest";

import type { NeonProviderError } from "../src/errors.js";
import {
	assertAllowedEndpoint,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
} from "../src/transport.js";
import { createStubTransport } from "./harness.js";

const OK = { status: 200, body: "{}" };

describe("assertAllowedEndpoint", () => {
	it("accepts the documented official endpoint", () => {
		const url = assertAllowedEndpoint(
			"https://neon.new/api/v1/database",
			DEFAULT_TRANSPORT_POLICY,
		);
		expect(url.hostname).toBe("neon.new");
	});

	it.each([
		["http://neon.new/api/v1/database", /https/u],
		["https://neon.new.attacker.example/api/v1/database", /allowlisted/u],
		["https://user:pass@neon.new/api/v1/database", /userinfo/u],
		["https://neon.new:8443/api/v1/database", /default https port/u],
		["https://neon.new/internal/debug", /allowlisted/u],
	])("rejects %s", (url, message) => {
		expect(() =>
			assertAllowedEndpoint(url, DEFAULT_TRANSPORT_POLICY),
		).toThrowError(message);
	});
});

describe("createGuardedTransport", () => {
	it("refuses to follow a redirect to another host", async () => {
		const transport = createGuardedTransport(
			createStubTransport([
				{
					status: 302,
					body: "",
					headers: { location: "https://attacker.example/api/v1/database" },
				},
			]),
		);
		await expect(
			transport.request({
				method: "POST",
				url: "https://neon.new/api/v1/database",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrowError(/never follows/u);
	});

	it("caps the response body", async () => {
		const transport = createGuardedTransport(
			createStubTransport([{ status: 200, body: "x".repeat(4096) }]),
			{ ...DEFAULT_TRANSPORT_POLICY, maxResponseBytes: 512 },
		);
		await expect(
			transport.request({
				method: "GET",
				url: "https://neon.new/api/v1/database/x",
				headers: {},
				timeoutMs: 1000,
				// Within policy on purpose: the point of this case is the
				// *response* being oversized, not the request asking for too
				// much. Asking for 4096 against a 512 policy is now refused
				// before the body is ever fetched, which the case below covers.
				maxResponseBytes: 512,
			}),
		).rejects.toThrowError(/exceeded the 512 byte cap/u);
	});

	it("refuses a request that asks for more than the policy cap", async () => {
		const transport = createGuardedTransport(createStubTransport([OK]), {
			...DEFAULT_TRANSPORT_POLICY,
			maxResponseBytes: 512,
		});
		await expect(
			transport.request({
				method: "GET",
				url: "https://neon.new/api/v1/database/x",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 4096,
			}),
		).rejects.toThrowError(/exceeds the policy cap/u);
	});

	it("rejects an over-large declared content-length before reading further", async () => {
		const transport = createGuardedTransport(
			createStubTransport([
				{ status: 200, body: "{}", headers: { "content-length": "1048576" } },
			]),
		);
		await expect(
			transport.request({
				method: "GET",
				url: "https://neon.new/api/v1/database/x",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrowError(/over the/u);
	});

	it("refuses a caller timeout above the policy ceiling instead of clamping", async () => {
		// This used to silently rewrite a ten-minute request to two seconds and
		// carry on. Quietly honouring something other than what was asked for
		// hides a misconfiguration; the shared guard refuses and says so.
		const inner = createStubTransport([OK]);
		const transport = createGuardedTransport(inner, {
			...DEFAULT_TRANSPORT_POLICY,
			timeoutMs: 2000,
		});
		await expect(
			transport.request({
				method: "GET",
				url: "https://neon.new/api/v1/database/x",
				headers: {},
				timeoutMs: 10 * 60 * 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrowError(/exceeds the policy cap/u);
		expect(inner.requests).toHaveLength(0);
	});

	it("passes a within-policy timeout through untouched", async () => {
		const inner = createStubTransport([OK]);
		const transport = createGuardedTransport(inner, {
			...DEFAULT_TRANSPORT_POLICY,
			timeoutMs: 2000,
		});
		await transport.request({
			method: "GET",
			url: "https://neon.new/api/v1/database/x",
			headers: {},
			timeoutMs: 1500,
			maxResponseBytes: 1024,
		});
		expect(inner.requests[0]?.timeoutMs).toBe(1500);
	});
});

describe("createFetchTransport", () => {
	it("uses only the injected fetch and never follows redirects", async () => {
		const calls: RequestInit[] = [];
		const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
			calls.push(init ?? {});
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const transport = createFetchTransport({ fetchImpl });
		const response = await transport.request({
			method: "GET",
			url: "https://neon.new/api/v1/database/x",
			headers: { accept: "application/json" },
			timeoutMs: 1000,
			maxResponseBytes: 1024,
		});
		expect(response.status).toBe(200);
		expect(calls[0]?.redirect).toBe("manual");
	});

	it("reports a dropped request as ambiguous, never as a failure to create", async () => {
		const fetchImpl: typeof globalThis.fetch = async () => {
			throw new Error("socket hang up");
		};
		const transport = createFetchTransport({ fetchImpl });
		try {
			await transport.request({
				method: "POST",
				url: "https://neon.new/api/v1/database",
				headers: {},
				body: "{}",
				timeoutMs: 50,
				maxResponseBytes: 1024,
			});
			expect.unreachable("a dropped request must throw");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as NeonProviderError).code).toBe(
				"PROVIDER_OPERATION_AMBIGUOUS",
			);
		}
	});
});
