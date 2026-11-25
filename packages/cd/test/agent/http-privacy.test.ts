import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { RESOLVED_SET_SCHEMA } from "@hobo/cloud";
import { type HttpTransport, parseFenceToken } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { SetRecordSchema } from "../../src/_generated/cd_pb.js";
import { parseResolvedSet } from "../../src/agent/http-transport.js";
import {
	createHttpTransport,
	FeedRefusedError,
	parseStationOrigin,
} from "../../src/agent/index.js";
import type { ReconcilerLease } from "../../src/ports.js";
import { asCamp, asReconciler, resolvedFor } from "../feed/fakes.js";
import { collect } from "../feed/harness.js";
import { freshSignJwk } from "./fleet-fixture.js";

const now = Date.UTC(2026, 0, 1);
const marker = "synthetic-private-provider-detail";
const campId = asCamp("synthetic-camp");
const reconcilerId = asReconciler("synthetic-agent");
const lease: ReconcilerLease = {
	campId,
	reconcilerId,
	holderId: "synthetic-holder",
	fence: parseFenceToken("1"),
	expiresAtMs: now + 60_000,
};

function token(exp = now + 60 * 60_000): string {
	const payload = Buffer.from(
		JSON.stringify({ exp: Math.floor(exp / 1000) }),
	).toString("base64url");
	return `e30.${payload}.synthetic`;
}

function transport(http: HttpTransport, svid = token()) {
	return createHttpTransport({
		baseUrl: "https://station.test",
		http,
		reconcilerId,
		privateJwk: freshSignJwk(),
		svid,
		now: () => now,
	});
}

function refusal(code: string) {
	return JSON.stringify({
		ok: false,
		reasons: [{ code, message: marker, remediation: marker, subject: marker }],
	});
}

function response(body: string, status = 503) {
	return { status, headers: {}, body };
}

function leaseResponse(overrides: Record<string, string | number> = {}) {
	return JSON.stringify({
		ok: true,
		value: {
			reconcilerId,
			campId,
			holderId: lease.holderId,
			fence: lease.fence.toString(),
			expiresAtMs: lease.expiresAtMs,
			...overrides,
		},
	});
}

describe("agent HTTP refusal privacy", () => {
	it("does not echo a malformed Station URL", () => {
		let caught: unknown;
		try {
			parseStationOrigin(marker);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(String(caught)).not.toContain(marker);
	});
	it("preserves a known refusal code but discards remote reason details", async () => {
		const client = transport(async () => response(refusal("lease-held"), 409));
		const result = await client.claim({
			reconcilerId,
			campId,
			holderId: "synthetic-holder",
			ttlMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("lease-held");
		expect(result.reasons[0]?.remediation).toContain("lease");
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("replaces an unknown remote code without echoing any supplied field", async () => {
		const client = transport(async () => response(refusal(marker)));
		const result = await client.claim({
			reconcilerId,
			campId,
			holderId: "synthetic-holder",
			ttlMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("response-invalid");
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("redacts an error from the SVID credential source", async () => {
		let requests = 0;
		const client = createHttpTransport({
			baseUrl: "https://station.test",
			http: async () => {
				requests++;
				return response("{}", 200);
			},
			reconcilerId,
			privateJwk: freshSignJwk(),
			svid: token(),
			credential: async () => {
				throw new Error(marker);
			},
			now: () => now,
		});
		const result = await client.renew(lease);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(marker);
		expect(requests).toBe(0);
	});

	it.each([
		"reconcilerId",
		"campId",
		"holderId",
	] as const)("rejects a claimed lease with a different %s", async (field) => {
		const client = transport(async () =>
			response(leaseResponse({ [field]: marker }), 200),
		);
		const result = await client.claim({
			reconcilerId,
			campId,
			holderId: lease.holderId,
			ttlMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("response-invalid");
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("rejects a renewal that changes the lease fence", async () => {
		const client = transport(async () =>
			response(leaseResponse({ fence: "2" }), 200),
		);
		const result = await client.renew(lease);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("response-invalid");
	});

	it("does not release a lease bound to another reconciler", async () => {
		let requests = 0;
		const client = transport(async () => {
			requests++;
			return response('{"ok":true,"value":{}}', 200);
		});
		await client.release({
			...lease,
			reconcilerId: asReconciler("synthetic-other-agent"),
		});
		expect(requests).toBe(0);
	});

	it("rejects an already expired lease", async () => {
		const client = transport(async () =>
			response(leaseResponse({ expiresAtMs: now }), 200),
		);
		const result = await client.renew(lease);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("response-invalid");
	});

	it("rejects a success envelope delivered with a failure status", async () => {
		const client = transport(async () => response(leaseResponse(), 503));
		const result = await client.renew(lease);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("response-invalid");
	});

	it("accepts a lease whose identity and renewal fence match", async () => {
		const client = transport(async () => response(leaseResponse(), 200));
		const claimed = await client.claim({
			reconcilerId,
			campId,
			holderId: lease.holderId,
			ttlMs: 1_000,
		});
		expect(claimed).toEqual({ ok: true, value: lease });
		expect(await client.renew(lease)).toEqual({ ok: true, value: lease });
	});

	it("keeps a feed refusal typed without exposing the Station's message", async () => {
		const client = transport(async () => response(refusal("stale-fence"), 409));
		let caught: unknown;
		try {
			await collect(
				client.feed({ lease, signal: new AbortController().signal }),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(FeedRefusedError);
		if (!(caught instanceof FeedRefusedError))
			throw new Error("Expected feed refusal.");
		expect(caught.code).toBe("stale-fence");
		expect(
			JSON.stringify({ message: caught.message, reasons: caught.reasons }),
		).not.toContain(marker);
	});

	it.each([
		["blob-missing", "resolved-set-missing"],
		["blob-corrupt", "resolved-set-mismatch"],
	] as const)("redacts a %s blob refusal while retaining its mapping", async (remote, expected) => {
		const client = transport(async () => response(refusal(remote), 404));
		const set = create(SetRecordSchema, {
			setId: marker,
			campId,
			resolvedSetDigest: `sha256:${"0".repeat(64)}`,
		});
		const result = await client.resolved(lease, set);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe(expected);
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("does not expose the requested set or camp on a lease mismatch", async () => {
		const client = transport(async () => {
			throw new Error("No request should be dispatched.");
		});
		const set = create(SetRecordSchema, { setId: marker, campId: marker });
		const result = await client.resolved(lease, set);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("does not expose the set or expected digest on a digest mismatch", () => {
		const set = create(SetRecordSchema, {
			setId: marker,
			campId,
			resolvedSetDigest: marker,
		});
		const result = parseResolvedSet("{}", set);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("does not echo a private content field from an invalid resolved set", () => {
		const text = JSON.stringify({
			schemaVersion: RESOLVED_SET_SCHEMA,
			plan: { resources: [] },
			gatekeeper: {},
			matches: [],
			secretRefs: [],
			planHash: "synthetic",
			contentHash: marker,
			campId,
		});
		const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
		const set = create(SetRecordSchema, {
			setId: "synthetic-set",
			campId,
			resolvedSetDigest: digest,
			contentHash: "expected",
		});
		const result = parseResolvedSet(text, set);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("rejects a malformed feed position without echoing it", async () => {
		const body = `id: ${marker}\nevent: frame\ndata: {}\n\n`;
		const client = transport(async () => response(body, 200));
		await expect(
			collect(client.feed({ lease, signal: new AbortController().signal })),
		).rejects.toThrow("response-invalid: The Station refused the request.");
		try {
			await collect(
				client.feed({ lease, signal: new AbortController().signal }),
			);
		} catch (error) {
			expect(String(error)).not.toContain(marker);
		}
	});

	it("accepts matching event positions larger than 20 decimal digits", async () => {
		const position = "123456789012345678901234567890";
		const frame = JSON.stringify({
			position,
			set: { campId, setId: "synthetic-set" },
		});
		const body = `id: ${position}\nevent: frame\ndata: ${frame}\n\nevent: end\ndata: {"reason":"caught-up"}\n\n`;
		const client = transport(async () => response(body, 200));
		const changes = await collect(
			client.feed({ lease, signal: new AbortController().signal }),
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.position).toBe(BigInt(position));
	});

	it("rejects a frame without an SSE id and retains initial redelivery", async () => {
		const urls: URL[] = [];
		const frame = JSON.stringify({
			position: "1",
			set: { campId, setId: "synthetic-set" },
		});
		const client = transport(async (request) => {
			urls.push(new URL(request.url));
			const id = urls.length === 1 ? "" : "id: 1\n";
			return response(
				`${id}event: frame\ndata: ${frame}\n\nevent: end\ndata: {"reason":"caught-up"}\n\n`,
				200,
			);
		});
		await expect(
			collect(client.feed({ lease, signal: new AbortController().signal })),
		).rejects.toMatchObject({ code: "response-invalid" });
		const changes = await collect(
			client.feed({ lease, signal: new AbortController().signal }),
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.position).toBe(1n);
		expect(urls.map((url) => url.searchParams.get("redeliver"))).toEqual([
			"1",
			"1",
		]);
	});

	it.each([
		"{}",
		"not-json",
		'{"reason":"unrecognized"}',
	])("rejects an invalid feed end and redelivers after earlier frames: %s", async (invalidEnd) => {
		const urls: URL[] = [];
		const frame = JSON.stringify({
			position: "1",
			set: { campId, setId: "synthetic-set" },
		});
		const client = transport(async (request) => {
			urls.push(new URL(request.url));
			const end = urls.length === 1 ? invalidEnd : '{"reason":"caught-up"}';
			return response(
				`id: 1\nevent: frame\ndata: ${frame}\n\nevent: end\ndata: ${end}\n\n`,
				200,
			);
		});
		await expect(
			collect(client.feed({ lease, signal: new AbortController().signal })),
		).rejects.toMatchObject({ code: "response-invalid" });
		const changes = await collect(
			client.feed({ lease, signal: new AbortController().signal }),
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.position).toBe(1n);
		expect(urls.map((url) => url.searchParams.get("redeliver"))).toEqual([
			"1",
			"1",
		]);
	});

	it("evicts old inline sets and fetches their verified blobs", async () => {
		const resolved = resolvedFor(campId);
		const text = JSON.stringify(resolved);
		const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
		const frames = Array.from({ length: 17 }, (_, index) => {
			const position = String(index + 1);
			const set = {
				campId,
				setId: `set-${index}`,
				resolvedSetDigest: digest,
				contentHash: resolved.contentHash,
			};
			return `id: ${position}\nevent: frame\ndata: ${JSON.stringify({ position, set, resolvedSetJson: text })}\n\n`;
		}).join("");
		const paths: string[] = [];
		const client = transport(async (request) => {
			const path = new URL(request.url).pathname;
			paths.push(path);
			return path.endsWith("/feed")
				? response(`${frames}event: end\ndata: {"reason":"caught-up"}\n\n`, 200)
				: response(text, 200);
		});
		const changes = await collect(
			client.feed({ lease, signal: new AbortController().signal }),
		);
		expect(changes).toHaveLength(17);
		const newest = changes.at(-1);
		const oldest = changes[0];
		if (!newest || !oldest) throw new Error("fixture frames missing");
		expect((await client.resolved(lease, newest.set)).ok).toBe(true);
		expect(paths).toHaveLength(1);
		expect((await client.resolved(lease, oldest.set)).ok).toBe(true);
		expect(paths).toHaveLength(2);
		expect(paths[1]).toContain("/blobs/");
	});

	it("keeps inline sets with the same id and different digests distinct", async () => {
		const resolved = resolvedFor(campId);
		const texts = [JSON.stringify(resolved), JSON.stringify(resolved, null, 2)];
		const frames = texts
			.map((text, index) => {
				const position = String(index + 1);
				const set = {
					campId,
					setId: "same-set",
					resolvedSetDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
					contentHash: resolved.contentHash,
				};
				return `id: ${position}\nevent: frame\ndata: ${JSON.stringify({ position, set, resolvedSetJson: text })}\n\n`;
			})
			.join("");
		let requests = 0;
		const client = transport(async () => {
			requests++;
			return response(
				`${frames}event: end\ndata: {"reason":"caught-up"}\n\n`,
				200,
			);
		});
		const changes = await collect(
			client.feed({ lease, signal: new AbortController().signal }),
		);
		expect(changes).toHaveLength(2);
		for (const change of changes)
			expect((await client.resolved(lease, change.set)).ok).toBe(true);
		expect(requests).toBe(1);
	});

	it("refuses an SSE id that disagrees with its frame position", async () => {
		const frame = JSON.stringify({
			position: "1",
			set: { campId, setId: "synthetic-set" },
		});
		const client = transport(async () =>
			response(`id: 2\nevent: frame\ndata: ${frame}\n\n`, 200),
		);
		await expect(
			collect(client.feed({ lease, signal: new AbortController().signal })),
		).rejects.toMatchObject({ code: "response-invalid" });
	});

	it("recovers a lapsed SVID from the credential source with sanitized refusals", async () => {
		let calls = 0;
		const sent: string[] = [];
		const fresh = token();
		const client = createHttpTransport({
			baseUrl: "https://station.test",
			http: async (request) => {
				calls++;
				sent.push(request.headers.authorization ?? "");
				return response(refusal("lease-held"), 409);
			},
			reconcilerId,
			privateJwk: freshSignJwk(),
			svid: token(now - 1_000),
			credential: async () => fresh,
			now: () => now,
		});
		const result = await client.claim({
			reconcilerId,
			campId,
			holderId: "synthetic-holder",
			ttlMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected refusal.");
		expect(result.reasons[0]?.code).toBe("lease-held");
		expect(calls).toBe(1);
		expect(sent).toEqual([`DPoP ${fresh}`]);
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("does not request the feed after cancellation during SVID refresh", async () => {
		const controller = new AbortController();
		const requests: string[] = [];
		const client = createHttpTransport({
			baseUrl: "https://station.test",
			http: async (request) => {
				requests.push(new URL(request.url).pathname);
				return response('event: end\ndata: {"reason":"caught-up"}\n\n', 200);
			},
			reconcilerId,
			privateJwk: freshSignJwk(),
			svid: "",
			credential: async () => {
				controller.abort();
				return token();
			},
			now: () => now,
		});
		expect(
			await collect(client.feed({ lease, signal: controller.signal })),
		).toEqual([]);
		expect(requests).toEqual([]);
	});

	it("tracks only the current lease fence per Camp without an old release clearing it", async () => {
		const urls: URL[] = [];
		const client = transport(async (request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/feed")) {
				urls.push(url);
				return response('event: end\ndata: {"reason":"caught-up"}\n\n', 200);
			}
			return response('{"ok":true,"value":{}}', 200);
		});
		const nextLease = { ...lease, fence: parseFenceToken("2") };
		const run = (current: ReconcilerLease) =>
			collect(
				client.feed({ lease: current, signal: new AbortController().signal }),
			);
		await run(lease);
		await run(nextLease);
		await client.release(lease);
		await run(nextLease);
		await run(lease);
		expect(urls.map((url) => url.searchParams.get("redeliver"))).toEqual([
			"1",
			"1",
			null,
			"1",
		]);
	});

	it("drops a feed response received after cancellation and retries the initial redelivery", async () => {
		const controller = new AbortController();
		const requests: string[] = [];
		const client = transport(async (request) => {
			requests.push(request.url);
			if (requests.length === 1) controller.abort();
			return response('event: end\ndata: {"reason":"caught-up"}\n\n', 200);
		});
		expect(
			await collect(client.feed({ lease, signal: controller.signal })),
		).toEqual([]);
		expect(
			await collect(
				client.feed({ lease, signal: new AbortController().signal }),
			),
		).toEqual([]);
		expect(requests).toHaveLength(2);
		expect(
			requests.every(
				(url) => new URL(url).searchParams.get("redeliver") === "1",
			),
		).toBe(true);
	});
});
