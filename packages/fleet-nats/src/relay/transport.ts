/**
 * The bus-relay `FleetTransport` (design §6.12 item 3, L37): sessions carried
 * as messages on `fleet.relay.<toMemberId>.<relaySessionId>` through the
 * agent's live bus, end-to-end encrypted so the bus sees only ciphertext.
 *
 * Every dial is its own relay session: a fresh random 128-bit id on the
 * subject, and keys from `sessionKeys` over the X25519 agreement of the two
 * `SEAL` keys the grant names, salted with that id and the grant's session
 * id, so no two dials ever share a key and nonce. The bytes are framed by
 * `frameStream` (L28).
 *
 * The handshake:
 * 1. The dialler sends `OPEN` (its member id and the grant) and, through the
 *    framing, a proof message. Only the holder of the initiator's SEAL key can
 *    produce a proof that authenticates, so the proven peer is
 *    `relayIdentity(grant.initiator.seal_public_key)`.
 * 2. The acceptor checks the grant names it (member id and SEAL key), checks
 *    the proof, then asks `authorise` with the proven peer and the presented
 *    grant. Nothing reaches the handler before `authorise` answers true.
 * 3. The acceptor answers an accept message through the framing, which proves
 *    its own SEAL key to the dialler, or `RESET`.
 */
import { randomBytes } from "node:crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type DeviceKeys,
	type FleetBus,
	type FleetErrorCode,
	type FleetStream,
	type FleetTransport,
	type MemberId,
	type Outcome,
	parseMemberId,
	type SessionGrant,
	SessionGrantSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type Subscription,
} from "@hobo/fleet";
import { sessionKeys } from "@hobo/fleet/keys";
import { frameStream } from "@hobo/fleet/transport";
import {
	type Channel,
	createChannel,
	DEFAULT_WINDOW_BYTES,
} from "./channel.js";
import {
	decodeRelayMessage,
	encodeRelayMessage,
	RELAY_MESSAGE,
	type RelayMessage,
	relayIdentity,
} from "./wire.js";

export type RelayTransportOptions = Readonly<{
	/** How long a dial waits for the acceptor's answer, and an acceptor for the proof. */
	handshakeTimeoutMs?: number;
	windowBytes?: number;
	creditTimeoutMs?: number;
	/** How often an acceptor looks for a new bus connection. */
	rebindIntervalMs?: number;
	/** The most relay sessions open at once; further OPENs are reset. */
	maxSessions?: number;
}>;

const HANDSHAKE_MS = 15_000;
const CREDIT_MS = 30_000;
const REBIND_MS = 1_000;
const MAX_SESSIONS = 256;
const PROOF = new TextEncoder().encode("hobo-fleet/bus-relay/v1 open");
const ACCEPTED = new Uint8Array([1]);
const RELAY_SESSION = /^[0-9a-f]{32}$/u;

type Acceptor = Readonly<{
	authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>;
	handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>;
}>;

/** A route: this device's relay subscription on one bus connection. */
type Route = Readonly<{
	bus: FleetBus;
	self: MemberId;
	subscription: Subscription;
}>;

function fail<T>(code: FleetErrorCode, message: string): Outcome<T> {
	return { ok: false, error: { code, message: `bus-relay: ${message}` } };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Resolves `"late"` after `ms` or when `signal` aborts; never rejects. */
function deadline(ms: number, signal: AbortSignal | undefined) {
	let clear = () => {};
	const reached = new Promise<"late">((resolve) => {
		const timer = setTimeout(() => resolve("late"), ms);
		const onAbort = () => resolve("late");
		signal?.addEventListener("abort", onAbort, { once: true });
		clear = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
	});
	return { reached, clear };
}

function decodeGrant(envelope: SignedEnvelope): SessionGrant | undefined {
	try {
		return fromBinary(SessionGrantSchema, envelope.payload);
	} catch {
		return undefined;
	}
}

/**
 * The framed stream over a channel after the handshake: its first message
 * each way has been taken already, and is left out of the byte counts.
 */
function sessionStream(
	framed: FleetStream,
	messages: AsyncIterator<Uint8Array>,
	peer: string,
	handshake: Readonly<{ sent: number; received: number }>,
): FleetStream {
	return {
		peer,
		async *read() {
			for (;;) {
				const next = await messages.next();
				if (next.done === true) return;
				yield next.value;
			}
		},
		write: (chunk) => framed.write(chunk),
		async close() {
			const counts = await framed.close();
			return Object.freeze({
				bytesSent: Math.max(0, counts.bytesSent - handshake.sent),
				bytesReceived: Math.max(0, counts.bytesReceived - handshake.received),
			});
		},
	};
}

export function createRelayTransport(
	bus: () => FleetBus | undefined,
	options: RelayTransportOptions = {},
): FleetTransport {
	const handshakeMs = options.handshakeTimeoutMs ?? HANDSHAKE_MS;
	const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
	const creditTimeoutMs = options.creditTimeoutMs ?? CREDIT_MS;
	const rebindMs = options.rebindIntervalMs ?? REBIND_MS;
	const maxSessions = options.maxSessions ?? MAX_SESSIONS;
	let keys: DeviceKeys | undefined;
	let route: Route | undefined;
	let acceptor: Acceptor | undefined;
	let rebind: ReturnType<typeof setInterval> | undefined;
	const channels = new Map<string, Channel>();

	const open = (id: string, to: MemberId, on: FleetBus): Channel => {
		const channel = createChannel({
			id,
			to,
			send: (message) => on.relay.send(to, id, encodeRelayMessage(message)),
			release: () => {
				if (channels.get(id) === channel) channels.delete(id);
			},
			windowBytes,
			creditTimeoutMs,
		});
		channels.set(id, channel);
		return channel;
	};

	const resetTo = (on: FleetBus, to: MemberId, id: string) =>
		on.relay
			.send(to, id, encodeRelayMessage({ type: RELAY_MESSAGE.RESET }))
			.catch(() => undefined);

	/** The acceptor side of one relay session, from `OPEN` to the handler's end. */
	const serve = async (
		on: FleetBus,
		self: DeviceKeys,
		id: string,
		message: Extract<RelayMessage, { type: typeof RELAY_MESSAGE.OPEN }>,
	): Promise<void> => {
		const current = acceptor;
		let from: MemberId;
		try {
			from = parseMemberId(message.from);
		} catch {
			return;
		}
		if (
			current === undefined ||
			channels.has(id) ||
			channels.size >= maxSessions
		) {
			if (!channels.has(id)) await resetTo(on, from, id);
			return;
		}
		// Registered before any await, so DATA that follows OPEN is kept.
		const channel = open(id, from, on);
		const refuse = (reason: string) => channel.reset(reason);
		let envelope: SignedEnvelope;
		try {
			envelope = fromBinary(SignedEnvelopeSchema, message.grant);
		} catch {
			refuse("the grant does not decode");
			return;
		}
		const grant = decodeGrant(envelope);
		const initiator = grant?.initiator;
		if (
			grant === undefined ||
			initiator === undefined ||
			initiator.sealPublicKey.length === 0 ||
			grant.acceptor?.memberId !== self.memberId ||
			grant.acceptor.sealPublicKey !== self.sealPublicKey ||
			(initiator.memberId.length > 0 && initiator.memberId !== from)
		) {
			refuse("the grant does not name this device and the dialler");
			return;
		}
		const limit = deadline(handshakeMs, undefined);
		const proven = (async () => {
			const shared = await self.agree(initiator.sealPublicKey);
			const derived = sessionKeys(shared, `${id}:${grant.sessionId}`);
			const framed = frameStream(channel.stream(""), {
				send: derived.acceptorToInitiator,
				receive: derived.initiatorToAcceptor,
			});
			const messages = framed.read()[Symbol.asyncIterator]();
			const first = await messages.next();
			return first.done !== true && sameBytes(first.value, PROOF)
				? { framed, messages }
				: undefined;
		})().catch(() => undefined);
		const opened = await Promise.race([proven, limit.reached]);
		limit.clear();
		if (opened === undefined || opened === "late") {
			refuse("the dialler did not prove the grant's SEAL key");
			return;
		}
		const peer = relayIdentity(initiator.sealPublicKey);
		let allowed = false;
		try {
			allowed = await current.authorise(peer, envelope);
		} catch {
			allowed = false;
		}
		if (!allowed || acceptor !== current || keys !== self) {
			refuse("the session is not authorised");
			return;
		}
		try {
			await opened.framed.write(ACCEPTED);
		} catch {
			refuse("the dialler went away");
			return;
		}
		const stream = sessionStream(
			opened.framed,
			opened.messages,
			relayIdentity(initiator.sealPublicKey),
			{ sent: ACCEPTED.length, received: PROOF.length },
		);
		try {
			await current.handler(stream, grant);
		} catch {
			// The handler's failure ends its session; the transport keeps accepting.
		} finally {
			await stream.close().catch(() => undefined);
		}
	};

	const onMessage =
		(on: FleetBus, self: DeviceKeys) =>
		async (id: string, frame: Uint8Array): Promise<void> => {
			if (!RELAY_SESSION.test(id)) return;
			const message = decodeRelayMessage(frame);
			if (message === undefined) return;
			if (message.type === RELAY_MESSAGE.OPEN) {
				void serve(on, self, id, message).catch(() => undefined);
				return;
			}
			channels.get(id)?.receive(message);
		};

	/** This device's relay subscription on the agent's current bus, made or remade as needed. */
	const ensureRoute = (): Route | undefined => {
		const self = keys;
		const live = bus();
		if (self === undefined || live === undefined) return undefined;
		if (route?.bus === live && route.self === self.memberId) return route;
		const old = route;
		route = undefined;
		void old?.subscription.stop().catch(() => undefined);
		route = {
			bus: live,
			self: self.memberId,
			subscription: live.relay.subscribe(self.memberId, onMessage(live, self)),
		};
		return route;
	};

	const dialOver = async (
		on: FleetBus,
		self: DeviceKeys,
		grantEnvelope: SignedEnvelope,
		grant: SessionGrant,
		to: MemberId,
		acceptorSeal: string,
		signal: AbortSignal,
	): Promise<Outcome<FleetStream>> => {
		const id = randomBytes(16).toString("hex");
		const channel = open(id, to, on);
		const limit = deadline(handshakeMs, signal);
		const attempt = (async (): Promise<Outcome<FleetStream>> => {
			await on.relay.send(
				to,
				id,
				encodeRelayMessage({
					type: RELAY_MESSAGE.OPEN,
					from: self.memberId,
					grant: toBinary(SignedEnvelopeSchema, grantEnvelope),
				}),
			);
			const shared = await self.agree(acceptorSeal);
			const derived = sessionKeys(shared, `${id}:${grant.sessionId}`);
			const framed = frameStream(channel.stream(""), {
				send: derived.initiatorToAcceptor,
				receive: derived.acceptorToInitiator,
			});
			// A refusal may arrive before the proof is out; the answer read below reports it.
			const proofSent = await framed.write(PROOF).then(
				() => true,
				() => false,
			);
			const messages = framed.read()[Symbol.asyncIterator]();
			const answer = await messages
				.next()
				.catch(() => ({ done: true, value: undefined }) as const);
			if (
				!proofSent ||
				answer.done === true ||
				!sameBytes(answer.value, ACCEPTED)
			) {
				channel.reset("refused", true);
				return fail("session-denied", "the acceptor refused the session");
			}
			return {
				ok: true,
				value: sessionStream(framed, messages, relayIdentity(acceptorSeal), {
					sent: PROOF.length,
					received: ACCEPTED.length,
				}),
			};
		})().catch((error: Error) => {
			channel.reset("the dial failed");
			return fail<FleetStream>("unavailable", error.message);
		});
		const outcome = await Promise.race([attempt, limit.reached]);
		limit.clear();
		if (outcome !== "late") return outcome;
		channel.reset("the dial was abandoned");
		void attempt.then(async (late) => {
			if (late.ok) await late.value.close();
		});
		return fail(
			"unavailable",
			signal.aborted
				? "the dial was aborted"
				: "the acceptor did not answer in time",
		);
	};

	return {
		kind: "bus-relay",
		async start(deviceKeys) {
			keys = deviceKeys;
			ensureRoute();
			return { transportIdentity: relayIdentity(deviceKeys.sealPublicKey) };
		},
		async dial({ grant: envelope, signal }) {
			if (signal.aborted) return fail("unavailable", "the dial was aborted");
			const self = keys;
			if (self === undefined)
				return fail("unavailable", "the transport is not started");
			const grant = decodeGrant(envelope);
			if (grant === undefined)
				return fail("invalid-request", "the grant does not decode");
			let to: MemberId;
			try {
				to = parseMemberId(grant.acceptor?.memberId ?? "");
			} catch {
				return fail("invalid-request", "the grant names no acceptor member");
			}
			const acceptorSeal = grant.acceptor?.sealPublicKey ?? "";
			if (acceptorSeal.length === 0)
				return fail("invalid-request", "the grant names no acceptor SEAL key");
			const current = ensureRoute();
			if (current === undefined)
				return fail("unavailable", "the agent has no bus connection");
			return dialOver(
				current.bus,
				self,
				envelope,
				grant,
				to,
				acceptorSeal,
				signal,
			);
		},
		accept(authorise, handler) {
			const mine: Acceptor = { authorise, handler };
			acceptor = mine;
			ensureRoute();
			if (rebind === undefined) {
				rebind = setInterval(() => {
					ensureRoute();
				}, rebindMs);
				rebind.unref();
			}
			return {
				async stop() {
					if (acceptor !== mine) return;
					acceptor = undefined;
					if (rebind !== undefined) clearInterval(rebind);
					rebind = undefined;
				},
			};
		},
		async stop() {
			acceptor = undefined;
			if (rebind !== undefined) clearInterval(rebind);
			rebind = undefined;
			keys = undefined;
			for (const channel of channels.values())
				channel.reset("the transport stopped");
			channels.clear();
			const old = route;
			route = undefined;
			await old?.subscription.stop().catch(() => undefined);
		},
	};
}
