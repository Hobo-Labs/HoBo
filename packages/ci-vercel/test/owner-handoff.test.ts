import {
	createDecipheriv,
	createHash,
	createHmac,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { createServer } from "node:http";
import type { EphemeralStatePort, JsonValue } from "@hobo/core";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CacheBindingError } from "../src/cache-backend.js";
import { createHttpEntry, createOwnerHandoffEntry } from "../src/entry.js";
import {
	createOwnerHandoffMailbox,
	OWNER_HANDOFF_API_PREFIX,
	ownerHandoffPageHtml,
	ownerHandoffSealing,
} from "../src/owner-handoff.js";

const ORIGIN = "https://relay.example";
const ANSWER = {
	store: "infisical",
	INFISICAL_PROJECT_ID: "synthetic-private-project",
	INFISICAL_CLI_SESSION: "c3ludGhldGljLXByaXZhdGUtc2Vzc2lvbg==",
};
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const derive = (secret: Uint8Array, salt: Uint8Array, info: string) =>
	Buffer.from(hkdfSync("sha256", secret, salt, info, 32));

function recipient(nowMs: number, ttlMs = 10 * 60_000) {
	const ticket = b64u(randomBytes(32));
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = pair.publicKey.export({ format: "jwk" });
	const recipientKey = b64u(
		Buffer.concat([
			Buffer.from([4]),
			Buffer.from(jwk.x ?? "", "base64url"),
			Buffer.from(jwk.y ?? "", "base64url"),
		]),
	);
	const ticketBytes = Buffer.from(ticket, "base64url");
	const mailboxId = b64u(
		derive(ticketBytes, Buffer.alloc(0), "hobo owner-handoff mailbox v1"),
	);
	const binding = b64u(randomBytes(32));
	const expiresAtMs = nowMs + ttlMs;
	const keyProof = createHmac(
		"sha256",
		derive(ticketBytes, Buffer.alloc(0), "hobo owner-handoff bind v1"),
	)
		.update(`v1|${mailboxId}|${recipientKey}|${binding}|${expiresAtMs}`)
		.digest("base64url");
	const collectToken = b64u(randomBytes(32));
	return {
		ticket,
		privateKey: pair.privateKey,
		collectToken,
		offer: { mailboxId, recipientKey, binding, expiresAtMs, keyProof },
		registration: {
			offer: { mailboxId, recipientKey, binding, expiresAtMs, keyProof },
			collectDigest: createHash("sha256")
				.update(collectToken)
				.digest("base64url"),
		},
	};
}

const Envelope = z.object({
	senderKey: z.string(),
	iv: z.string(),
	ciphertext: z.string(),
});

function open(
	privateKey: KeyObject,
	offer: { mailboxId: string; recipientKey: string; binding: string },
	envelope: z.infer<typeof Envelope>,
) {
	const sender = Buffer.from(envelope.senderKey, "base64url");
	const shared = diffieHellman({
		privateKey,
		publicKey: createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: b64u(sender.subarray(1, 33)),
				y: b64u(sender.subarray(33)),
			},
			format: "jwk",
		}),
	});
	const key = derive(
		shared,
		Buffer.from(offer.mailboxId, "base64url"),
		`hobo owner-handoff seal v1|${envelope.senderKey}|${offer.recipientKey}`,
	);
	const sealed = Buffer.from(envelope.ciphertext, "base64url");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(envelope.iv, "base64url"),
	);
	decipher.setAAD(Buffer.from(`v1|${offer.mailboxId}|${offer.binding}`));
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	return JSON.parse(
		Buffer.concat([
			decipher.update(sealed.subarray(0, sealed.length - 16)),
			decipher.final(),
		]).toString("utf8"),
	);
}

function recordingState(clock: { now: number }) {
	const written: string[] = [];
	const inner = createRedisEphemeralState({
		executor: createMemoryRedisExecutor({ now: () => clock.now }),
	});
	const state: EphemeralStatePort = {
		...inner,
		putIfAbsent: (key, value, ttl) => {
			written.push(value);
			return inner.putIfAbsent(key, value, ttl);
		},
		compareAndSet: (key, expected, value, ttl) => {
			written.push(value);
			return inner.compareAndSet(key, expected, value, ttl);
		},
	};
	return { state, written };
}

function relay(clock: { now: number }) {
	const { state, written } = recordingState(clock);
	const handle = createOwnerHandoffMailbox({
		state,
		environment: "test",
		now: () => clock.now,
	});
	const call = (path: string, init: RequestInit = {}) =>
		handle(new Request(`${ORIGIN}${path}`, init));
	const post = (path: string, body: JsonValue, headers = {}) =>
		call(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	return { call, post, written };
}

describe("the relay's owner hand-off mailbox", () => {
	it("carries one sealed answer from the page to the ticket's holder, and nothing readable to the relay", async () => {
		const clock = { now: 1_800_000_000_000 };
		const { call, post, written } = relay(clock);
		const holder = recipient(clock.now);
		const box = `${OWNER_HANDOFF_API_PREFIX}/${holder.offer.mailboxId}`;
		expect(
			(await post(OWNER_HANDOFF_API_PREFIX, holder.registration)).status,
		).toBe(201);
		expect(
			(await post(OWNER_HANDOFF_API_PREFIX, holder.registration)).status,
		).toBe(409);

		const sealing = ownerHandoffSealing();
		expect(await sealing.mailboxOf(holder.ticket)).toBe(holder.offer.mailboxId);
		const shown = await call(box);
		expect(shown.status).toBe(200);
		expect(shown.headers.get("cache-control")).toBe("no-store");
		const offer = z
			.object({
				mailboxId: z.string(),
				recipientKey: z.string(),
				binding: z.string(),
				expiresAtMs: z.number(),
				keyProof: z.string(),
			})
			.strict()
			.parse(await shown.json());
		expect(await sealing.verifyOffer(holder.ticket, offer)).toBe(true);
		const swapped = recipient(clock.now);
		expect(
			await sealing.verifyOffer(holder.ticket, {
				...offer,
				recipientKey: swapped.offer.recipientKey,
			}),
		).toBe(false);

		expect(
			(
				await post(
					`${box}/collect`,
					{},
					{
						authorization: `Bearer ${holder.collectToken}`,
					},
				)
			).status,
		).toBe(202);
		const envelope = await sealing.seal(holder.ticket, offer, ANSWER);
		const put = (body: JsonValue) =>
			call(`${box}/envelope`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await put(envelope)).status).toBe(204);
		expect((await put(envelope)).status).toBe(410);
		expect((await call(box)).status).toBe(410);

		expect(
			(
				await post(
					`${box}/collect`,
					{},
					{
						authorization: `Bearer ${b64u(randomBytes(32))}`,
					},
				)
			).status,
		).toBe(404);
		const collected = await post(
			`${box}/collect`,
			{},
			{
				authorization: `Bearer ${holder.collectToken}`,
			},
		);
		expect(collected.status).toBe(200);
		const body = z.object({ envelope: Envelope }).parse(await collected.json());
		expect(open(holder.privateKey, holder.offer, body.envelope)).toEqual({
			v: 1,
			mailboxId: holder.offer.mailboxId,
			binding: holder.offer.binding,
			answer: ANSWER,
		});
		expect(
			(
				await post(
					`${box}/collect`,
					{},
					{
						authorization: `Bearer ${holder.collectToken}`,
					},
				)
			).status,
		).toBe(410);

		const stored = written.join("\n");
		for (const value of Object.values(ANSWER).slice(1))
			expect(stored).not.toContain(value);
		expect(stored).not.toContain(holder.ticket);
		expect(stored).not.toContain(holder.collectToken);
	});

	it("refuses an expired mailbox, an over-long ticket life and any field beyond the offer", async () => {
		const clock = { now: 1_800_000_000_000 };
		const { call, post } = relay(clock);
		expect(
			(
				await post(
					OWNER_HANDOFF_API_PREFIX,
					recipient(clock.now, 16 * 60_000).registration,
				)
			).status,
		).toBe(400);
		const holder = recipient(clock.now);
		expect(
			(
				await post(OWNER_HANDOFF_API_PREFIX, {
					...holder.registration,
					offer: {
						...holder.registration.offer,
						INFISICAL_PROJECT_ID: "synthetic-private-project",
					},
				})
			).status,
		).toBe(400);
		expect(
			(await post(OWNER_HANDOFF_API_PREFIX, holder.registration)).status,
		).toBe(201);
		const box = `${OWNER_HANDOFF_API_PREFIX}/${holder.offer.mailboxId}`;
		clock.now += 10 * 60_000 + 1;
		expect((await call(box)).status).toBe(404);
		const envelope = await ownerHandoffSealing().seal(
			holder.ticket,
			holder.offer,
			ANSWER,
		);
		expect(
			(
				await call(`${box}/envelope`, {
					method: "PUT",
					body: JSON.stringify(envelope),
				})
			).status,
		).toBe(404);
		expect(
			(
				await post(
					`${box}/collect`,
					{},
					{
						authorization: `Bearer ${holder.collectToken}`,
					},
				)
			).status,
		).toBe(404);
	});

	it("serves the page with a CSP that admits only its own script and style", async () => {
		const clock = { now: 1_800_000_000_000 };
		const { call } = relay(clock);
		const response = await call("/owner-handoff");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		const csp = response.headers.get("content-security-policy") ?? "";
		const html = await response.text();
		const script = /<script>([\s\S]*)<\/script>/u.exec(html)?.[1] ?? "";
		const style = /<style>([\s\S]*)<\/style>/u.exec(html)?.[1] ?? "";
		const hash = (text: string) =>
			`'sha256-${createHash("sha256").update(text).digest("base64")}'`;
		expect(csp).toContain(`script-src ${hash(script)}`);
		expect(csp).toContain(`style-src ${hash(style)}`);
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(script).toContain("history.replaceState");
		expect(html).toBe(ownerHandoffPageHtml().html);
		expect(() => new Function(script)).not.toThrow();
	});

	it("is served by the entry before the relay starts, and says when no mailbox store is bound", async () => {
		const clock = { now: 1_800_000_000_000 };
		const { state } = recordingState(clock);
		const routed = createHttpEntry(
			async () => {
				throw new Error("not started");
			},
			{
				ownerHandoff: createOwnerHandoffEntry(
					{ VERCEL_URL: "relay.example" },
					async () => ({
						binding: { id: "memory", kind: "memory", names: [] },
						state,
						units: ["commands"],
						usage: () => ({}),
						close: async () => undefined,
					}),
				),
			},
		);
		const unbound = createHttpEntry(
			async () => {
				throw new Error("not started");
			},
			{
				ownerHandoff: createOwnerHandoffEntry({}, async () => {
					throw new CacheBindingError("no cache is bound");
				}),
			},
		);
		const cases: readonly {
			entry: ReturnType<typeof createHttpEntry>;
			check: (base: string) => Promise<void>;
		}[] = [
			{
				entry: routed,
				check: async (base) => {
					expect((await fetch(`${base}/owner-handoff`)).status).toBe(200);
					expect((await fetch(`${base}/readyz`)).status).toBe(503);
				},
			},
			{
				entry: unbound,
				check: async (base) => {
					const response = await fetch(`${base}${OWNER_HANDOFF_API_PREFIX}`, {
						method: "POST",
						body: "{}",
					});
					expect(response.status).toBe(503);
					expect(await response.json()).toEqual({
						ready: false,
						state: "no-mailbox-store",
					});
				},
			},
		];
		for (const { entry, check } of cases) {
			const server = createServer(entry);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const { port } = z.object({ port: z.number() }).parse(server.address());
				await check(`http://127.0.0.1:${port}`);
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
		}
	});
});
