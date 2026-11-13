/**
 * `runTransportConformance` (design §7.3, §6.12, O12): what every
 * `FleetTransport` must do. `make` answers two transports that can reach one
 * another; the suite starts each with its own device keys, accepts on the
 * second and dials from the first.
 *
 * The grant check itself is the accepting device's (`authoriseSession`); the
 * suite passes its own `authorise`, which verifies the grant's signature
 * against a suite authority key, its expiry, and that the peer the transport
 * proved is the initiator the grant names. What the suite checks is that the
 * transport gives `authorise` the proven peer and the presented grant, asks it
 * for every dial, and delivers nothing to the acceptor unless it answers true.
 *
 * - A granted dial carries 64 MiB with a matching SHA-256 digest, and an
 *   answer back.
 * - An ungranted dial is refused before any byte is delivered; an expired
 *   grant is refused even after the same peer was granted before; a grant
 *   naming another initiator is refused.
 * - `close` reports the bytes each side sent and received; an aborted dial
 *   fails; after `stop` the acceptor takes no dial.
 */
import { createHash, randomBytes } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type SessionGrant,
	SessionGrantSchema,
	SessionPurpose,
	type SignedEnvelope,
} from "../../_generated/fleet_pb.js";
import { SESSION_GRANT_CONTEXT } from "../../contexts.js";
import type {
	DeviceKeys,
	FleetStream,
	FleetTransport,
	Outcome,
	Subscription,
} from "../../ports.js";
import {
	type ConformanceAssertion,
	ensure,
	eventually,
	pause,
	sameBytes,
} from "./assertion.js";
import {
	createSuiteDeviceKeys,
	createSuiteKey,
	type SuiteKey,
	signEnvelope,
	signedBytes,
} from "./crypto.js";

export type TransportMake = () => Promise<
	readonly [FleetTransport, FleetTransport]
>;

const MIB = 1024 * 1024;
const BULK_BYTES = 64 * MIB;
const WAIT_MS = 10_000;
/** How long a refusal check waits for a handler that must not be called. */
const QUIET_MS = 200;
const MINUTE = 60_000;
const GREETING = new Uint8Array([0x2a]);

type Party = Readonly<{
	transport: FleetTransport;
	keys: DeviceKeys;
	identity: string;
}>;

type Authorisation = Readonly<{ peer: string; grant: SignedEnvelope }>;

/** Two started transports, the suite authority, and what the acceptor has seen. */
type Pair = Readonly<{
	initiator: Party;
	acceptor: Party;
	authority: SuiteKey;
	authorisations: Authorisation[];
	accepted: { stream: FleetStream; grant: SessionGrant }[];
	acceptance: { subscription: Subscription | undefined };
	/** What the acceptor's handler does with each accepted stream. */
	serve: { handler: (stream: FleetStream) => Promise<void> };
}>;

async function startPair(make: TransportMake): Promise<Pair> {
	const [first, second] = await make();
	const start = async (transport: FleetTransport): Promise<Party> => {
		const keys = createSuiteDeviceKeys();
		const { transportIdentity } = await transport.start(keys);
		return { transport, keys, identity: transportIdentity };
	};
	const initiator = await start(first);
	const acceptor = await start(second);
	const pair: Pair = {
		initiator,
		acceptor,
		authority: createSuiteKey("authority#1"),
		authorisations: [],
		accepted: [],
		acceptance: { subscription: undefined },
		// By default the acceptor greets each accepted stream with one byte, so a
		// dial that should have been refused shows up on the dialler's side.
		serve: {
			handler: async (stream) => {
				await stream.write(GREETING);
			},
		},
	};
	pair.acceptance.subscription = acceptor.transport.accept(
		async (peer, grant) => {
			pair.authorisations.push({ peer, grant });
			return authorise(pair, peer, grant);
		},
		async (stream, grant) => {
			pair.accepted.push({ stream, grant });
			await pair.serve.handler(stream);
		},
	);
	return pair;
}

/** The suite's stand-in for `authoriseSession`: signature, expiry, both parties. */
function authorise(
	pair: Pair,
	peer: string,
	envelope: SignedEnvelope,
): boolean {
	if (envelope.context !== SESSION_GRANT_CONTEXT) return false;
	if (
		!pair.authority.verify(
			signedBytes(envelope.context, envelope.payload),
			envelope.signature,
		)
	)
		return false;
	let grant: SessionGrant;
	try {
		grant = fromBinary(SessionGrantSchema, envelope.payload);
	} catch {
		return false;
	}
	const expires = Date.parse(grant.expiresAt);
	return (
		!Number.isNaN(expires) &&
		expires > Date.now() &&
		grant.initiator?.transportIdentity === peer &&
		grant.acceptor?.transportIdentity === pair.acceptor.identity
	);
}

async function stopPair(pair: Pair): Promise<void> {
	await pair.acceptance.subscription?.stop();
	await pair.initiator.transport.stop();
	await pair.acceptor.transport.stop();
}

type GrantOptions = Readonly<{
	signer?: SuiteKey;
	expiresInMs?: number;
	initiatorIdentity?: string;
}>;

async function grantFor(
	pair: Pair,
	options: GrantOptions = {},
): Promise<Readonly<{ envelope: SignedEnvelope; sessionId: string }>> {
	const now = Date.now();
	const sessionId = `ses_${randomBytes(12).toString("hex")}`;
	const grant = create(SessionGrantSchema, {
		sessionId,
		tenant: "conformance",
		initiator: {
			memberId: pair.initiator.keys.memberId,
			transportIdentity: options.initiatorIdentity ?? pair.initiator.identity,
			sealPublicKey: pair.initiator.keys.sealPublicKey,
		},
		acceptor: {
			memberId: pair.acceptor.keys.memberId,
			transportIdentity: pair.acceptor.identity,
			sealPublicKey: pair.acceptor.keys.sealPublicKey,
		},
		purpose: SessionPurpose.BLOB,
		issuedAt: new Date(now - MINUTE).toISOString(),
		expiresAt: new Date(
			now + (options.expiresInMs ?? 10 * MINUTE),
		).toISOString(),
	});
	const envelope = await signEnvelope(
		(options.signer ?? pair.authority).signer,
		SESSION_GRANT_CONTEXT,
		toBinary(SessionGrantSchema, grant),
	);
	return { envelope, sessionId };
}

async function dial(
	pair: Pair,
	grant: SignedEnvelope,
	signal: AbortSignal = new AbortController().signal,
): Promise<Outcome<FleetStream>> {
	try {
		return await pair.initiator.transport.dial({ grant, signal });
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: error instanceof Error ? error.message : "dial threw",
			},
		};
	}
}

/** Reads a stream through one iterator, a byte count at a time. */
function reader(stream: FleetStream) {
	const iterator = stream.read()[Symbol.asyncIterator]();
	let leftover: Uint8Array = new Uint8Array(0);
	return {
		/** Feeds up to `count` bytes to `take`; answers how many arrived before the stream ended. */
		async pull(
			count: number,
			take: (chunk: Uint8Array) => void,
		): Promise<number> {
			let got = 0;
			while (got < count) {
				let chunk: Uint8Array = leftover;
				leftover = new Uint8Array(0);
				if (chunk.length === 0) {
					const next = await iterator.next();
					if (next.done === true) return got;
					chunk = next.value;
				}
				const used = chunk.subarray(0, count - got);
				leftover = chunk.subarray(used.length);
				take(used);
				got += used.length;
			}
			return got;
		},
	};
}

async function readAll(
	stream: FleetStream,
	count: number,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	await reader(stream).pull(count, (chunk) => parts.push(chunk.slice()));
	return new Uint8Array(Buffer.concat(parts));
}

/** A refused dial: the dial fails, or its stream ends without a byte. */
async function refused(outcome: Outcome<FleetStream>): Promise<boolean> {
	if (!outcome.ok) return true;
	const got = await Promise.race([
		reader(outcome.value)
			.pull(1, () => {})
			.catch(() => 0),
		pause(QUIET_MS * 10).then(() => 0),
	]);
	await outcome.value.close().catch(() => undefined);
	return got === 0;
}

async function withPair(
	make: TransportMake,
	use: (pair: Pair) => Promise<void>,
): Promise<void> {
	const pair = await startPair(make);
	try {
		await use(pair);
	} finally {
		await stopPair(pair);
	}
}

/** The transport assertions, in the order they are registered. */
export const TRANSPORT_ASSERTIONS: readonly ConformanceAssertion<TransportMake>[] =
	[
		{
			name: "a granted dial carries 64 MiB with a matching digest, and an answer back",
			async check(make) {
				await withPair(make, async (pair) => {
					const chunk = randomBytes(MIB);
					const answer = randomBytes(64 * 1024);
					const sent = createHash("sha256");
					for (let index = 0; index < BULK_BYTES / MIB; index += 1)
						sent.update(chunk);
					const received = createHash("sha256");
					let receivedBytes = 0;
					pair.serve.handler = async (stream) => {
						receivedBytes = await reader(stream).pull(BULK_BYTES, (part) => {
							received.update(part);
						});
						await stream.write(answer);
					};
					const { envelope } = await grantFor(pair);
					const outcome = await dial(pair, envelope);
					ensure(
						outcome.ok,
						`a granted dial failed: ${outcome.ok ? "" : outcome.error.message}`,
					);
					const stream = outcome.value;
					for (let index = 0; index < BULK_BYTES / MIB; index += 1)
						await stream.write(chunk);
					const back = await readAll(stream, answer.length);
					await stream.close();
					ensure(
						receivedBytes === BULK_BYTES,
						`the acceptor received ${receivedBytes} of ${BULK_BYTES} bytes`,
					);
					ensure(
						received.digest("hex") === sent.digest("hex"),
						"the acceptor's digest does not match what was sent",
					);
					ensure(sameBytes(back, answer), "the answer back did not match");
				});
			},
		},
		{
			name: "authorise sees the dialler's proven identity and the presented grant",
			async check(make) {
				await withPair(make, async (pair) => {
					ensure(
						pair.initiator.identity.length > 0 &&
							pair.initiator.identity !== pair.acceptor.identity,
						"the two transports did not answer two distinct identities",
					);
					const { envelope, sessionId } = await grantFor(pair);
					const outcome = await dial(pair, envelope);
					ensure(outcome.ok, "a granted dial failed");
					await outcome.value.write(new Uint8Array([1]));
					await eventually(
						() => pair.accepted.length === 1,
						WAIT_MS,
						"the acceptor's handler was not called",
					);
					await outcome.value.close();
					const seen = pair.authorisations[0];
					ensure(
						pair.authorisations.length === 1 && seen !== undefined,
						`authorise was asked ${pair.authorisations.length} times for one dial`,
					);
					ensure(
						seen.peer === pair.initiator.identity,
						`authorise saw peer ${seen.peer}, not the dialler ${pair.initiator.identity}`,
					);
					ensure(
						sameBytes(seen.grant.payload, envelope.payload) &&
							sameBytes(seen.grant.signature, envelope.signature),
						"authorise did not see the grant the dialler presented",
					);
					const handed = pair.accepted[0]?.grant;
					ensure(
						handed?.sessionId === sessionId &&
							handed.purpose === SessionPurpose.BLOB,
						"the handler did not receive the decoded grant",
					);
				});
			},
		},
		{
			name: "an ungranted dial is refused before any byte is delivered",
			async check(make) {
				await withPair(make, async (pair) => {
					const { envelope } = await grantFor(pair, {
						signer: createSuiteKey("authority#9"),
					});
					const outcome = await dial(pair, envelope);
					if (outcome.ok)
						await outcome.value
							.write(new Uint8Array([1]))
							.catch(() => undefined);
					ensure(await refused(outcome), "an ungranted dial was carried");
					await pause(QUIET_MS);
					ensure(
						pair.accepted.length === 0,
						"the acceptor's handler was handed an ungranted stream",
					);
				});
			},
		},
		{
			name: "an expired grant is refused, even from a peer granted before",
			async check(make) {
				await withPair(make, async (pair) => {
					const granted = await dial(pair, (await grantFor(pair)).envelope);
					ensure(granted.ok, "a granted dial failed");
					await granted.value.write(new Uint8Array([1]));
					await eventually(
						() => pair.accepted.length === 1,
						WAIT_MS,
						"the acceptor's handler was not called",
					);
					await granted.value.close();
					const { envelope } = await grantFor(pair, { expiresInMs: -MINUTE });
					const outcome = await dial(pair, envelope);
					ensure(
						await refused(outcome),
						"a dial with an expired grant was carried",
					);
					ensure(
						pair.authorisations.length === 2,
						`authorise was asked ${pair.authorisations.length} times for two dials`,
					);
				});
			},
		},
		{
			name: "a grant naming another initiator is refused",
			async check(make) {
				await withPair(make, async (pair) => {
					const { envelope } = await grantFor(pair, {
						initiatorIdentity: pair.acceptor.identity,
					});
					const outcome = await dial(pair, envelope);
					ensure(
						await refused(outcome),
						"a dial whose grant names another initiator was carried",
					);
				});
			},
		},
		{
			name: "close reports the bytes each side sent and received",
			async check(make) {
				await withPair(make, async (pair) => {
					let acceptorCounts:
						| Readonly<{ bytesSent: number; bytesReceived: number }>
						| undefined;
					pair.serve.handler = async (stream) => {
						await readAll(stream, 1000);
						await stream.write(randomBytes(500));
						await readAll(stream, 1);
						acceptorCounts = await stream.close();
					};
					const outcome = await dial(pair, (await grantFor(pair)).envelope);
					ensure(outcome.ok, "a granted dial failed");
					const stream = outcome.value;
					await stream.write(randomBytes(1000));
					await readAll(stream, 500);
					await stream.write(randomBytes(1));
					await eventually(
						() => acceptorCounts !== undefined,
						WAIT_MS,
						"the acceptor did not close",
					);
					const dialler = await stream.close();
					ensure(
						dialler.bytesSent === 1001 && dialler.bytesReceived === 500,
						`the dialler reported sent ${dialler.bytesSent}, received ${dialler.bytesReceived}; want 1001, 500`,
					);
					ensure(
						acceptorCounts?.bytesSent === 500 &&
							acceptorCounts.bytesReceived === 1001,
						`the acceptor reported sent ${acceptorCounts?.bytesSent}, received ${acceptorCounts?.bytesReceived}; want 500, 1001`,
					);
				});
			},
		},
		{
			name: "a dial with an aborted signal fails",
			async check(make) {
				await withPair(make, async (pair) => {
					const controller = new AbortController();
					controller.abort();
					const outcome = await dial(
						pair,
						(await grantFor(pair)).envelope,
						controller.signal,
					);
					if (outcome.ok) await outcome.value.close();
					ensure(!outcome.ok, "a dial with an aborted signal succeeded");
				});
			},
		},
		{
			name: "after stop the acceptor takes no dial",
			async check(make) {
				await withPair(make, async (pair) => {
					await pair.acceptance.subscription?.stop();
					await pair.acceptor.transport.stop();
					const outcome = await dial(pair, (await grantFor(pair)).envelope);
					if (outcome.ok)
						await outcome.value
							.write(new Uint8Array([1]))
							.catch(() => undefined);
					ensure(await refused(outcome), "a stopped acceptor took a dial");
					ensure(
						pair.accepted.length === 0,
						"a stopped acceptor handed a stream to its handler",
					);
				});
			},
		},
	];
