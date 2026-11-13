/**
 * The p2p `FleetTransport` over an `EndpointBinding` (design §6.12 item 1, L11).
 *
 * `start` binds one endpoint with the secret derived from the device's SIGN
 * key, the ALPN `hobo/fleet/1` and only the configured relays, and answers the
 * endpoint id as the transport identity. `dial` reaches the acceptor the grant
 * names by its endpoint id and presents the grant as the first frame; `accept`
 * hands each incoming connection's proven endpoint id and presented grant to
 * `authorise` before a payload byte is delivered either way (session.ts).
 *
 * When the platform has no prebuilt binding, the transport reports itself
 * unavailable: `start` answers an empty transport identity (the device then
 * publishes no `TRANSPORT` key), `dial` fails `unavailable`, and `accept`
 * takes nothing. Selection then moves on to `overlay` and `bus-relay` (A8).
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type DeviceKeys,
	type FleetErrorCode,
	type FleetStream,
	type FleetTransport,
	type Outcome,
	type SessionGrant,
	SessionGrantSchema,
	type SignedEnvelope,
	type Subscription,
} from "@hobo/fleet";
import type {
	BoundEndpoint,
	EndpointBinding,
	EndpointConnection,
} from "./endpoint.js";
import { deriveEndpointSecret } from "./secret.js";
import {
	ACCEPTED,
	createReceiver,
	encodeGrantFrame,
	openSession,
	readGrantFrame,
} from "./session.js";

/** The one ALPN the p2p transport serves and dials. */
export const P2P_ALPN: Uint8Array = new TextEncoder().encode("hobo/fleet/1");

const HANDSHAKE_MS = 15_000;
const ONLINE_MS = 10_000;

type Acceptor = Readonly<{
	authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>;
	handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>;
}>;

function fail<T>(code: FleetErrorCode, message: string): Outcome<T> {
	return { ok: false, error: { code, message } };
}

/** A timer that `clear` cancels. */
type Deadline = Readonly<{ reached: Promise<"late">; clear(): void }>;

/** Resolves `"late"` after `ms`, or when `signal` aborts; never rejects. */
function deadline(ms: number, signal: AbortSignal | undefined): Deadline {
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

export function createEndpointTransport(
	deps: Readonly<{
		relayUrls: readonly string[];
		/** Answers the binding, or undefined when this platform has none. */
		binding: () => EndpointBinding | undefined;
		handshakeTimeoutMs?: number;
	}>,
): FleetTransport {
	const handshakeMs = deps.handshakeTimeoutMs ?? HANDSHAKE_MS;
	let starting: Promise<Readonly<{ transportIdentity: string }>> | undefined;
	let endpoint: BoundEndpoint | undefined;
	let acceptor: Acceptor | undefined;
	const connections = new Set<EndpointConnection>();

	const track = (connection: EndpointConnection) => {
		connections.add(connection);
		void connection.closed().then(() => connections.delete(connection));
	};

	const serve = async (self: BoundEndpoint, connection: EndpointConnection) => {
		const current = acceptor;
		if (current === undefined) {
			connection.close();
			return;
		}
		const limit = deadline(handshakeMs, undefined);
		const handshake = (async () => {
			const stream = await connection.acceptStream();
			const receiver = createReceiver(stream);
			const grant = await readGrantFrame(receiver);
			return grant === undefined ? undefined : { stream, receiver, grant };
		})().catch(() => undefined);
		const opened = await Promise.race([handshake, limit.reached]);
		limit.clear();
		if (opened === undefined || opened === "late") {
			connection.close();
			return;
		}
		const peer = connection.remoteId;
		let allowed = false;
		try {
			allowed = await current.authorise(peer, opened.grant);
		} catch {
			allowed = false;
		}
		let grant: SessionGrant | undefined;
		if (allowed) {
			try {
				grant = fromBinary(SessionGrantSchema, opened.grant.payload);
			} catch {
				grant = undefined;
			}
		}
		if (
			grant === undefined ||
			grant.acceptor?.transportIdentity !== self.id ||
			acceptor !== current
		) {
			connection.close();
			return;
		}
		try {
			await opened.stream.write(new Uint8Array([ACCEPTED]));
		} catch {
			connection.close();
			return;
		}
		const session = openSession({
			peer,
			connection,
			stream: opened.stream,
			receiver: opened.receiver,
		});
		try {
			await current.handler(session, grant);
		} catch {
			// The handler's failure ends its session; the transport keeps accepting.
		} finally {
			await session.close();
		}
	};

	const acceptLoop = async (self: BoundEndpoint) => {
		for (;;) {
			const connection = await self.accept().catch(() => undefined);
			if (connection === undefined) return;
			track(connection);
			void serve(self, connection);
		}
	};

	const bindEndpoint = async (
		keys: DeviceKeys,
	): Promise<Readonly<{ transportIdentity: string }>> => {
		const binding = deps.binding();
		if (binding === undefined) return { transportIdentity: "" };
		const bound = await binding.bind({
			secretKey: await deriveEndpointSecret(keys),
			relayUrls: deps.relayUrls,
			alpn: P2P_ALPN,
		});
		const online = deadline(ONLINE_MS, undefined);
		await Promise.race([bound.online().catch(() => undefined), online.reached]);
		online.clear();
		endpoint = bound;
		void acceptLoop(bound);
		return { transportIdentity: bound.id };
	};

	const dialOver = async (
		self: BoundEndpoint,
		peer: string,
		frame: Uint8Array,
		signal: AbortSignal,
	): Promise<Outcome<FleetStream>> => {
		let connection: EndpointConnection | undefined;
		let abandoned = false;
		const attempt = (async (): Promise<Outcome<FleetStream>> => {
			try {
				connection = await self.connect(peer);
			} catch (error) {
				return fail(
					"unavailable",
					`p2p: cannot reach ${peer}: ${error instanceof Error ? error.message : "connect failed"}`,
				);
			}
			track(connection);
			if (abandoned) {
				connection.close();
				return fail("unavailable", "p2p: the dial was abandoned");
			}
			// The peer was reached: from here, anything but its ACCEPTED byte is a refusal.
			const opened = await (async () => {
				const stream = await connection.openStream();
				await stream.write(frame);
				const receiver = createReceiver(stream);
				const verdict = await receiver.exact(1);
				return verdict?.[0] === ACCEPTED ? { stream, receiver } : undefined;
			})().catch(() => undefined);
			if (opened === undefined) {
				connection.close();
				return fail("session-denied", "p2p: the acceptor refused the session");
			}
			return {
				ok: true,
				value: openSession({ peer, connection, ...opened }),
			};
		})().catch((error: Error) => {
			connection?.close();
			return fail<FleetStream>("unavailable", `p2p: ${error.message}`);
		});
		const limit = deadline(handshakeMs, signal);
		const outcome = await Promise.race([attempt, limit.reached]);
		limit.clear();
		if (outcome !== "late") return outcome;
		abandoned = true;
		connection?.close();
		void attempt.then(async (late) => {
			if (late.ok) await late.value.close();
		});
		return fail(
			"unavailable",
			signal.aborted
				? "p2p: the dial was aborted"
				: "p2p: the handshake timed out",
		);
	};

	return {
		kind: "p2p",
		start(keys) {
			starting ??= bindEndpoint(keys).catch((error: Error) => {
				starting = undefined;
				throw error;
			});
			return starting;
		},
		async dial({ grant, signal }) {
			if (signal.aborted)
				return fail("unavailable", "p2p: the dial was aborted");
			const self = endpoint;
			if (self === undefined)
				return fail(
					"unavailable",
					"p2p: the transport is not started or has no binding",
				);
			let peer: string;
			try {
				peer =
					fromBinary(SessionGrantSchema, grant.payload).acceptor
						?.transportIdentity ?? "";
			} catch {
				return fail("invalid-request", "p2p: the grant does not decode");
			}
			const frame = encodeGrantFrame(grant);
			if (peer === "" || frame === undefined)
				return fail(
					"invalid-request",
					"p2p: the grant names no acceptor or is too large",
				);
			return dialOver(self, peer, frame, signal);
		},
		accept(authorise, handler) {
			const mine: Acceptor = { authorise, handler };
			acceptor = mine;
			return {
				async stop() {
					if (acceptor === mine) acceptor = undefined;
				},
			} satisfies Subscription;
		},
		async stop() {
			const self = endpoint;
			endpoint = undefined;
			starting = undefined;
			for (const connection of connections) connection.close();
			connections.clear();
			await self?.close();
		},
	};
}
