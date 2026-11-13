/**
 * The bus-relay transport (L37 isolated checks): `runTransportConformance`
 * over two transports sharing one in-memory bus, and the transport's own
 * rules: dialling fails `unavailable` without a bus, the bus only ever sees
 * ciphertext, a forged frame fails authentication, every dial gets its own
 * relay session and keys, and a refused or stopped acceptor delivers nothing.
 */
import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type DeviceKeys,
	type FleetBus,
	type FleetStream,
	type MemberId,
	SESSION_GRANT_CONTEXT,
	SessionGrantSchema,
	SessionPurpose,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import { createMemoryKeyStore } from "@hobo/fleet/keys";
import { createMemoryBus, runTransportConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createBusRelayTransport } from "../../src/relay/index.js";
import { createRelayTransport } from "../../src/relay/transport.js";
import {
	decodeRelayMessage,
	encodeRelayMessage,
	RELAY_MESSAGE,
	relayIdentity,
} from "../../src/relay/wire.js";

runTransportConformance(async () => {
	const bus = createMemoryBus(Date.now);
	return [
		createRelayTransport(() => bus, { handshakeTimeoutMs: 2_000 }),
		createRelayTransport(() => bus, { handshakeTimeoutMs: 2_000 }),
	] as const;
});

/** A bus whose relay port records every frame it carries, and can inject frames. */
type SentFrame = { to: MemberId; sessionId: string; frame: Uint8Array };

function recordingBus() {
	const inner = createMemoryBus(Date.now);
	const sent: SentFrame[] = [];
	const bus: FleetBus = {
		...inner,
		relay: {
			async send(to, sessionId, frame) {
				sent.push({ to, sessionId, frame: frame.slice() });
				await inner.relay.send(to, sessionId, frame);
			},
			subscribe: (self, handler) => inner.relay.subscribe(self, handler),
		},
	};
	return { bus, sent };
}

async function deviceKeys(): Promise<DeviceKeys> {
	return createMemoryKeyStore().open();
}

/** A grant between two started devices, signed by a throwaway key (the acceptor's `authorise` decides). */
async function grantBetween(
	initiator: Readonly<{ keys: DeviceKeys; identity: string }>,
	acceptor: Readonly<{ keys: DeviceKeys; identity: string }>,
	sessionId = `ses_${randomBytes(8).toString("hex")}`,
): Promise<SignedEnvelope> {
	const now = Date.now();
	const grant = create(SessionGrantSchema, {
		sessionId,
		tenant: "relay-test",
		initiator: {
			memberId: initiator.keys.memberId,
			transportIdentity: initiator.identity,
			sealPublicKey: initiator.keys.sealPublicKey,
		},
		acceptor: {
			memberId: acceptor.keys.memberId,
			transportIdentity: acceptor.identity,
			sealPublicKey: acceptor.keys.sealPublicKey,
		},
		purpose: SessionPurpose.BLOB,
		issuedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 60_000).toISOString(),
	});
	return create(SignedEnvelopeSchema, {
		context: SESSION_GRANT_CONTEXT,
		keyId: "test#1",
		payload: toBinary(SessionGrantSchema, grant),
		signature: randomBytes(64),
	});
}

async function readBytes(stream: FleetStream, count: number) {
	const parts: Uint8Array[] = [];
	let got = 0;
	for await (const chunk of stream.read()) {
		parts.push(chunk);
		got += chunk.length;
		if (got >= count) break;
	}
	return Buffer.concat(parts);
}

async function startedPair(bus: () => FleetBus | undefined) {
	const first = createRelayTransport(bus, { handshakeTimeoutMs: 1_000 });
	const second = createRelayTransport(bus, { handshakeTimeoutMs: 1_000 });
	const firstKeys = await deviceKeys();
	const secondKeys = await deviceKeys();
	const initiator = {
		transport: first,
		keys: firstKeys,
		identity: (await first.start(firstKeys)).transportIdentity,
	};
	const acceptor = {
		transport: second,
		keys: secondKeys,
		identity: (await second.start(secondKeys)).transportIdentity,
	};
	return { initiator, acceptor };
}

describe("the bus-relay transport", () => {
	it("is a bus-relay transport whose identity is bound to the SEAL key", async () => {
		const transport = createBusRelayTransport(() => undefined);
		expect(transport.kind).toBe("bus-relay");
		const keys = await deviceKeys();
		const { transportIdentity } = await transport.start(keys);
		expect(transportIdentity).toBe(relayIdentity(keys.sealPublicKey));
		await transport.stop();
	});

	it("fails a dial `unavailable` while the agent has no bus", async () => {
		let current: FleetBus | undefined;
		const { initiator, acceptor } = await startedPair(() => current);
		const grant = await grantBetween(initiator, acceptor);
		const outcome = await initiator.transport.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("unavailable");
		// Once the bus is there, the same transports carry a session.
		current = createMemoryBus(Date.now);
		acceptor.transport.accept(
			async () => true,
			async (stream) => {
				await stream.write(new Uint8Array([7]));
			},
		);
		const later = await initiator.transport.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(later.ok).toBe(true);
		if (later.ok) {
			expect([...(await readBytes(later.value, 1))]).toEqual([7]);
			await later.value.close();
		}
		await initiator.transport.stop();
		await acceptor.transport.stop();
	});

	it("puts only ciphertext on the bus, one relay session per dial", async () => {
		const { bus, sent } = recordingBus();
		const { initiator, acceptor } = await startedPair(() => bus);
		const secret = Buffer.from("plaintext-marker-".repeat(64));
		acceptor.transport.accept(
			async () => true,
			async (stream) => {
				const got = await readBytes(stream, secret.length);
				await stream.write(got);
			},
		);
		const grant = await grantBetween(initiator, acceptor);
		for (let round = 0; round < 2; round += 1) {
			const outcome = await initiator.transport.dial({
				grant,
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			await outcome.value.write(secret);
			expect(
				(await readBytes(outcome.value, secret.length)).equals(secret),
			).toBe(true);
			await outcome.value.close();
		}
		const marker = Buffer.from("plaintext-marker-");
		expect(
			sent.some((entry) => Buffer.from(entry.frame).includes(marker)),
		).toBe(false);
		const sessions = new Set(sent.map((entry) => entry.sessionId));
		expect(sessions.size).toBe(2);
		for (const session of sessions) expect(session).toMatch(/^[0-9a-f]{32}$/u);
		expect(
			sent.every(
				(entry) =>
					entry.to === initiator.keys.memberId ||
					entry.to === acceptor.keys.memberId,
			),
		).toBe(true);
		await initiator.transport.stop();
		await acceptor.transport.stop();
	});

	it("fails authentication on a forged frame", async () => {
		const { bus, sent } = recordingBus();
		const { initiator, acceptor } = await startedPair(() => bus);
		let failure: Error | undefined;
		let received = 0;
		acceptor.transport.accept(
			async () => true,
			async (stream) => {
				try {
					for await (const chunk of stream.read()) received += chunk.length;
				} catch (error) {
					failure = error instanceof Error ? error : new Error("failed");
				}
			},
		);
		const outcome = await initiator.transport.dial({
			grant: await grantBetween(initiator, acceptor),
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const session = sent[0]?.sessionId ?? "";
		// A forged frame: well-formed length, random ciphertext.
		const forged = Buffer.alloc(4 + 32);
		forged.writeUInt32BE(32, 0);
		randomBytes(32).copy(forged, 4);
		await bus.relay.send(
			acceptor.keys.memberId,
			session,
			encodeRelayMessage({ type: RELAY_MESSAGE.DATA, payload: forged }),
		);
		await expect
			.poll(() => failure?.message, { timeout: 5_000 })
			.toMatch(/authentication/u);
		expect(received).toBe(0);
		await outcome.value.close();
		await initiator.transport.stop();
		await acceptor.transport.stop();
	});

	it("refuses a grant naming another acceptor without asking authorise", async () => {
		const bus = createMemoryBus(Date.now);
		const { initiator, acceptor } = await startedPair(() => bus);
		const stranger = await deviceKeys();
		let asked = 0;
		let handled = 0;
		acceptor.transport.accept(
			async () => {
				asked += 1;
				return true;
			},
			async () => {
				handled += 1;
			},
		);
		// Addressed to the acceptor's member id, but naming another device's SEAL key.
		const grant = await grantBetween(initiator, {
			keys: { ...acceptor.keys, sealPublicKey: stranger.sealPublicKey },
			identity: acceptor.identity,
		});
		const outcome = await initiator.transport.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("session-denied");
		expect(asked).toBe(0);
		expect(handled).toBe(0);
		await initiator.transport.stop();
		await acceptor.transport.stop();
	});

	it("answers a refusal as `session-denied` and an unreachable acceptor as `unavailable`", async () => {
		const bus = createMemoryBus(Date.now);
		const { initiator, acceptor } = await startedPair(() => bus);
		const grant = await grantBetween(initiator, acceptor);
		const absent = await deviceKeys();
		const nobody = await initiator.transport.dial({
			grant: await grantBetween(initiator, {
				keys: absent,
				identity: relayIdentity(absent.sealPublicKey),
			}),
			signal: new AbortController().signal,
		});
		expect(nobody.ok).toBe(false);
		if (!nobody.ok) expect(nobody.error.code).toBe("unavailable");
		// A started transport that accepts nothing refuses at once.
		const idle = await initiator.transport.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(idle.ok).toBe(false);
		if (!idle.ok) expect(idle.error.code).toBe("session-denied");
		const subscription = acceptor.transport.accept(
			async () => false,
			async () => undefined,
		);
		const refused = await initiator.transport.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.code).toBe("session-denied");
		await subscription.stop();
		await initiator.transport.stop();
		await acceptor.transport.stop();
	});

	it("fails a dial whose grant does not decode as `invalid-request`", async () => {
		const bus = createMemoryBus(Date.now);
		const { initiator } = await startedPair(() => bus);
		const outcome = await initiator.transport.dial({
			grant: create(SignedEnvelopeSchema, {
				context: SESSION_GRANT_CONTEXT,
				payload: new Uint8Array([0xff, 0xff, 0xff]),
			}),
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("invalid-request");
		await initiator.transport.stop();
	});

	it("fails a dial before start", async () => {
		const bus = createMemoryBus(Date.now);
		const transport = createRelayTransport(() => bus);
		const keys = await deviceKeys();
		const outcome = await transport.dial({
			grant: await grantBetween(
				{ keys, identity: relayIdentity(keys.sealPublicKey) },
				{ keys, identity: relayIdentity(keys.sealPublicKey) },
			),
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("unavailable");
	});
});

describe("the relay wire", () => {
	it("round-trips every message type", () => {
		const grant = new Uint8Array([1, 2, 3]);
		const messages = [
			{ type: RELAY_MESSAGE.OPEN, from: "mem_abc", grant } as const,
			{ type: RELAY_MESSAGE.DATA, payload: new Uint8Array([9, 8]) } as const,
			{ type: RELAY_MESSAGE.CREDIT, bytes: 65_536 } as const,
			{ type: RELAY_MESSAGE.END } as const,
			{ type: RELAY_MESSAGE.RESET } as const,
		];
		for (const message of messages)
			expect(decodeRelayMessage(encodeRelayMessage(message))).toEqual(message);
	});

	it("rejects malformed messages", () => {
		for (const bytes of [
			new Uint8Array([]),
			new Uint8Array([0]),
			new Uint8Array([99]),
			new Uint8Array([RELAY_MESSAGE.OPEN]),
			new Uint8Array([RELAY_MESSAGE.OPEN, 200, 1]),
			new Uint8Array([RELAY_MESSAGE.CREDIT, 1, 2]),
			new Uint8Array([RELAY_MESSAGE.END, 1]),
		])
			expect(decodeRelayMessage(bytes)).toBeUndefined();
	});
});
