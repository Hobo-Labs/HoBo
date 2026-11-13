/**
 * O31 (session half): `authoriseSession` refuses each way a grant can be
 * wrong; `serveSessions` refuses before any byte; AEAD framing with a counter
 * nonce carries 64 MiB with a matching digest and refuses tampering;
 * shell and blob sessions run inside the order's sandbox; the acceptor
 * publishes a signed session-close fact; `fetchBlob` verifies the digest.
 */
import { createHash, randomBytes } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MemberState,
	PublicKeyRefSchema,
	type SessionClose,
	SessionCloseSchema,
	SessionPurpose,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	SESSION_CLOSE_CONTEXT,
	SESSION_TICKET_CONTEXT,
} from "../../src/contexts.js";
import type { MemberId } from "../../src/ids.js";
import {
	createMemoryKeyStore,
	sessionKeys,
	verifyEnvelope,
} from "../../src/keys/index.js";
import type {
	DeviceKeys,
	FleetLogEvent,
	FleetStream,
	Sandbox,
	Subscription,
} from "../../src/ports.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";
import {
	authoriseSession,
	fetchBlob,
	frameStream,
	serveSessions,
} from "../../src/transport/index.js";
import {
	readMessages,
	SESSION_TAG,
	writeMessage,
} from "../../src/transport/wire.js";
import {
	type AuthorityKey,
	authorityKey,
	fleetRecord,
	type GrantInput,
	grantRecord,
	memberRecord,
	memoryNetwork,
	memoryRegistry,
	memoryStreamPair,
	memoryTransport,
	scriptedSandbox,
	signGrant,
} from "./doubles.js";

const MIB = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAllBytes(stream: FleetStream): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of stream.read()) parts.push(chunk);
	return new Uint8Array(Buffer.concat(parts));
}

async function devices(): Promise<
	Readonly<{ initiator: DeviceKeys; acceptor: DeviceKeys }>
> {
	return {
		initiator: await createMemoryKeyStore().open(),
		acceptor: await createMemoryKeyStore().open(),
	};
}

describe("frameStream", () => {
	it("an in-memory pair carries 64 MiB with a matching digest, and an answer back", async () => {
		const keys = sessionKeys(randomBytes(32), "ses_bulk");
		const [rawA, rawB] = memoryStreamPair();
		const initiator = frameStream(rawA, {
			send: keys.initiatorToAcceptor,
			receive: keys.acceptorToInitiator,
		});
		const acceptor = frameStream(rawB, {
			send: keys.acceptorToInitiator,
			receive: keys.initiatorToAcceptor,
		});
		const chunk = randomBytes(MIB);
		const sent = createHash("sha256");
		const received = createHash("sha256");
		let receivedBytes = 0;
		const served = (async () => {
			for await (const part of acceptor.read()) {
				received.update(part);
				receivedBytes += part.length;
				if (receivedBytes === 64 * MIB) break;
			}
			await acceptor.write(encoder.encode("thanks"));
			return acceptor.close();
		})();
		for (let index = 0; index < 64; index += 1) {
			sent.update(chunk);
			await initiator.write(chunk);
		}
		const answer = await readAllBytes(initiator);
		const acceptorCounts = await served;
		const initiatorCounts = await initiator.close();
		expect(receivedBytes).toBe(64 * MIB);
		expect(received.digest("hex")).toBe(sent.digest("hex"));
		expect(decoder.decode(answer)).toBe("thanks");
		expect(initiatorCounts).toEqual({ bytesSent: 64 * MIB, bytesReceived: 6 });
		expect(acceptorCounts).toEqual({ bytesSent: 6, bytesReceived: 64 * MIB });
	}, 60_000);

	it("puts only ciphertext on the raw stream", async () => {
		const keys = sessionKeys(randomBytes(32), "ses_ct");
		const [rawA, rawB] = memoryStreamPair();
		const framed = frameStream(rawA, {
			send: keys.initiatorToAcceptor,
			receive: keys.acceptorToInitiator,
		});
		const secret = encoder.encode("a very recognisable secret");
		await framed.write(secret);
		await framed.close();
		const onWire = Buffer.from(await readAllBytes(rawB));
		expect(onWire.includes(Buffer.from(secret))).toBe(false);
	});

	it("refuses a tampered frame", async () => {
		const keys = sessionKeys(randomBytes(32), "ses_tamper");
		const [rawA, rawB] = memoryStreamPair();
		const sender = frameStream(rawA, {
			send: keys.initiatorToAcceptor,
			receive: keys.acceptorToInitiator,
		});
		await sender.write(encoder.encode("hello"));
		await sender.close();
		const wire = await readAllBytes(rawB);
		const tampered = wire.slice();
		tampered[6] = (tampered[6] ?? 0) ^ 0x01;
		const [rawC, rawD] = memoryStreamPair();
		await rawC.write(tampered);
		await rawC.close();
		const receiver = frameStream(rawD, {
			send: keys.acceptorToInitiator,
			receive: keys.initiatorToAcceptor,
		});
		await expect(readAllBytes(receiver)).rejects.toThrow(/authenticat/);
	});

	it("refuses frames under another key, replayed or reordered frames, and a truncated stream", async () => {
		const keys = sessionKeys(randomBytes(32), "ses_order");
		const wireOf = async (messages: readonly string[]) => {
			const [rawA, rawB] = memoryStreamPair();
			const sender = frameStream(rawA, {
				send: keys.initiatorToAcceptor,
				receive: keys.acceptorToInitiator,
			});
			for (const message of messages)
				await sender.write(encoder.encode(message));
			await sender.close();
			return readAllBytes(rawB);
		};
		const receive = async (
			wire: Uint8Array,
			key = keys.initiatorToAcceptor,
		) => {
			const [rawC, rawD] = memoryStreamPair();
			await rawC.write(wire);
			await rawC.close();
			return readAllBytes(
				frameStream(rawD, { send: keys.acceptorToInitiator, receive: key }),
			);
		};
		const wire = await wireOf(["one", "two"]);
		expect(decoder.decode(await receive(wire))).toBe("onetwo");
		await expect(receive(wire, keys.acceptorToInitiator)).rejects.toThrow(
			/authenticat/,
		);
		// Each data frame is 4 + 3 + 16 = 23 bytes; swap the first two.
		const first = wire.subarray(0, 23);
		const second = wire.subarray(23, 46);
		const rest = wire.subarray(46);
		await expect(
			receive(new Uint8Array(Buffer.concat([second, first, rest]))),
		).rejects.toThrow(/authenticat/);
		await expect(
			receive(new Uint8Array(Buffer.concat([first, first, rest]))),
		).rejects.toThrow(/authenticat/);
		await expect(receive(wire.subarray(0, 46))).rejects.toThrow(/truncated/);
	});
});

type Fixture = Readonly<{
	authority: AuthorityKey;
	registry: ReturnType<typeof memoryRegistry>;
	initiator: DeviceKeys;
	acceptor: DeviceKeys;
	initiatorIdentity: string;
	acceptorIdentity: string;
	now: number;
	grant(overrides?: Partial<GrantInput>): Promise<SignedEnvelope>;
}>;

async function fixture(): Promise<Fixture> {
	const authority = authorityKey();
	const registry = memoryRegistry(authority);
	const { initiator, acceptor } = await devices();
	registry.putMember(memberRecord(initiator.memberId));
	registry.putMember(memberRecord(acceptor.memberId));
	registry.putFleet(fleetRecord());
	const initiatorIdentity = `p2p:${initiator.memberId}`;
	const acceptorIdentity = `p2p:${acceptor.memberId}`;
	const now = Date.now();
	return {
		authority,
		registry,
		initiator,
		acceptor,
		initiatorIdentity,
		acceptorIdentity,
		now,
		grant: (overrides = {}) =>
			signGrant(
				authority.signer,
				grantRecord({
					initiator: {
						memberId: initiator.memberId,
						transportIdentity: initiatorIdentity,
					},
					acceptor: {
						memberId: acceptor.memberId,
						transportIdentity: acceptorIdentity,
					},
					nowMs: now,
					...overrides,
				}),
			),
	};
}

describe("authoriseSession", () => {
	const check = (f: Fixture, peer: string, grant: SignedEnvelope) =>
		authoriseSession(peer, grant, {
			self: f.acceptor.memberId,
			registry: f.registry,
			nowMs: f.now,
		});

	it("accepts a grant signed by the authority, for this acceptor, from the named peer", async () => {
		const f = await fixture();
		const outcome = await check(f, f.initiatorIdentity, await f.grant());
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.value.purpose).toBe(SessionPurpose.BLOB);
	});

	it("accepts a person's CLI as initiator (no member id, a principal)", async () => {
		const f = await fixture();
		const grant = await f.grant({
			initiator: {
				memberId: "",
				principal: "user:alice",
				transportIdentity: "cli-key",
			},
		});
		expect((await check(f, "cli-key", grant)).ok).toBe(true);
	});

	const refusals: readonly Readonly<{
		name: string;
		check: string;
		make(
			f: Fixture,
		): Promise<Readonly<{ peer?: string; grant: SignedEnvelope }>>;
		prepare?(f: Fixture): void;
	}>[] = [
		{
			name: "no grant (an empty envelope)",
			check: "context",
			make: async () => ({ grant: create(SignedEnvelopeSchema) }),
		},
		{
			name: "a grant under another context",
			check: "context",
			make: async (f) => ({
				grant: await signGrant(
					f.authority.signer,
					grantRecord({
						initiator: {
							memberId: f.initiator.memberId,
							transportIdentity: f.initiatorIdentity,
						},
						acceptor: {
							memberId: f.acceptor.memberId,
							transportIdentity: f.acceptorIdentity,
						},
					}),
					SESSION_TICKET_CONTEXT,
				),
			}),
		},
		{
			name: "a grant not signed by the authority",
			check: "signature",
			make: async (f) => ({
				grant: await signGrant(
					authorityKey(1).signer,
					grantRecord({
						initiator: {
							memberId: f.initiator.memberId,
							transportIdentity: f.initiatorIdentity,
						},
						acceptor: {
							memberId: f.acceptor.memberId,
							transportIdentity: f.acceptorIdentity,
						},
					}),
				),
			}),
		},
		{
			name: "an expired grant",
			check: "expired",
			make: async (f) => ({ grant: await f.grant({ expiresInMs: -1 }) }),
		},
		{
			name: "a grant issued in the future",
			check: "issued",
			make: async (f) => ({
				grant: await f.grant({ nowMs: f.now + 10 * 60_000 }),
			}),
		},
		{
			name: "a grant living longer than an hour",
			check: "lifetime",
			make: async (f) => ({
				grant: await f.grant({ expiresInMs: 2 * 3_600_000 }),
			}),
		},
		{
			name: "the wrong peer",
			check: "peer",
			make: async (f) => ({ peer: "p2p:someone-else", grant: await f.grant() }),
		},
		{
			name: "a grant for another acceptor",
			check: "acceptor",
			make: async (f) => ({
				grant: await f.grant({
					acceptor: {
						memberId: f.initiator.memberId,
						transportIdentity: f.acceptorIdentity,
					},
				}),
			}),
		},
		{
			name: "another tenant",
			check: "tenant",
			make: async (f) => ({ grant: await f.grant({ tenant: "other" }) }),
		},
		{
			name: "the initiator is not ACTIVE",
			check: "initiator-state",
			prepare: (f) =>
				f.registry.putMember(
					memberRecord(f.initiator.memberId, MemberState.SUSPENDED),
				),
			make: async (f) => ({ grant: await f.grant() }),
		},
		{
			name: "the acceptor is not ACTIVE",
			check: "acceptor-state",
			prepare: (f) =>
				f.registry.putMember(
					memberRecord(f.acceptor.memberId, MemberState.LOCKED),
				),
			make: async (f) => ({ grant: await f.grant() }),
		},
		{
			name: "the initiator is unknown",
			check: "initiator-state",
			make: async (f) => ({
				grant: await f.grant({
					initiator: {
						memberId: "dev_ffffffffffffffffffffffffffffffff",
						transportIdentity: f.initiatorIdentity,
					},
				}),
			}),
		},
		{
			name: "a person with no principal",
			check: "initiator-state",
			make: async (f) => ({
				grant: await f.grant({
					initiator: { memberId: "", transportIdentity: f.initiatorIdentity },
				}),
			}),
		},
		{
			name: "the purpose is not allowed by fleet policy",
			check: "purpose",
			prepare: (f) => f.registry.putFleet(fleetRecord([SessionPurpose.BLOB])),
			make: async (f) => ({
				grant: await f.grant({
					purpose: SessionPurpose.SHELL,
					orderId: "ord_1",
				}),
			}),
		},
		{
			name: "a forward without a port",
			check: "constraint",
			make: async (f) => ({
				grant: await f.grant({ purpose: SessionPurpose.FORWARD, port: 0 }),
			}),
		},
		{
			name: "a blob grant without digests",
			check: "constraint",
			make: async (f) => ({ grant: await f.grant({ blobDigests: [] }) }),
		},
	];

	for (const refusal of refusals) {
		it(`refuses ${refusal.name}`, async () => {
			const f = await fixture();
			refusal.prepare?.(f);
			const { peer, grant } = await refusal.make(f);
			const outcome = await check(f, peer ?? f.initiatorIdentity, grant);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error.code).toBe("session-denied");
				expect(outcome.error.detail?.check).toBe(refusal.check);
			}
		});
	}
});

describe("authoriseSession, bus-relay parties (D59)", () => {
	/** The member record with a key bundle naming `seal` as its SEAL key. */
	function withSeal(memberId: MemberId, seal: string) {
		const record = memberRecord(memberId);
		record.keyBundle = create(SignedEnvelopeSchema, {
			payload: toBinary(
				KeyBundleSchema,
				create(KeyBundleSchema, {
					memberId,
					sequence: 1,
					keys: [
						create(PublicKeyRefSchema, {
							purpose: KeyPurpose.SEAL,
							keyId: `${memberId}#seal`,
							value: seal,
						}),
					],
				}),
			),
		});
		return record;
	}

	async function relayGrant(
		f: Fixture,
		options: Readonly<{
			identity?: string;
			seal?: string;
			memberId?: string;
			principal?: string;
		}> = {},
	): Promise<Readonly<{ peer: string; grant: SignedEnvelope }>> {
		const seal = options.seal ?? f.initiator.sealPublicKey;
		const identity = options.identity ?? `relay:${seal}`;
		const record = grantRecord({
			initiator: {
				memberId: options.memberId ?? f.initiator.memberId,
				principal: options.principal ?? "",
				transportIdentity: identity,
			},
			acceptor: {
				memberId: f.acceptor.memberId,
				transportIdentity: `relay:${f.acceptor.sealPublicKey}`,
			},
			nowMs: f.now,
		});
		if (record.initiator !== undefined) record.initiator.sealPublicKey = seal;
		return {
			peer: identity,
			grant: await signGrant(f.authority.signer, record),
		};
	}

	const check = (f: Fixture, peer: string, grant: SignedEnvelope) =>
		authoriseSession(peer, grant, {
			self: f.acceptor.memberId,
			registry: f.registry,
			nowMs: f.now,
		});

	async function relayFixture(): Promise<Fixture> {
		const f = await fixture();
		f.registry.putMember(
			withSeal(f.initiator.memberId, f.initiator.sealPublicKey),
		);
		return f;
	}

	it("accepts relay:<SEAL key> when it is the initiator's SEAL key in its member record", async () => {
		const f = await relayFixture();
		expect(f.initiator.sealPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const { peer, grant } = await relayGrant(f);
		const outcome = await check(f, peer, grant);
		expect(outcome.ok).toBe(true);
		if (outcome.ok)
			expect(outcome.value.initiator?.transportIdentity).toBe(
				`relay:${f.initiator.sealPublicKey}`,
			);
	});

	const refusals: readonly Readonly<{
		name: string;
		make(
			f: Fixture,
		): Promise<Readonly<{ peer: string; grant: SignedEnvelope }>>;
		prepare?(f: Fixture): void;
	}>[] = [
		{
			name: "a SEAL key that is not the member's",
			make: async (f) => relayGrant(f, { seal: f.acceptor.sealPublicKey }),
		},
		{
			name: "a member record with no key bundle",
			prepare: (f) => f.registry.putMember(memberRecord(f.initiator.memberId)),
			make: async (f) => relayGrant(f),
		},
		{
			name: "a SEAL key that is not raw X25519 in base64url",
			prepare: (f) =>
				f.registry.putMember(withSeal(f.initiator.memberId, "c2hvcnQ")),
			make: async (f) => relayGrant(f, { seal: "c2hvcnQ" }),
		},
		{
			name: "a relay identity whose key differs from the grant's seal_public_key",
			make: async (f) =>
				relayGrant(f, {
					identity: `relay:${f.acceptor.sealPublicKey}`,
					seal: f.initiator.sealPublicKey,
				}),
		},
		{
			name: "a person's CLI (no member record to check against)",
			make: async (f) =>
				relayGrant(f, { memberId: "", principal: "user:alice" }),
		},
	];

	for (const refusal of refusals) {
		it(`refuses ${refusal.name} (check relay)`, async () => {
			const f = await relayFixture();
			refusal.prepare?.(f);
			const { peer, grant } = await refusal.make(f);
			const outcome = await check(f, peer, grant);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error.code).toBe("session-denied");
				expect(outcome.error.detail?.check).toBe("relay");
			}
		});
	}

	it("still refuses a relay identity that is not the proven peer (check peer)", async () => {
		const f = await relayFixture();
		const { grant } = await relayGrant(f);
		const outcome = await check(f, `relay:${f.acceptor.sealPublicKey}`, grant);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.detail?.check).toBe("peer");
	});
});

type Served = Readonly<{
	f: Fixture;
	network: ReturnType<typeof memoryNetwork>;
	dialler: ReturnType<typeof memoryTransport>;
	bus: ReturnType<typeof createMemoryBus>;
	sandbox: ReturnType<typeof scriptedSandbox>;
	logs: FleetLogEvent[];
	subscription: Subscription;
}>;

const running: Subscription[] = [];
afterEach(async () => {
	for (const subscription of running.splice(0)) await subscription.stop();
});

const BLOB = encoder.encode("cache bytes ".repeat(10_000));
const BLOB_DIGEST = `sha256:${createHash("sha256").update(BLOB).digest("hex")}`;

async function served(
	options: Readonly<{ sandboxFor?: string; blob?: Uint8Array }> = {},
): Promise<Served> {
	const f = await fixture();
	const network = memoryNetwork();
	const accepting = memoryTransport(network, "p2p");
	await accepting.start(f.acceptor);
	const dialler = memoryTransport(network, "p2p");
	await dialler.start(f.initiator);
	const bus = createMemoryBus(() => Date.now());
	const blob = options.blob ?? BLOB;
	const sandbox = scriptedSandbox(async (argv, stdin, output) => {
		if (argv[0] === "cat") {
			if (argv[1] === `/hobo/blobs/sha256/${BLOB_DIGEST.slice(7)}`) {
				output(blob.subarray(0, 1000));
				output(blob.subarray(1000));
				return 0;
			}
			return 1;
		}
		if (decoder.decode(stdin) === "boom") throw new Error("exec failed");
		output(encoder.encode(`ran: ${decoder.decode(stdin)}`));
		return 7;
	});
	const logs: FleetLogEvent[] = [];
	const subscription = serveSessions({
		transports: [accepting],
		registry: f.registry,
		self: f.acceptor,
		sandboxOf: (orderId): Sandbox | undefined =>
			orderId === (options.sandboxFor ?? "ord_1") ? sandbox : undefined,
		bus,
		now: () => Date.now(),
		log: (event) => logs.push(event),
	});
	running.push(subscription);
	return { f, network, dialler, bus, sandbox, logs, subscription };
}

function closeFacts(s: Served) {
	const facts: SessionClose[] = [];
	const envelopes: SignedEnvelope[] = [];
	const from: MemberId[] = [];
	running.push(
		s.bus.events.subscribe(
			["session-close"],
			"start",
			async (event, member) => {
				envelopes.push(event);
				from.push(member);
				facts.push(fromBinary(SessionCloseSchema, event.payload));
			},
		),
	);
	return { facts, envelopes, from };
}

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("serveSessions", () => {
	const deniedCases: readonly Readonly<{
		name: string;
		make(s: Served): Promise<SignedEnvelope>;
		prepare?(s: Served): void;
	}>[] = [
		{ name: "no grant", make: async () => create(SignedEnvelopeSchema) },
		{
			name: "an expired grant",
			make: (s) =>
				s.f.grant({
					purpose: SessionPurpose.SHELL,
					orderId: "ord_1",
					expiresInMs: -1,
				}),
		},
		{
			name: "a grant naming another peer",
			make: (s) =>
				s.f.grant({
					purpose: SessionPurpose.SHELL,
					orderId: "ord_1",
					initiator: {
						memberId: s.f.initiator.memberId,
						transportIdentity: "p2p:not-the-dialler",
					},
				}),
		},
		{
			name: "a member not ACTIVE",
			prepare: (s) =>
				s.f.registry.putMember(
					memberRecord(s.f.initiator.memberId, MemberState.REVOKED),
				),
			make: (s) =>
				s.f.grant({ purpose: SessionPurpose.SHELL, orderId: "ord_1" }),
		},
		{
			name: "a purpose policy does not allow",
			prepare: (s) => s.f.registry.putFleet(fleetRecord([SessionPurpose.BLOB])),
			make: (s) =>
				s.f.grant({ purpose: SessionPurpose.SHELL, orderId: "ord_1" }),
		},
	];

	for (const denied of deniedCases) {
		it(`refuses ${denied.name} before any byte`, async () => {
			const s = await served();
			denied.prepare?.(s);
			const grant = await denied.make(s);
			const outcome = await s.dialler.dial({
				grant,
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(s.network.handed).toEqual([]);
			expect(s.sandbox.runs).toEqual([]);
		});
	}

	it("runs a shell inside the order's sandbox and publishes a signed session-close fact", async () => {
		const s = await served();
		const { facts, envelopes, from } = closeFacts(s);
		const grant = await s.f.grant({
			purpose: SessionPurpose.SHELL,
			orderId: "ord_1",
			sessionId: "ses_shell",
		});
		const outcome = await s.dialler.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const stream = outcome.value;
		await writeMessage(stream, SESSION_TAG.INPUT, encoder.encode("echo hi"));
		await writeMessage(stream, SESSION_TAG.END, new Uint8Array());
		let output = "";
		let exit: number | undefined;
		for await (const message of readMessages(stream)) {
			if (message.tag === SESSION_TAG.OUTPUT)
				output += decoder.decode(message.payload);
			if (message.tag === SESSION_TAG.EXIT) {
				exit = Buffer.from(message.payload).readInt32BE(0);
				break;
			}
		}
		const counts = await stream.close();
		expect(output).toBe("ran: echo hi");
		expect(exit).toBe(7);
		expect(s.sandbox.runs).toEqual([["/bin/sh", "-s"]]);
		await until(() => facts.length === 1);
		const fact = facts[0];
		const envelope = envelopes[0];
		expect(fact?.sessionId).toBe("ses_shell");
		expect(fact?.memberId).toBe(s.f.acceptor.memberId);
		expect(fact?.transport).toBe("p2p");
		expect(fact?.bytesReceived).toBe(BigInt(counts.bytesSent));
		expect(fact?.bytesSent).toBe(BigInt(counts.bytesReceived));
		expect(from).toEqual([s.f.acceptor.memberId]);
		expect(envelope?.context).toBe(SESSION_CLOSE_CONTEXT);
		const signKey = create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SIGN,
			keyId: s.f.acceptor.sign.keyId,
			algorithm: KeyAlgorithm.EDDSA,
			value: s.f.acceptor.signPublicKey,
		});
		if (envelope !== undefined)
			expect(verifyEnvelope(envelope, SESSION_CLOSE_CONTEXT, signKey)).toBe(
				true,
			);
		expect(s.logs).toContain("hobo_fleet_session_closed");
	});

	it("never runs a shell on the host: no sandbox for the order is an error", async () => {
		const s = await served({ sandboxFor: "ord_other" });
		const grant = await s.f.grant({
			purpose: SessionPurpose.SHELL,
			orderId: "ord_1",
		});
		const outcome = await s.dialler.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		await writeMessage(outcome.value, SESSION_TAG.END, new Uint8Array());
		const tags: number[] = [];
		for await (const message of readMessages(outcome.value))
			tags.push(message.tag);
		await outcome.value.close();
		expect(tags).toEqual([SESSION_TAG.ERROR]);
		expect(s.sandbox.runs).toEqual([]);
	});

	it("serves a blob named in the grant, and fetchBlob verifies its digest", async () => {
		const s = await served();
		const grant = await s.f.grant({
			purpose: SessionPurpose.BLOB,
			orderId: "ord_1",
			blobDigests: [BLOB_DIGEST],
		});
		const outcome = await s.dialler.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const parts: Uint8Array[] = [];
		for await (const part of fetchBlob(outcome.value, BLOB_DIGEST))
			parts.push(part);
		await outcome.value.close();
		expect(Buffer.concat(parts).equals(Buffer.from(BLOB))).toBe(true);
	});

	it("refuses a blob the grant does not name", async () => {
		const s = await served();
		const grant = await s.f.grant({
			purpose: SessionPurpose.BLOB,
			orderId: "ord_1",
			blobDigests: [`sha256:${"1".repeat(64)}`],
		});
		const outcome = await s.dialler.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const fetching = async () => {
			for await (const _ of fetchBlob(outcome.value, BLOB_DIGEST)) {
				// drain
			}
		};
		await expect(fetching()).rejects.toThrow(/not named/);
		expect(s.sandbox.runs).toEqual([]);
	});

	it("fetchBlob fails when the bytes do not match the digest", async () => {
		const corrupted = BLOB.slice();
		corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
		const [client, server] = memoryStreamPair();
		const serving = (async () => {
			for await (const message of readMessages(server)) {
				if (message.tag === SESSION_TAG.REQUEST) break;
			}
			await writeMessage(server, SESSION_TAG.OUTPUT, corrupted);
			await writeMessage(server, SESSION_TAG.END, new Uint8Array());
		})();
		const fetching = async () => {
			for await (const _ of fetchBlob(client, BLOB_DIGEST)) {
				// drain
			}
		};
		await expect(fetching()).rejects.toThrow(/digest/);
		await serving;
	});

	async function exchange(
		s: Served,
		grant: SignedEnvelope,
		send: readonly Readonly<{ tag: number; text: string }>[],
	): Promise<readonly Readonly<{ tag: number; text: string }>[]> {
		const outcome = await s.dialler.dial({
			grant,
			signal: new AbortController().signal,
		});
		if (!outcome.ok) throw new Error(outcome.error.message);
		for (const message of send)
			await writeMessage(
				outcome.value,
				message.tag === SESSION_TAG.INPUT
					? SESSION_TAG.INPUT
					: message.tag === SESSION_TAG.END
						? SESSION_TAG.END
						: SESSION_TAG.REQUEST,
				encoder.encode(message.text),
			);
		const received: { tag: number; text: string }[] = [];
		for await (const message of readMessages(outcome.value))
			received.push({
				tag: message.tag,
				text:
					message.tag === SESSION_TAG.EXIT
						? String(Buffer.from(message.payload).readInt32BE(0))
						: decoder.decode(message.payload),
			});
		await outcome.value.close();
		return received;
	}

	it("forwards to a port inside the order's sandbox", async () => {
		const s = await served();
		const grant = await s.f.grant({
			purpose: SessionPurpose.FORWARD,
			orderId: "ord_1",
			port: 8080,
		});
		const received = await exchange(s, grant, [
			{ tag: SESSION_TAG.INPUT, text: "GET /" },
			{ tag: SESSION_TAG.END, text: "" },
		]);
		expect(s.sandbox.runs).toEqual([["nc", "127.0.0.1", "8080"]]);
		expect(received).toEqual([
			{ tag: SESSION_TAG.OUTPUT, text: "ran: GET /" },
			{ tag: SESSION_TAG.EXIT, text: "7" },
		]);
	});

	it("answers ERROR when the command cannot run or the session speaks out of turn", async () => {
		const s = await served();
		const shell = () =>
			s.f.grant({ purpose: SessionPurpose.SHELL, orderId: "ord_1" });
		const failed = await exchange(s, await shell(), [
			{ tag: SESSION_TAG.INPUT, text: "boom" },
			{ tag: SESSION_TAG.END, text: "" },
		]);
		expect(failed.map((message) => message.tag)).toEqual([SESSION_TAG.ERROR]);
		const outOfTurn = await exchange(s, await shell(), [
			{ tag: SESSION_TAG.REQUEST, text: BLOB_DIGEST },
		]);
		expect(outOfTurn.map((message) => message.tag)).toEqual([
			SESSION_TAG.ERROR,
		]);
		const blobOutOfTurn = await exchange(
			s,
			await s.f.grant({
				purpose: SessionPurpose.BLOB,
				orderId: "ord_1",
				blobDigests: [BLOB_DIGEST],
			}),
			[{ tag: SESSION_TAG.INPUT, text: "x" }],
		);
		expect(blobOutOfTurn.map((message) => message.tag)).toEqual([
			SESSION_TAG.ERROR,
		]);
	});

	it("refuses a blob it does not hold, and a blob session with no order", async () => {
		const s = await served();
		const other = `sha256:${"2".repeat(64)}`;
		const notHeld = await exchange(
			s,
			await s.f.grant({
				purpose: SessionPurpose.BLOB,
				orderId: "ord_1",
				blobDigests: [other],
			}),
			[{ tag: SESSION_TAG.REQUEST, text: other }],
		);
		expect(notHeld).toEqual([
			{ tag: SESSION_TAG.ERROR, text: `blob ${other} is not held here` },
		]);
		const noOrder = await exchange(
			s,
			await s.f.grant({
				purpose: SessionPurpose.BLOB,
				blobDigests: [BLOB_DIGEST],
			}),
			[{ tag: SESSION_TAG.REQUEST, text: BLOB_DIGEST }],
		);
		expect(noOrder.map((message) => message.tag)).toEqual([SESSION_TAG.ERROR]);
	});

	it("does not finish a blob whose held bytes do not match its digest", async () => {
		const s = await served({ blob: encoder.encode("not the blob") });
		const received = await exchange(
			s,
			await s.f.grant({
				purpose: SessionPurpose.BLOB,
				orderId: "ord_1",
				blobDigests: [BLOB_DIGEST],
			}),
			[{ tag: SESSION_TAG.REQUEST, text: BLOB_DIGEST }],
		);
		expect(received.at(-1)).toEqual({
			tag: SESSION_TAG.ERROR,
			text: `the held bytes do not match ${BLOB_DIGEST}`,
		});
	});

	it("stop ends acceptance on every transport", async () => {
		const s = await served();
		await s.subscription.stop();
		const grant = await s.f.grant();
		const outcome = await s.dialler.dial({
			grant,
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(false);
	});
});
