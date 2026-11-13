/**
 * `EndpointBinding` over the pinned `@number0/iroh` binding (L11, A8, A9).
 *
 * Each endpoint is built from the minimal preset (a crypto provider and
 * nothing else: no n0 relays, no DNS or pkarr discovery), then given the
 * caller's secret key, the one ALPN, and a relay map of exactly the configured
 * relays (or none). With no discovery, a peer is dialled by its endpoint id at
 * each configured relay, and iroh upgrades to a direct path by hole punching
 * where it can. The id of an accepted connection is the one its QUIC handshake
 * proved.
 *
 * The binding is a native addon with prebuilds for a fixed set of platforms;
 * `loadIroh` answers undefined where none loads, which the transport reports
 * as unavailable.
 */
import { createRequire } from "node:module";
import type * as Iroh from "@number0/iroh";
import type {
	BoundEndpoint,
	DuplexStream,
	EndpointBinding,
	EndpointConnection,
} from "./endpoint.js";

export type IrohModule = typeof Iroh;

function requireIroh(): IrohModule {
	// SAFETY: the binding's own declaration file (index.d.ts) describes what its CommonJS entry exports.
	return createRequire(import.meta.url)("@number0/iroh") as IrohModule;
}

/** The binding, or undefined when this platform has no prebuilt one. */
export function loadIroh(
	load: () => IrohModule = requireIroh,
): IrohModule | undefined {
	try {
		return load();
	} catch {
		return undefined;
	}
}

/** Exactly the configured relays; none disables relaying. The n0 relays are never used. */
export function irohRelayMode(
	iroh: IrohModule,
	relayUrls: readonly string[],
): Iroh.RelayMode {
	return relayUrls.length === 0
		? iroh.RelayMode.disabled()
		: iroh.RelayMode.customFromUrls([...relayUrls]);
}

function wrapStream(pair: Iroh.BiStream): DuplexStream {
	const send = pair.send;
	const recv = pair.recv;
	return {
		async write(bytes) {
			await send.writeAll(Array.from(bytes));
		},
		async finish() {
			await send.finish();
		},
		async flushed(timeoutMs) {
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				send.stopped().catch(() => null),
				new Promise((resolve) => {
					timer = setTimeout(resolve, timeoutMs);
				}),
			]);
			clearTimeout(timer);
		},
		async read(max) {
			return new Uint8Array(await recv.read(max));
		},
	};
}

function wrapConnection(connection: Iroh.Connection): EndpointConnection {
	return {
		remoteId: connection.remoteId().toString(),
		openStream: async () => wrapStream(await connection.openBi()),
		acceptStream: async () => wrapStream(await connection.acceptBi()),
		close() {
			try {
				connection.close(0n, []);
			} catch {
				// Already closed.
			}
		},
		closed: () =>
			connection.closed().then(
				() => undefined,
				() => undefined,
			),
	};
}

function sameBytes(a: readonly number[], b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function createIrohBinding(
	iroh: IrohModule,
	options: Readonly<{
		/**
		 * Same-host tests only: endpoints bind to 127.0.0.1, record their sockets
		 * here, and dial a peer found here at its direct addresses. Production
		 * passes none and reaches peers through the configured relays.
		 */
		addressBook?: Map<string, readonly string[]>;
	}>,
): EndpointBinding {
	const book = options.addressBook;
	return {
		async bind({ secretKey, relayUrls, alpn }) {
			const alpnBytes = Array.from(alpn);
			const builder = iroh.Endpoint.builder();
			iroh.presetMinimal(builder);
			builder.secretKey(Array.from(secretKey));
			builder.alpns([alpnBytes]);
			builder.relayMode(irohRelayMode(iroh, relayUrls));
			if (book !== undefined) builder.bindAddr("127.0.0.1:0");
			const endpoint = await builder.bind();
			const id = endpoint.id().toString();
			book?.set(id, endpoint.boundSockets());

			// Handshakes run concurrently, so a slow peer cannot hold up the next one.
			const ready: EndpointConnection[] = [];
			const waiting: ((connection: EndpointConnection | undefined) => void)[] =
				[];
			let ended = false;
			const deliver = (connection: EndpointConnection | undefined) => {
				const taker = waiting.shift();
				if (taker !== undefined) taker(connection);
				else if (connection !== undefined) ready.push(connection);
			};
			const handshake = async (incoming: Iroh.Incoming) => {
				try {
					const connection = await (await incoming.accept()).connect();
					if (!sameBytes(connection.alpn(), alpn)) {
						connection.close(0n, []);
						return;
					}
					if (ended) connection.close(0n, []);
					else deliver(wrapConnection(connection));
				} catch {
					// A failed handshake is the peer's problem; keep accepting.
				}
			};
			void (async () => {
				for (;;) {
					const incoming = await endpoint.acceptNext().catch(() => null);
					if (incoming === null) break;
					void handshake(incoming);
				}
				ended = true;
				for (const taker of waiting.splice(0)) taker(undefined);
			})();

			const bound: BoundEndpoint = {
				id,
				online: () =>
					relayUrls.length === 0 ? Promise.resolve() : endpoint.online(),
				async connect(peer) {
					const peerId = iroh.EndpointId.fromString(peer);
					const direct = book?.get(peer);
					const addresses =
						direct !== undefined
							? [new iroh.EndpointAddr(peerId, null, [...direct])]
							: relayUrls.map(
									(url) => new iroh.EndpointAddr(peerId, url, null),
								);
					if (addresses.length === 0)
						throw new Error(
							"no relay is configured through which to reach the peer",
						);
					const attempts = addresses.map((address) =>
						endpoint.connect(address, alpnBytes),
					);
					const winner = await Promise.any(attempts);
					// Close any other attempt that also connects.
					for (const attempt of attempts)
						void attempt.then(
							(other) => {
								if (other !== winner) other.close(0n, []);
							},
							() => undefined,
						);
					return wrapConnection(winner);
				},
				accept() {
					const connection = ready.shift();
					if (connection !== undefined) return Promise.resolve(connection);
					if (ended) return Promise.resolve(undefined);
					return new Promise((resolve) => waiting.push(resolve));
				},
				async close() {
					book?.delete(id);
					if (!endpoint.isClosed()) await endpoint.close();
					ended = true;
					for (const taker of waiting.splice(0)) taker(undefined);
				},
			};
			return bound;
		},
	};
}
