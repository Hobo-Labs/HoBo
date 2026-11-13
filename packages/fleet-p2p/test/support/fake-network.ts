/**
 * An in-memory `EndpointBinding` for the unit tests: endpoints on one fake
 * network reach one another by id, connections carry ordered byte streams,
 * and closing a connection fails the reads and writes still pending on it, as
 * a lost QUIC connection does.
 */
import { createHash } from "node:crypto";
import type {
	BoundEndpoint,
	DuplexStream,
	EndpointBinding,
	EndpointConnection,
	EndpointOptions,
} from "../../src/endpoint.js";

/** A queue whose `take` waits for the next `put`; `end` makes every taker answer undefined. */
function createQueue<T>() {
	const items: T[] = [];
	const takers: ((item: T | undefined) => void)[] = [];
	let ended = false;
	return {
		put(item: T) {
			const taker = takers.shift();
			if (taker !== undefined) taker(item);
			else items.push(item);
		},
		take(): Promise<T | undefined> {
			const item = items.shift();
			if (item !== undefined) return Promise.resolve(item);
			if (ended) return Promise.resolve(undefined);
			return new Promise((resolve) => takers.push(resolve));
		},
		end() {
			ended = true;
			for (const taker of takers.splice(0)) taker(undefined);
		},
	};
}

class ConnectionLost extends Error {
	constructor() {
		super("connection lost");
		this.name = "ConnectionLost";
	}
}

/** One direction of a stream: bytes in order, then end-of-stream. */
function createPipe(lost: () => boolean) {
	const chunks: Uint8Array[] = [];
	let finished = false;
	let wake: (() => void) | undefined;
	const notify = () => {
		const waiting = wake;
		wake = undefined;
		waiting?.();
	};
	return {
		write(bytes: Uint8Array) {
			if (lost() || finished) throw new ConnectionLost();
			if (bytes.length > 0) chunks.push(bytes.slice());
			notify();
		},
		finish() {
			finished = true;
			notify();
		},
		notify,
		async read(max: number): Promise<Uint8Array> {
			for (;;) {
				if (lost()) throw new ConnectionLost();
				const head = chunks[0];
				if (head !== undefined) {
					if (head.length <= max) {
						chunks.shift();
						return head;
					}
					chunks[0] = head.subarray(max);
					return head.subarray(0, max);
				}
				if (finished) return new Uint8Array(0);
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

type Side = {
	readonly id: string;
	readonly incoming: ReturnType<typeof createQueue<DuplexStream>>;
};

function createConnectionPair(
	dialler: string,
	acceptor: string,
): readonly [EndpointConnection, EndpointConnection] {
	let lost = false;
	let markClosed: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		markClosed = resolve;
	});
	const pipes: ReturnType<typeof createPipe>[] = [];
	const lose = () => {
		if (lost) return;
		lost = true;
		for (const pipe of pipes) pipe.notify();
		for (const side of sides) side.incoming.end();
		markClosed();
	};
	const sides: readonly Side[] = [
		{ id: dialler, incoming: createQueue<DuplexStream>() },
		{ id: acceptor, incoming: createQueue<DuplexStream>() },
	];
	const end = (
		pipe: ReturnType<typeof createPipe>,
		reverse: ReturnType<typeof createPipe>,
	): DuplexStream => ({
		async write(bytes) {
			pipe.write(bytes);
		},
		async finish() {
			pipe.finish();
		},
		async flushed() {},
		read: (max) => reverse.read(max),
	});
	const connection = (self: Side, other: Side): EndpointConnection => ({
		remoteId: other.id,
		async openStream() {
			if (lost) throw new ConnectionLost();
			const out = createPipe(() => lost);
			const back = createPipe(() => lost);
			pipes.push(out, back);
			other.incoming.put(end(back, out));
			return end(out, back);
		},
		async acceptStream() {
			const stream = await self.incoming.take();
			if (stream === undefined) throw new ConnectionLost();
			return stream;
		},
		close: lose,
		closed: () => closed,
	});
	const [first, second] = sides;
	if (first === undefined || second === undefined) throw new Error("two sides");
	return [connection(first, second), connection(second, first)];
}

export type FakeNetwork = EndpointBinding &
	Readonly<{
		/** The options of every bind, in order. */
		bound: EndpointOptions[];
		/** Every connection either side has opened and not yet closed. */
		open(): number;
	}>;

export function createFakeNetwork(): FakeNetwork {
	const endpoints = new Map<
		string,
		Readonly<{
			alpn: string;
			incoming: ReturnType<typeof createQueue<EndpointConnection>>;
			connections: Set<EndpointConnection>;
		}>
	>();
	const bound: EndpointOptions[] = [];
	const live = new Set<EndpointConnection>();
	return {
		bound,
		open: () => live.size,
		async bind(options) {
			bound.push(options);
			const id = createHash("sha256").update(options.secretKey).digest("hex");
			const alpn = Buffer.from(options.alpn).toString("hex");
			const incoming = createQueue<EndpointConnection>();
			const connections = new Set<EndpointConnection>();
			endpoints.set(id, { alpn, incoming, connections });
			const endpoint: BoundEndpoint = {
				id,
				async online() {},
				async connect(peer) {
					const target = endpoints.get(peer);
					if (target === undefined || target.alpn !== alpn)
						throw new Error(`no route to ${peer}`);
					const [mine, theirs] = createConnectionPair(id, peer);
					for (const each of [mine, theirs]) {
						live.add(each);
						void each.closed().then(() => live.delete(each));
					}
					connections.add(mine);
					target.connections.add(theirs);
					target.incoming.put(theirs);
					return mine;
				},
				accept: () => incoming.take(),
				async close() {
					endpoints.delete(id);
					incoming.end();
					for (const connection of connections) connection.close();
				},
			};
			return endpoint;
		},
	};
}
