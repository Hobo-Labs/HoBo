/**
 * The overlay transport (L14, O12): `runTransportConformance` over a fake
 * `OverlayNetwork` whose overlay address is loopback, and the transport's own
 * rules: it starts only on a joined overlay, it dials only an overlay
 * identity, a dialler must prove the grant's SEAL key and come from the
 * grant's overlay address before `authorise` sees its identity, and a
 * stranger on the port is closed without being heard.
 */
import { randomBytes } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import type { OverlayIdentity, OverlayNetwork, TenantId } from "@hobo/core";
import {
	type DeviceKeys,
	type FleetStream,
	type FleetTransport,
	SESSION_GRANT_CONTEXT,
	type SessionGrant,
	SessionPurpose,
	type SignedEnvelope,
} from "@hobo/fleet";
import { createMemoryKeyStore, signEnvelope } from "@hobo/fleet/keys";
import { runTransportConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createOverlayTransport } from "../src/index.js";
import {
	formatOverlayIdentity,
	normaliseHost,
	overlayHost,
	parseOverlayIdentity,
} from "../src/overlay-transport/identity.js";
import { createOverlayTransportWith } from "../src/overlay-transport/transport.js";
import {
	decodeSessionGrant,
	decodeSignedEnvelope,
	encodeSessionGrant,
	encodeSignedEnvelope,
} from "../src/overlay-transport/wire.js";

// SAFETY: a test tenant id; the fake overlay never checks it.
const TENANT = "acme" as TenantId;

/** An overlay this device has joined, at `ips`; `null` status when not joined. */
function fakeOverlay(
	ips: readonly string[] | null = ["127.0.0.1"],
): OverlayNetwork {
	const identity: OverlayIdentity | null =
		ips === null
			? null
			: {
					nodeId: `node-${randomBytes(4).toString("hex")}`,
					hostname: "device",
					overlayIps: ips,
					tags: ["tag:hobo-fleet"],
					tenantId: TENANT,
				};
	return {
		provider: "tailscale",
		async join() {
			throw new Error("the transport never joins the overlay");
		},
		status: async () => identity,
		async leave() {},
		tenantTags: () => [],
	};
}

runTransportConformance(async () => [
	createOverlayTransportWith(fakeOverlay(), { handshakeTimeoutMs: 2_000 }),
	createOverlayTransportWith(fakeOverlay(), { handshakeTimeoutMs: 2_000 }),
]);

const MINUTE = 60_000;

type Device = Readonly<{
	transport: FleetTransport;
	keys: DeviceKeys;
	identity: string;
}>;

async function device(transport?: FleetTransport): Promise<Device> {
	const keys = await createMemoryKeyStore().open();
	const started =
		transport ??
		createOverlayTransportWith(fakeOverlay(), { handshakeTimeoutMs: 1_000 });
	const { transportIdentity } = await started.start(keys);
	return { transport: started, keys, identity: transportIdentity };
}

function grantBetween(
	initiator: Device,
	acceptor: Device,
	overrides: Readonly<{
		initiatorIdentity?: string;
		initiatorSeal?: string;
		acceptorIdentity?: string;
		acceptorMember?: string;
	}> = {},
): SessionGrant {
	const now = Date.now();
	return {
		$typeName: "hobo.fleet.v1.SessionGrant",
		sessionId: randomBytes(16).toString("hex"),
		tenant: "acme",
		initiator: {
			$typeName: "hobo.fleet.v1.SessionParty",
			memberId: initiator.keys.memberId,
			principal: "",
			transportIdentity: overrides.initiatorIdentity ?? initiator.identity,
			sealPublicKey: overrides.initiatorSeal ?? initiator.keys.sealPublicKey,
		},
		acceptor: {
			$typeName: "hobo.fleet.v1.SessionParty",
			memberId: overrides.acceptorMember ?? acceptor.keys.memberId,
			principal: "",
			transportIdentity: overrides.acceptorIdentity ?? acceptor.identity,
			sealPublicKey: acceptor.keys.sealPublicKey,
		},
		purpose: SessionPurpose.BLOB,
		orderId: "",
		port: 0,
		blobDigests: [`sha256:${"ab".repeat(32)}`],
		issuedAt: new Date(now - MINUTE).toISOString(),
		expiresAt: new Date(now + 10 * MINUTE).toISOString(),
	};
}

function envelopeOf(
	signer: DeviceKeys,
	grant: SessionGrant,
): Promise<SignedEnvelope> {
	return signEnvelope(
		signer.sign,
		SESSION_GRANT_CONTEXT,
		encodeSessionGrant(grant),
	);
}

type Seen = { peer: string; grant: SignedEnvelope }[];

/** Accepts on `acceptor`, answering `answer` and echoing one byte back on every accepted stream. */
function acceptOn(acceptor: Device, answer: (peer: string) => boolean) {
	const seen: Seen = [];
	const handled: SessionGrant[] = [];
	const subscription = acceptor.transport.accept(
		async (peer, grant) => {
			seen.push({ peer, grant });
			return answer(peer);
		},
		async (stream, grant) => {
			handled.push(grant);
			for await (const chunk of stream.read()) await stream.write(chunk);
		},
	);
	return { seen, handled, subscription };
}

async function stopAll(...devices: Device[]): Promise<void> {
	for (const each of devices) await each.transport.stop();
}

const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createOverlayTransport", () => {
	it("is the overlay kind and refuses to start before the overlay is joined", async () => {
		const transport = createOverlayTransport(fakeOverlay(null));
		expect(transport.kind).toBe("overlay");
		const keys = await createMemoryKeyStore().open();
		await expect(transport.start(keys)).rejects.toThrow(/not joined/);
	});

	it("refuses to start without an overlay address", async () => {
		const transport = createOverlayTransport(fakeOverlay(["not-an-ip"]));
		const keys = await createMemoryKeyStore().open();
		await expect(transport.start(keys)).rejects.toThrow(/no overlay address/);
	});

	it("names its SEAL key and the overlay address it accepts on", async () => {
		const self = await device();
		try {
			const parsed = parseOverlayIdentity(self.identity);
			expect(parsed).toMatchObject({
				sealPublicKey: self.keys.sealPublicKey,
				host: "127.0.0.1",
			});
			expect(parsed?.port).toBeGreaterThan(0);
		} finally {
			await stopAll(self);
		}
	});

	it("restarts on a new port with new keys", async () => {
		const transport = createOverlayTransportWith(fakeOverlay());
		const first = await device(transport);
		const second = await device(transport);
		try {
			expect(second.identity).not.toBe(first.identity);
		} finally {
			await stopAll(second);
		}
	});
});

describe("dial", () => {
	it("fails unavailable before start", async () => {
		const transport = createOverlayTransport(fakeOverlay());
		const outcome = await transport.dial({
			grant: decodeSignedEnvelope(new Uint8Array(0)),
			signal: new AbortController().signal,
		});
		expect(outcome).toMatchObject({
			ok: false,
			error: { code: "unavailable" },
		});
	});

	it("fails invalid-request on a grant that does not decode", async () => {
		const self = await device();
		try {
			const outcome = await self.transport.dial({
				grant: {
					$typeName: "hobo.fleet.v1.SignedEnvelope",
					context: SESSION_GRANT_CONTEXT,
					keyId: "",
					algorithm: 0,
					payload: new Uint8Array([0xff, 0xff]),
					signature: new Uint8Array(0),
				},
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "invalid-request" },
			});
		} finally {
			await stopAll(self);
		}
	});

	it("falls through (unavailable) when the acceptor has no overlay identity", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		try {
			const grant = grantBetween(initiator, acceptor, {
				acceptorIdentity: "p2p-endpoint-id",
			});
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
		} finally {
			await stopAll(initiator, acceptor);
		}
	});

	it("refuses an acceptor identity whose SEAL key is not the grant's", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		try {
			const grant = grantBetween(initiator, acceptor, {
				acceptorIdentity: initiator.identity,
			});
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "invalid-request" },
			});
		} finally {
			await stopAll(initiator, acceptor);
		}
	});

	it("fails unavailable when nothing listens at the acceptor's address", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		const grant = grantBetween(initiator, acceptor);
		await stopAll(acceptor);
		try {
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
		} finally {
			await stopAll(initiator);
		}
	});

	it("fails unavailable when the acceptor never answers", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		const silent = await new Promise<Server>((resolve) => {
			const server = createServer(() => undefined);
			server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server));
		});
		try {
			const address = silent.address();
			const port = address instanceof Object ? address.port : 0;
			const grant = grantBetween(initiator, acceptor, {
				acceptorIdentity: formatOverlayIdentity({
					sealPublicKey: acceptor.keys.sealPublicKey,
					host: "127.0.0.1",
					port,
				}),
			});
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
		} finally {
			silent.close();
			await stopAll(initiator, acceptor);
		}
	});
});

describe("accept", () => {
	it("hands authorise the grant's initiator identity when the dialler proves it, and serves the stream", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		const accepting = acceptOn(acceptor, () => true);
		try {
			const grant = grantBetween(initiator, acceptor);
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			if (!outcome.ok) throw new Error(outcome.error.message);
			expect(outcome.value.peer).toBe(acceptor.identity);
			await outcome.value.write(new Uint8Array([7, 8, 9]));
			const back = await firstChunk(outcome.value);
			expect([...back]).toEqual([7, 8, 9]);
			expect(accepting.seen.map((entry) => entry.peer)).toEqual([
				initiator.identity,
			]);
			expect(accepting.handled[0]).toMatchObject({
				sessionId: grant.sessionId,
				blobDigests: grant.blobDigests,
				purpose: SessionPurpose.BLOB,
				initiator: { memberId: initiator.keys.memberId },
			});
			await outcome.value.close();
		} finally {
			await accepting.subscription.stop();
			await stopAll(initiator, acceptor);
		}
	});

	it("reports the identity the connection proves when the grant's initiator host is not the source", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		const claimed = formatOverlayIdentity({
			sealPublicKey: initiator.keys.sealPublicKey,
			host: "100.64.0.9",
			port: 4_000,
		});
		const accepting = acceptOn(acceptor, (peer) => peer === claimed);
		try {
			const grant = grantBetween(initiator, acceptor, {
				initiatorIdentity: claimed,
			});
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "session-denied" },
			});
			expect(accepting.seen).toHaveLength(1);
			const proven = parseOverlayIdentity(accepting.seen[0]?.peer ?? "");
			expect(proven).toMatchObject({
				sealPublicKey: initiator.keys.sealPublicKey,
				host: "127.0.0.1",
			});
			expect(accepting.handled).toHaveLength(0);
		} finally {
			await accepting.subscription.stop();
			await stopAll(initiator, acceptor);
		}
	});

	it("never asks authorise about a dialler that does not hold the grant's SEAL key", async () => {
		const [initiator, acceptor, other] = [
			await device(),
			await device(),
			await device(),
		];
		const accepting = acceptOn(acceptor, () => true);
		try {
			const grant = grantBetween(initiator, acceptor, {
				initiatorSeal: other.keys.sealPublicKey,
			});
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(false);
			await pause(50);
			expect(accepting.seen).toHaveLength(0);
			expect(accepting.handled).toHaveLength(0);
		} finally {
			await accepting.subscription.stop();
			await stopAll(initiator, acceptor, other);
		}
	});

	it("refuses a grant that names another acceptor member", async () => {
		const [initiator, acceptor, other] = [
			await device(),
			await device(),
			await device(),
		];
		const accepting = acceptOn(acceptor, () => true);
		try {
			const grant = grantBetween(initiator, acceptor, {
				acceptorMember: other.keys.memberId,
			});
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(initiator.keys, grant),
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(false);
			expect(accepting.seen).toHaveLength(0);
		} finally {
			await accepting.subscription.stop();
			await stopAll(initiator, acceptor, other);
		}
	});

	it("treats an authorise that throws as a refusal", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		const subscription = acceptor.transport.accept(
			async () => {
				throw new Error("policy engine down");
			},
			async () => {
				throw new Error("must not be called");
			},
		);
		try {
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(
					initiator.keys,
					grantBetween(initiator, acceptor),
				),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "session-denied" },
			});
		} finally {
			await subscription.stop();
			await stopAll(initiator, acceptor);
		}
	});

	it("keeps accepting after a handler throws", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		let calls = 0;
		const subscription = acceptor.transport.accept(
			async () => true,
			async () => {
				calls += 1;
				throw new Error("handler failed");
			},
		);
		try {
			for (let round = 0; round < 2; round += 1) {
				const outcome = await initiator.transport.dial({
					grant: await envelopeOf(
						initiator.keys,
						grantBetween(initiator, acceptor),
					),
					signal: new AbortController().signal,
				});
				expect(outcome.ok).toBe(true);
				if (outcome.ok) await outcome.value.close();
			}
			await pause(50);
			expect(calls).toBe(2);
		} finally {
			await subscription.stop();
			await stopAll(initiator, acceptor);
		}
	});

	it("closes a connection that is not an overlay dialler without asking authorise", async () => {
		const acceptor = await device();
		const accepting = acceptOn(acceptor, () => true);
		const address = parseOverlayIdentity(acceptor.identity);
		try {
			const closed = await new Promise<boolean>((resolve) => {
				const socket = connect({
					host: address?.host ?? "",
					port: address?.port ?? 0,
				});
				socket.on("error", () => undefined);
				socket.on("connect", () => {
					socket.write(Buffer.from("GET / HTTP/1.1\r\n\r\n".repeat(4)));
				});
				socket.on("close", () => resolve(true));
				socket.resume();
			});
			expect(closed).toBe(true);
			expect(accepting.seen).toHaveLength(0);
		} finally {
			await accepting.subscription.stop();
			await stopAll(acceptor);
		}
	});

	it("closes a connection with no acceptor registered", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		try {
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(
					initiator.keys,
					grantBetween(initiator, acceptor),
				),
				signal: new AbortController().signal,
			});
			expect(outcome).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
		} finally {
			await stopAll(initiator, acceptor);
		}
	});

	it("closes connections beyond its limit", async () => {
		const initiator = await device();
		const acceptor = await device(
			createOverlayTransportWith(fakeOverlay(), { maxConnections: 0 }),
		);
		const accepting = acceptOn(acceptor, () => true);
		try {
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(
					initiator.keys,
					grantBetween(initiator, acceptor),
				),
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(false);
			expect(accepting.seen).toHaveLength(0);
		} finally {
			await accepting.subscription.stop();
			await stopAll(initiator, acceptor);
		}
	});

	it("a stopped subscription leaves a newer one accepting", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		const older = acceptOn(acceptor, () => true);
		const newer = acceptOn(acceptor, () => true);
		await older.subscription.stop();
		try {
			const outcome = await initiator.transport.dial({
				grant: await envelopeOf(
					initiator.keys,
					grantBetween(initiator, acceptor),
				),
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(true);
			if (outcome.ok) await outcome.value.close();
			expect(newer.seen).toHaveLength(1);
		} finally {
			await newer.subscription.stop();
			await stopAll(initiator, acceptor);
		}
	});
});

async function firstChunk(stream: FleetStream): Promise<Uint8Array> {
	for await (const chunk of stream.read()) return chunk;
	throw new Error("the stream ended");
}

describe("overlay identity", () => {
	const seal = "A".repeat(43);

	it("round-trips IPv4 and bracketed IPv6 addresses", () => {
		for (const host of ["100.64.0.1", "fd7a:115c:a1e0::1"]) {
			const identity = formatOverlayIdentity({
				sealPublicKey: seal,
				host,
				port: 41_641,
			});
			expect(parseOverlayIdentity(identity)).toEqual({
				sealPublicKey: seal,
				host,
				port: 41_641,
			});
		}
		expect(
			formatOverlayIdentity({ sealPublicKey: seal, host: "::1", port: 1 }),
		).toBe(`overlay:${seal}@[::1]:1`);
	});

	it.each([
		"relay:abc",
		`overlay:${seal}@100.64.0.1`,
		`overlay:${seal}@100.64.0.1:0`,
		`overlay:${seal}@100.64.0.1:70000`,
		`overlay:${seal}@999.1.1.1:1`,
		`overlay:${seal}@[zz::1]:1`,
		`overlay:short@100.64.0.1:1`,
		`overlay:${seal}@host.example:1`,
	])("refuses %s", (identity) => {
		expect(parseOverlayIdentity(identity)).toBeUndefined();
	});

	it("normalises an IPv4-mapped IPv6 source and prefers an IPv4 overlay address", () => {
		expect(normaliseHost("::ffff:100.64.0.1")).toBe("100.64.0.1");
		expect(normaliseHost("FD7A::1")).toBe("fd7a::1");
		expect(overlayHost(["fd7a::1", "100.64.0.1"])).toBe("100.64.0.1");
		expect(overlayHost(["fd7a::1"])).toBe("fd7a::1");
		expect(overlayHost(["nope"])).toBeUndefined();
	});
});

describe("overlay wire codec", () => {
	it("round-trips a signed grant through the fleet's own envelope encoding", async () => {
		const [initiator, acceptor] = [await device(), await device()];
		try {
			const grant = grantBetween(initiator, acceptor);
			const envelope = await envelopeOf(initiator.keys, grant);
			const decoded = decodeSignedEnvelope(encodeSignedEnvelope(envelope));
			expect(decoded).toMatchObject({
				context: envelope.context,
				keyId: envelope.keyId,
				algorithm: envelope.algorithm,
			});
			expect([...decoded.signature]).toEqual([...envelope.signature]);
			expect(decodeSessionGrant(decoded.payload)).toEqual(grant);
		} finally {
			await stopAll(initiator, acceptor);
		}
	});

	it("decodes absent fields to their defaults and skips unknown fields", () => {
		// field 15 varint 1, field 14 fixed64, field 13 fixed32, field 2 = "acme"
		const bytes = new Uint8Array([
			0x78, 0x01, 0x71, 1, 2, 3, 4, 5, 6, 7, 8, 0x6d, 1, 2, 3, 4, 0x12, 4, 97,
			99, 109, 101,
		]);
		const grant = decodeSessionGrant(bytes);
		expect(grant).toMatchObject({
			tenant: "acme",
			sessionId: "",
			purpose: 0,
			blobDigests: [],
		});
		expect(grant.initiator).toBeUndefined();
	});

	it.each([
		["a truncated varint", [0x08]],
		["a truncated field", [0x0a, 0x05, 1]],
		["a truncated fixed field", [0x71, 1, 2]],
		["field number zero", [0x00, 0x01]],
		["an unsupported wire type", [0x0b]],
		["a varint that never ends", Array.from({ length: 11 }, () => 0xff)],
		["a string field sent as a varint", [0x0a, 0x00, 0x08, 0x01]],
		["a repeated digest sent as a varint", [0x40, 0x01]],
		["invalid UTF-8", [0x12, 0x01, 0xff]],
	])("refuses %s", (_name, bytes) => {
		expect(() => decodeSessionGrant(new Uint8Array(bytes))).toThrow();
	});
});
