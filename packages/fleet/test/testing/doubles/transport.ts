/**
 * An in-memory transport pair that keeps the transport contract (the suite's
 * reference), and pairs broken in exactly one way each, keyed by the transport
 * assertion that must catch the break.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	type SessionGrant,
	SessionGrantSchema,
	type SignedEnvelope,
} from "../../../src/_generated/fleet_pb.js";
import type {
	FleetStream,
	FleetTransport,
	Outcome,
} from "../../../src/ports.js";
import type { TransportMake } from "../../../src/testing/conformance/transport.js";

type Faults = Readonly<{
	corruptAfterBytes?: number;
	emptyHandlerGrant?: boolean;
	handOverBeforeAuthorise?: boolean;
	authoriseOncePerPeer?: boolean;
	peerFromGrant?: boolean;
	swappedCounts?: boolean;
	ignoreAbort?: boolean;
	stopKeepsAccepting?: boolean;
}>;

/** A one-way byte pipe: writes queue up until read; `end` finishes the reader. */
function pipe() {
	const chunks: Uint8Array[] = [];
	let ended = false;
	let wake: (() => void) | undefined;
	const notify = () => {
		wake?.();
		wake = undefined;
	};
	return {
		push(chunk: Uint8Array) {
			if (ended) throw new Error("the stream is closed");
			chunks.push(chunk);
			notify();
		},
		end() {
			ended = true;
			notify();
		},
		async *drain(): AsyncIterable<Uint8Array> {
			for (;;) {
				const next = chunks.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

function streamPair(
	initiator: string,
	acceptor: string,
	faults: Faults,
): readonly [FleetStream, FleetStream] {
	const forward = pipe();
	const backward = pipe();
	const end = (
		peer: string,
		outgoing: ReturnType<typeof pipe>,
		incoming: ReturnType<typeof pipe>,
	): FleetStream => {
		let sent = 0;
		let received = 0;
		return {
			peer,
			async *read() {
				for await (const chunk of incoming.drain()) {
					received += chunk.length;
					yield chunk;
				}
			},
			async write(chunk) {
				const copy = chunk.slice();
				const limit = faults.corruptAfterBytes;
				if (limit !== undefined && sent < limit && sent + copy.length > limit) {
					const index = limit - sent;
					copy[index] = (copy[index] ?? 0) ^ 0xff;
				}
				sent += copy.length;
				outgoing.push(copy);
			},
			async close() {
				outgoing.end();
				return faults.swappedCounts === true
					? { bytesSent: received, bytesReceived: sent }
					: { bytesSent: sent, bytesReceived: received };
			},
		};
	};
	return [end(acceptor, forward, backward), end(initiator, backward, forward)];
}

type Acceptor = Readonly<{
	authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>;
	handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>;
	authorised: Set<string>;
}>;

const failure = (message: string): Outcome<FleetStream> => ({
	ok: false,
	error: { code: "session-denied", message },
});

function transportOn(
	network: Map<string, Acceptor>,
	faults: Faults,
): FleetTransport {
	let identity: string | undefined;
	return {
		kind: "bus-relay",
		async start(keys) {
			identity = `mem-${keys.memberId}`;
			return { transportIdentity: identity };
		},
		async dial({ grant, signal }) {
			if (signal.aborted && faults.ignoreAbort !== true)
				return failure("aborted");
			if (identity === undefined) return failure("not started");
			let decoded: SessionGrant;
			try {
				decoded = fromBinary(SessionGrantSchema, grant.payload);
			} catch {
				return failure("unreadable grant");
			}
			const target = network.get(decoded.acceptor?.transportIdentity ?? "");
			if (target === undefined) return failure("no such acceptor");
			const peer =
				faults.peerFromGrant === true
					? (decoded.initiator?.transportIdentity ?? identity)
					: identity;
			const [mine, theirs] = streamPair(
				identity,
				decoded.acceptor?.transportIdentity ?? "",
				faults,
			);
			const handed =
				faults.emptyHandlerGrant === true
					? create(SessionGrantSchema)
					: decoded;
			const handOver = () => {
				target.handler(theirs, handed).catch(() => undefined);
			};
			if (faults.handOverBeforeAuthorise === true) handOver();
			const known =
				faults.authoriseOncePerPeer === true && target.authorised.has(peer);
			const allowed = known || (await target.authorise(peer, grant));
			if (!allowed) {
				await theirs.close();
				await mine.close();
				return failure("not authorised");
			}
			target.authorised.add(peer);
			if (faults.handOverBeforeAuthorise !== true) handOver();
			return { ok: true, value: mine };
		},
		accept(authorise, handler) {
			const own = identity;
			if (own === undefined) throw new Error("accept before start");
			network.set(own, { authorise, handler, authorised: new Set() });
			return {
				async stop() {
					if (faults.stopKeepsAccepting !== true) network.delete(own);
				},
			};
		},
		async stop() {
			if (identity !== undefined && faults.stopKeepsAccepting !== true)
				network.delete(identity);
		},
	};
}

const pairWith =
	(faults: Faults): TransportMake =>
	async () => {
		const network = new Map<string, Acceptor>();
		return [transportOn(network, faults), transportOn(network, faults)];
	};

/** The reference pair: passes `runTransportConformance`. */
export const memoryTransports: TransportMake = pairWith({});

export const BROKEN_TRANSPORTS: ReadonlyMap<string, TransportMake> = new Map([
	[
		"a granted dial carries 64 MiB with a matching digest, and an answer back",
		pairWith({ corruptAfterBytes: 32 * 1024 * 1024 + 7 }),
	],
	[
		"authorise sees the dialler's proven identity and the presented grant",
		pairWith({ emptyHandlerGrant: true }),
	],
	[
		"an ungranted dial is refused before any byte is delivered",
		pairWith({ handOverBeforeAuthorise: true }),
	],
	[
		"an expired grant is refused, even from a peer granted before",
		pairWith({ authoriseOncePerPeer: true }),
	],
	[
		"a grant naming another initiator is refused",
		pairWith({ peerFromGrant: true }),
	],
	[
		"close reports the bytes each side sent and received",
		pairWith({ swappedCounts: true }),
	],
	["a dial with an aborted signal fails", pairWith({ ignoreAbort: true })],
	[
		"after stop the acceptor takes no dial",
		pairWith({ stopKeepsAccepting: true }),
	],
]);
