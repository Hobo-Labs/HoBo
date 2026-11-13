/**
 * A TCP socket as a raw `FleetStream`: exact reads for the handshake, then
 * the rest of the bytes, starting with whatever the handshake read too far.
 * Writes wait for the socket to drain, so a bulk transfer is paced by TCP.
 */
import type { Socket } from "node:net";
import type { FleetStream } from "@hobo/fleet";

export type SocketReader = Readonly<{
	/** Exactly `count` bytes, or undefined when the socket ended first. */
	exact(count: number): Promise<Uint8Array | undefined>;
	/** The socket as a raw stream; its reads start after the bytes `exact` took. */
	stream(peer: string): FleetStream;
}>;

export function socketReader(socket: Socket): SocketReader {
	// Never `return()`ed: that would destroy the socket under the reader.
	const source: AsyncIterator<Buffer> = socket[Symbol.asyncIterator]();
	let pending: Buffer = Buffer.alloc(0);
	let bytesSent = 0;
	let bytesReceived = 0;
	let closed:
		| Promise<Readonly<{ bytesSent: number; bytesReceived: number }>>
		| undefined;

	const pull = async (): Promise<boolean> => {
		const next = await source.next();
		if (next.done === true) return false;
		pending =
			pending.length === 0 ? next.value : Buffer.concat([pending, next.value]);
		return true;
	};

	return {
		async exact(count) {
			while (pending.length < count) if (!(await pull())) return undefined;
			const taken = new Uint8Array(pending.subarray(0, count));
			pending = pending.subarray(count);
			return taken;
		},
		stream(peer) {
			return {
				peer,
				async *read() {
					for (;;) {
						if (pending.length === 0 && !(await pull())) return;
						const chunk = new Uint8Array(pending);
						pending = Buffer.alloc(0);
						bytesReceived += chunk.length;
						yield chunk;
					}
				},
				async write(chunk) {
					if (closed !== undefined || socket.destroyed)
						throw new Error("the overlay connection is closed");
					bytesSent += chunk.length;
					if (socket.write(chunk)) return;
					await new Promise<void>((resolve, reject) => {
						const done = () => {
							socket.off("drain", done);
							socket.off("close", gone);
							resolve();
						};
						const gone = () => {
							socket.off("drain", done);
							reject(new Error("the overlay connection closed"));
						};
						socket.once("drain", done);
						socket.once("close", gone);
					});
				},
				close() {
					closed ??= new Promise((resolve) => {
						const counts = Object.freeze({ bytesSent, bytesReceived });
						if (socket.destroyed || socket.writableEnded) {
							resolve(counts);
							return;
						}
						socket.end(() => resolve(counts));
					});
					return closed;
				},
			};
		},
	};
}
