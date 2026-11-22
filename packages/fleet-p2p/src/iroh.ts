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
	return createRequire(import.meta.url)("@number0/iroh");
}

export function loadIroh(
	load: () => IrohModule = requireIroh,
): IrohModule | undefined {
	try {
		return load();
	} catch {
		return undefined;
	}
}

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
			} catch {}
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
				} catch {}
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
