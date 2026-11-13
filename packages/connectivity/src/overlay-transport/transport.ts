/**
 * The `overlay` `FleetTransport` (design §6.12 item 2, L14): a TCP stream
 * between two devices' overlay addresses (Tailscale, NetBird, WireGuard),
 * where a tenant already runs one. The host has joined the overlay with the
 * `OverlayJoin` the authority minted at enrollment before this starts.
 *
 * The overlay authenticates source addresses but not fleet devices, so the
 * session is also end-to-end: keys from `sessionKeys` over the X25519
 * agreement of the two `SEAL` keys the grant names, salted with a nonce from
 * each side and the grant's session id, framed by `frameStream` (L28).
 *
 * The handshake:
 * 1. The acceptor sends `HELLO`: the magic and its 16-byte nonce.
 * 2. The dialler sends `OPEN`: the magic, its nonce and the grant, then,
 *    through the framing, a proof only the holder of the initiator's SEAL key
 *    can make authenticate.
 * 3. The acceptor checks the grant names it, checks the proof, and asks
 *    `authorise` with the proven peer and the presented grant. The proven
 *    peer is the grant's initiator identity when its SEAL key is the one
 *    proven and its host is the connection's source address; otherwise it is
 *    the identity the connection actually proves, which no grant names.
 *    Nothing reaches the handler before `authorise` answers true.
 * 4. The acceptor answers an accept message through the framing, which
 *    proves its own SEAL key to the dialler, or closes the connection.
 */
import { randomBytes } from "node:crypto";
import {
	connect,
	createServer,
	isIPv4,
	type Server,
	type Socket,
	type TcpNetConnectOpts,
} from "node:net";
import type { OverlayNetwork } from "@hobo/core";
import type {
	DeviceKeys,
	FleetErrorCode,
	FleetStream,
	FleetTransport,
	Outcome,
	SessionGrant,
	SignedEnvelope,
} from "@hobo/fleet";
import { sessionKeys } from "@hobo/fleet/keys";
import { frameStream } from "@hobo/fleet/transport";
import {
	formatOverlayIdentity,
	normaliseHost,
	type OverlayAddress,
	overlayHost,
	parseOverlayIdentity,
} from "./identity.js";
import { type SocketReader, socketReader } from "./socket.js";
import {
	decodeSessionGrant,
	decodeSignedEnvelope,
	encodeSignedEnvelope,
} from "./wire.js";

export type OverlayTransportOptions = Readonly<{
	/** How long a dial waits for the acceptor's answer, and an acceptor for the dialler's proof. */
	handshakeTimeoutMs?: number;
	/** The most connections in their handshake or session at once; further ones are closed. */
	maxConnections?: number;
}>;

const HANDSHAKE_MS = 15_000;
const MAX_CONNECTIONS = 256;
const MAGIC = new TextEncoder().encode("HOBOOVL1");
const NONCE_BYTES = 16;
const LENGTH_BYTES = 4;
/** A session grant envelope is small; anything larger is refused unread. */
const MAX_GRANT_BYTES = 64 * 1024;
const PROOF = new TextEncoder().encode("hobo-fleet/overlay/v1 open");
const ACCEPTED = new Uint8Array([1]);

type Acceptor = Readonly<{
	authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>;
	handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>;
}>;

type Started = Readonly<{
	keys: DeviceKeys;
	address: OverlayAddress;
	identity: string;
	server: Server;
}>;

function fail<T>(code: FleetErrorCode, message: string): Outcome<T> {
	return { ok: false, error: { code, message: `overlay: ${message}` } };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

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
		return decodeSessionGrant(envelope.payload);
	} catch {
		return undefined;
	}
}

function lengthPrefix(length: number): Uint8Array {
	const prefix = Buffer.alloc(LENGTH_BYTES);
	prefix.writeUInt32BE(length, 0);
	return prefix;
}

/** The salt both sides derive the session keys under: both nonces and the grant's session id. */
function salt(
	acceptorNonce: Uint8Array,
	diallerNonce: Uint8Array,
	sessionId: string,
): string {
	return `${hex(acceptorNonce)}${hex(diallerNonce)}:${sessionId}`;
}

/**
 * The framed stream after the handshake: its first message each way has been
 * taken already, and is left out of the byte counts.
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

/** Opens a TCP connection, or fails when it cannot, the signal aborts or time runs out. */
function open(
	to: OverlayAddress,
	from: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const options: TcpNetConnectOpts = {
			host: to.host,
			port: to.port,
			allowHalfOpen: true,
			noDelay: true,
		};
		// Leave from this device's own overlay address, so the acceptor sees the source the grant names.
		if (isIPv4(from) === isIPv4(to.host)) options.localAddress = from;
		const socket = connect(options);
		const limit = deadline(timeoutMs, signal);
		const settle = (error: Error | undefined) => {
			limit.clear();
			socket.off("connect", connected);
			socket.off("error", failed);
			if (error === undefined) {
				resolve(socket);
				return;
			}
			socket.destroy();
			reject(error);
		};
		const connected = () => settle(undefined);
		const failed = (error: Error) => settle(error);
		socket.once("connect", connected);
		socket.once("error", failed);
		void limit.reached.then(() =>
			settle(
				new Error(
					signal.aborted
						? "the dial was aborted"
						: "the acceptor did not answer in time",
				),
			),
		);
	});
}

export function createOverlayTransportWith(
	overlay: OverlayNetwork,
	options: OverlayTransportOptions = {},
): FleetTransport {
	const handshakeMs = options.handshakeTimeoutMs ?? HANDSHAKE_MS;
	const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
	let started: Started | undefined;
	let acceptor: Acceptor | undefined;
	const sockets = new Set<Socket>();

	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.once("close", () => sockets.delete(socket));
	};

	/** What the connection proves about the dialler: see step 3 above. */
	const provenPeer = (
		grant: SessionGrant,
		initiatorSeal: string,
		socket: Socket,
	): string => {
		const source = normaliseHost(socket.remoteAddress ?? "");
		const claimed = parseOverlayIdentity(
			grant.initiator?.transportIdentity ?? "",
		);
		if (
			claimed !== undefined &&
			claimed.sealPublicKey === initiatorSeal &&
			claimed.host === source
		)
			return grant.initiator?.transportIdentity ?? "";
		return formatOverlayIdentity({
			sealPublicKey: initiatorSeal,
			host: source,
			port: socket.remotePort ?? 0,
		});
	};

	/** The acceptor side of one connection, from `HELLO` to the handler's end. */
	const serve = async (socket: Socket, self: Started): Promise<void> => {
		const current = acceptor;
		if (current === undefined || sockets.size > maxConnections) {
			socket.destroy();
			return;
		}
		const reader = socketReader(socket);
		const raw = reader.stream("");
		const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
		const limit = deadline(handshakeMs, undefined);
		const proven = (async () => {
			await raw.write(new Uint8Array(Buffer.concat([MAGIC, nonce])));
			const opened = await readOpen(reader);
			if (opened === undefined) return undefined;
			const grant = decodeGrant(opened.envelope);
			const initiatorSeal = grant?.initiator?.sealPublicKey ?? "";
			if (
				grant === undefined ||
				initiatorSeal.length === 0 ||
				grant.acceptor?.sealPublicKey !== self.keys.sealPublicKey ||
				(grant.acceptor.memberId.length > 0 &&
					grant.acceptor.memberId !== self.keys.memberId)
			)
				return undefined;
			const shared = await self.keys.agree(initiatorSeal);
			const derived = sessionKeys(
				shared,
				salt(nonce, opened.nonce, grant.sessionId),
			);
			const framed = frameStream(raw, {
				send: derived.acceptorToInitiator,
				receive: derived.initiatorToAcceptor,
			});
			const messages = framed.read()[Symbol.asyncIterator]();
			const first = await messages.next();
			if (first.done === true || !sameBytes(first.value, PROOF))
				return undefined;
			return {
				framed,
				messages,
				grant,
				envelope: opened.envelope,
				peer: provenPeer(grant, initiatorSeal, socket),
			};
		})().catch(() => undefined);
		const opened = await Promise.race([proven, limit.reached]);
		limit.clear();
		if (opened === undefined || opened === "late") {
			socket.destroy();
			return;
		}
		let allowed = false;
		try {
			allowed = await current.authorise(opened.peer, opened.envelope);
		} catch {
			allowed = false;
		}
		if (!allowed || acceptor !== current || started !== self) {
			socket.destroy();
			return;
		}
		try {
			await opened.framed.write(ACCEPTED);
		} catch {
			socket.destroy();
			return;
		}
		const stream = sessionStream(opened.framed, opened.messages, opened.peer, {
			sent: ACCEPTED.length,
			received: PROOF.length,
		});
		try {
			await current.handler(stream, opened.grant);
		} catch {
			// The handler's failure ends its session; the transport keeps accepting.
		} finally {
			await stream.close().catch(() => undefined);
		}
	};

	const dialOver = async (
		self: Started,
		envelope: SignedEnvelope,
		grant: SessionGrant,
		to: OverlayAddress,
		signal: AbortSignal,
	): Promise<Outcome<FleetStream>> => {
		let socket: Socket | undefined;
		const limit = deadline(handshakeMs, signal);
		const attempt = (async (): Promise<Outcome<FleetStream>> => {
			const connected = await open(to, self.address.host, handshakeMs, signal);
			socket = connected;
			track(connected);
			const reader = socketReader(connected);
			const raw = reader.stream(formatOverlayIdentity(to));
			const hello = await reader.exact(MAGIC.length + NONCE_BYTES);
			if (
				hello === undefined ||
				!sameBytes(hello.subarray(0, MAGIC.length), MAGIC)
			)
				return fail("unavailable", "the acceptor is not an overlay transport");
			const acceptorNonce = hello.subarray(MAGIC.length);
			const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
			const grantBytes = encodeSignedEnvelope(envelope);
			await raw.write(
				new Uint8Array(
					Buffer.concat([
						MAGIC,
						nonce,
						lengthPrefix(grantBytes.length),
						grantBytes,
					]),
				),
			);
			const shared = await self.keys.agree(to.sealPublicKey);
			const derived = sessionKeys(
				shared,
				salt(acceptorNonce, nonce, grant.sessionId),
			);
			const framed = frameStream(raw, {
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
				connected.destroy();
				return fail("session-denied", "the acceptor refused the session");
			}
			return {
				ok: true,
				value: sessionStream(framed, messages, formatOverlayIdentity(to), {
					sent: PROOF.length,
					received: ACCEPTED.length,
				}),
			};
		})().catch((error: Error) => {
			socket?.destroy();
			return fail<FleetStream>("unavailable", error.message);
		});
		const outcome = await Promise.race([attempt, limit.reached]);
		limit.clear();
		if (outcome !== "late") return outcome;
		socket?.destroy();
		void attempt.then(async (late) => {
			if (late.ok) await late.value.close().catch(() => undefined);
		});
		return fail(
			"unavailable",
			signal.aborted
				? "the dial was aborted"
				: "the acceptor did not answer in time",
		);
	};

	return {
		kind: "overlay",
		async start(keys) {
			if (started !== undefined) await stopServer(started);
			const status = await overlay.status();
			if (status === null)
				throw new Error(
					"overlay: this device has not joined the overlay; join it with the OverlayJoin from enrollment first",
				);
			const host = overlayHost(status.overlayIps);
			if (host === undefined)
				throw new Error("overlay: this device has no overlay address");
			const server = createServer({ allowHalfOpen: true, noDelay: true });
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ host, port: 0 }, () => {
					server.off("error", reject);
					resolve();
				});
			});
			const bound = server.address();
			const port = bound instanceof Object ? bound.port : 0;
			const address = { sealPublicKey: keys.sealPublicKey, host, port };
			const self: Started = {
				keys,
				address,
				identity: formatOverlayIdentity(address),
				server,
			};
			server.on("connection", (socket) => {
				track(socket);
				void serve(socket, self).catch(() => socket.destroy());
			});
			started = self;
			return { transportIdentity: self.identity };
		},
		async dial({ grant: envelope, signal }) {
			if (signal.aborted) return fail("unavailable", "the dial was aborted");
			const self = started;
			if (self === undefined)
				return fail("unavailable", "the transport is not started");
			const grant = decodeGrant(envelope);
			if (grant === undefined)
				return fail("invalid-request", "the grant does not decode");
			const to = parseOverlayIdentity(grant.acceptor?.transportIdentity ?? "");
			if (to === undefined)
				return fail("unavailable", "the acceptor has no overlay address");
			if (to.sealPublicKey !== grant.acceptor?.sealPublicKey)
				return fail(
					"invalid-request",
					"the acceptor's overlay identity is not its SEAL key",
				);
			return dialOver(self, envelope, grant, to, signal);
		},
		accept(authorise, handler) {
			const mine: Acceptor = { authorise, handler };
			acceptor = mine;
			return {
				async stop() {
					if (acceptor === mine) acceptor = undefined;
				},
			};
		},
		async stop() {
			acceptor = undefined;
			const self = started;
			started = undefined;
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			if (self !== undefined) await stopServer(self);
		},
	};
}

function stopServer(self: Started): Promise<void> {
	return new Promise((resolve) => {
		if (!self.server.listening) {
			resolve();
			return;
		}
		self.server.close(() => resolve());
	});
}

/** The dialler's `OPEN`: the magic, its nonce and the grant envelope. */
async function readOpen(
	reader: SocketReader,
): Promise<
	Readonly<{ nonce: Uint8Array; envelope: SignedEnvelope }> | undefined
> {
	const head = await reader.exact(MAGIC.length + NONCE_BYTES + LENGTH_BYTES);
	if (head === undefined || !sameBytes(head.subarray(0, MAGIC.length), MAGIC))
		return undefined;
	const nonce = head.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
	const length = Buffer.from(head).readUInt32BE(MAGIC.length + NONCE_BYTES);
	if (length === 0 || length > MAX_GRANT_BYTES) return undefined;
	const body = await reader.exact(length);
	if (body === undefined) return undefined;
	return { nonce, envelope: decodeSignedEnvelope(body) };
}
