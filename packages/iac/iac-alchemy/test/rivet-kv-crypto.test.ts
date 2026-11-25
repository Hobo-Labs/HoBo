import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createRivetAsyncKvClient } from "../src/rivet-kv.js";

describe("Rivet KV local request failures", () => {
	it.each([
		"randomUUID",
		"createHash",
	] as const)("reports pre-dispatch unavailability when %s fails", async (primitive) => {
		let calls = 0;
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: `sha256:${"a".repeat(64)}`,
			verifyTransport: () => {
				calls++;
				return true;
			},
			fetch: async () => {
				calls++;
				return new Response();
			},
		});
		const spy = vi.spyOn(crypto, primitive).mockImplementation(() => {
			throw new Error("crypto unavailable");
		});
		syncBuiltinESMExports();
		try {
			expect(await client.set("k", Uint8Array.of(1))).toEqual({
				status: "denied",
				code: "unavailable",
			});
			expect(calls).toBe(0);
		} finally {
			spy.mockRestore();
			syncBuiltinESMExports();
		}
	});
	it("returns unknown without disclosure if hashing the received bytes fails", async () => {
		let hashes = 0;
		let fetches = 0;
		const phases: string[] = [];
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: `sha256:${"a".repeat(64)}`,
			verifyTransport: (claim) => {
				phases.push(claim.phase);
				return true;
			},
			fetch: async () => {
				fetches++;
				return new Response("{}");
			},
		});
		const original = crypto.createHash;
		const spy = vi
			.spyOn(crypto, "createHash")
			.mockImplementation((algorithm, options) => {
				if (++hashes === 3) throw new Error("receipt hash unavailable");
				return original(algorithm, options);
			});
		syncBuiltinESMExports();
		try {
			expect(await client.get("k")).toMatchObject({
				status: "unknown",
				code: "outcome-unknown",
			});
			expect(fetches).toBe(1);
			expect(phases).toEqual(["dispatch"]);
		} finally {
			spy.mockRestore();
			syncBuiltinESMExports();
		}
	});
	it("lets a host gate reject a colliding UUID before a second dispatch", async () => {
		const enrolled = new Map<string, string>();
		let calls = 0;
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: `sha256:${"a".repeat(64)}`,

			verifyTransport: (claim) => {
				if (claim.phase !== "dispatch") return false;
				if (enrolled.has(claim.requestId)) return false;
				enrolled.set(claim.requestId, claim.fingerprint);
				return true;
			},
			fetch: async () => {
				calls++;
				throw new Error("reply lost");
			},
		});
		const spy = vi
			.spyOn(crypto, "randomUUID")
			.mockReturnValue("00000000-0000-4000-8000-000000000000");
		syncBuiltinESMExports();
		try {
			const first = await client.set("first", Uint8Array.of(1));
			const second = await client.set("first", Uint8Array.of(1));
			expect(first).toMatchObject({
				status: "unknown",
				operation: { requestId: "00000000-0000-4000-8000-000000000000" },
			});
			expect(second).toEqual({ status: "denied", code: "unavailable" });
			expect(calls).toBe(1);
			expect(enrolled.size).toBe(1);
		} finally {
			spy.mockRestore();
			syncBuiltinESMExports();
		}
	});
	it("charges synchronous request setup against the original deadline", async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const { createRivetAsyncKvClient: createClient } = await import(
			"../src/rivet-kv.js"
		);
		let dispatches = 0;
		const client = createClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: `sha256:${"a".repeat(64)}`,
			verifyTransport: () => new Promise<boolean>(() => {}),
			fetch: async () => {
				dispatches++;
				return new Response();
			},
		});
		const original = crypto.randomUUID;
		const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
			return original();
		});
		syncBuiltinESMExports();
		try {
			const pending = client.set("k", Uint8Array.of(1));
			await vi.advanceTimersByTimeAsync(9_900);
			const result = await Promise.race([
				pending,
				Promise.resolve("still-pending"),
			]);
			expect(result).toEqual({ status: "denied", code: "unavailable" });
			expect(dispatches).toBe(0);
		} finally {
			spy.mockRestore();
			syncBuiltinESMExports();
			vi.useRealTimers();
			vi.resetModules();
		}
	});
});
