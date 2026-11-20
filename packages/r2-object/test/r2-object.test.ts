import { createHash } from "node:crypto";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createR2ObjectClient, R2ObjectError } from "../src/index.js";

const accountId = "0123456789abcdef0123456789abcdef";
const bucket = "hobo-ci-cache";
const timestamp = Date.parse("2026-01-01T00:00:00Z");

function fixture() {
	const objects = new Map<string, { body: string; etag: string }>();
	const requests: TransportRequest[] = [];
	let loseReply = false;
	let weakReply = false;
	const transport: HttpTransport = async (request) => {
		requests.push(request);
		const current = objects.get(request.url);
		if (request.method === "GET")
			return current === undefined
				? { status: 404, headers: {}, body: "" }
				: { status: 200, headers: { etag: current.etag }, body: current.body };
		if (request.method !== "PUT" || request.body === undefined)
			throw new Error("unexpected request");
		if (
			(request.headers["if-none-match"] === "*" && current !== undefined) ||
			(request.headers["if-match"] !== undefined &&
				request.headers["if-match"] !== current?.etag)
		)
			return { status: 412, headers: {}, body: "" };
		const etag = `"${createHash("md5").update(request.body).digest("hex")}"`;
		objects.set(request.url, { body: request.body, etag });
		if (loseReply) {
			loseReply = false;
			throw new Error("transport with sensitive text");
		}
		if (weakReply) {
			weakReply = false;
			return { status: 200, headers: { etag: `W/${etag}` }, body: "" };
		}
		return { status: 200, headers: { etag }, body: "" };
	};
	const client = createR2ObjectClient({
		accountId,
		bucket,
		jurisdiction: "eu",
		transport,
		now: () => timestamp,
		maxObjectBytes: 4096,
		resolveCredentials: async () => ({
			accessKeyId: "fixture-access",
			secretAccessKey: "fixture-secret",
		}),
	});
	return {
		client,
		requests,
		loseNextReply() {
			loseReply = true;
		},
		weakenNextReply() {
			weakReply = true;
		},
	};
}

describe("R2 direct-origin conditional objects", () => {
	it("captures the account, limits and credential resolver against later mutation", async () => {
		const requests: TransportRequest[] = [];
		const options = {
			accountId,
			bucket,
			now: () => timestamp,
			maxObjectBytes: 4096,
			resolveCredentials: async () => ({
				accessKeyId: "initial-access",
				secretAccessKey: "initial-secret",
			}),
			transport: async (request: TransportRequest) => {
				requests.push(request);
				return { status: 404, headers: {}, body: "" };
			},
		};
		const client = createR2ObjectClient(options);
		Object.assign(options, {
			bucket: "foreign-bucket",
			maxObjectBytes: 8_000_000,
			now: () => -1,
			resolveCredentials: async () => ({
				accessKeyId: "foreign-access",
				secretAccessKey: "foreign-secret",
			}),
		});
		await client.get("state/key");
		expect(requests[0]?.url).toContain(`/${bucket}/state/key`);
		expect(requests[0]?.headers.Authorization).toContain(
			"Credential=initial-access/",
		);
		expect(requests[0]?.maxResponseBytes).toBe(4096);
	});
	it("signs access to the exact account, jurisdiction and bucket with the required condition", async () => {
		const { client, requests } = fixture();
		expect(await client.get("state/key")).toBeUndefined();
		const first = await client.put("state/key", "one", { kind: "absent" });
		expect(first.applied).toBe(true);
		expect(await client.put("state/key", "two", { kind: "absent" })).toEqual({
			applied: false,
		});
		const old = await client.get("state/key");
		if (!old) throw new Error("missing created object");
		expect(
			(await client.put("state/key", "two", { kind: "match", etag: old.etag }))
				.applied,
		).toBe(true);
		expect(
			await client.put("state/key", "stale", { kind: "match", etag: old.etag }),
		).toEqual({ applied: false });
		expect(await client.get("state/key")).toMatchObject({ body: "two" });
		for (const request of requests) {
			expect(request.url).toBe(
				`https://${accountId}.eu.r2.cloudflarestorage.com/${bucket}/state/key`,
			);
			expect(request.headers.Authorization).toContain("/auto/s3/aws4_request");
			expect(JSON.stringify(request)).not.toContain("fixture-secret");
		}
	});

	it("does not report success or conflict when a write commits but its response is lost", async () => {
		const { client, loseNextReply } = fixture();
		loseNextReply();
		await expect(
			client.put("state/key", "committed", { kind: "absent" }),
		).rejects.toMatchObject({ reason: "write-outcome-unknown" });
		expect(await client.get("state/key")).toMatchObject({ body: "committed" });
		expect(await client.put("state/key", "late", { kind: "absent" })).toEqual({
			applied: false,
		});
	});

	it("reports an applied write as applied when the acknowledgment carries no strong ETag", async () => {
		const { client, weakenNextReply } = fixture();
		weakenNextReply();
		expect(
			await client.put("state/key", "committed", { kind: "absent" }),
		).toEqual({ applied: true });
		expect(await client.get("state/key")).toMatchObject({ body: "committed" });
	});

	it("bounds object sizes and refuses malformed coordinates and non-conditional writes", async () => {
		const { client, requests } = fixture();
		await expect(client.get("../outside")).rejects.toMatchObject({
			reason: "invalid-object-key",
		});
		await expect(
			client.put("state/key", "x".repeat(4097), { kind: "absent" }),
		).rejects.toMatchObject({ reason: "object-too-large" });
		// Simulate an untyped caller at the public JavaScript boundary.
		await expect(
			client.put("state/key", "value", JSON.parse("null")),
		).rejects.toMatchObject({ reason: "condition-required" });
		expect(requests).toHaveLength(0);
		expect(() =>
			createR2ObjectClient({
				accountId: "evil.example",
				bucket,
				transport: async () => {
					throw new Error("must not send");
				},
				now: () => timestamp,
				maxObjectBytes: 4096,
				resolveCredentials: async () => ({
					accessKeyId: "a",
					secretAccessKey: "b",
				}),
			}),
		).toThrow(R2ObjectError);
	});
});
