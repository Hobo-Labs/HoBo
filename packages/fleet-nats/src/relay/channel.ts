/**
 * One relay session as a raw `FleetStream`: `DATA` messages in publish order,
 * with credit-based flow control so a fast writer never outruns a slow reader
 * through a bus that does not push back. Each side may have at most `window`
 * bytes unread at the other; the reader returns credit as its consumer takes
 * bytes, half a window at a time. A sender that exceeds its credit is reset.
 *
 * The bytes here are what `frameStream` wrote, so they are already ciphertext;
 * this layer neither encrypts nor authenticates.
 */
import type { FleetStream, MemberId } from "@hobo/fleet";
import { RELAY_MESSAGE, type RelayMessage } from "./wire.js";

/** The largest `DATA` payload; a framed write is at most 64 KiB and 20 bytes. */
export const MAX_DATA_BYTES = 128 * 1024;
export const DEFAULT_WINDOW_BYTES = 1024 * 1024;

export type ChannelDeps = Readonly<{
	/** The relay session id on the subject. */
	id: string;
	/** Who the other end is on the bus. */
	to: MemberId;
	send(message: RelayMessage): Promise<void>;
	/** Called once, when the channel is finished either way. */
	release(): void;
	windowBytes: number;
	/** How long a write waits for credit before the session is abandoned. */
	creditTimeoutMs: number;
}>;

export type Channel = Readonly<{
	stream(peer: string): FleetStream;
	/** Hands an incoming message of this session to the channel. */
	receive(message: RelayMessage): void;
	/** Ends the session locally, telling the other end (`RESET`) unless `quiet`. */
	reset(reason: string, quiet?: boolean): void;
}>;

type Waiter = Readonly<{ wake(): void }>;

export function createChannel(deps: ChannelDeps): Channel {
	const inbox: Uint8Array[] = [];
	let credit = deps.windowBytes;
	/** Bytes received beyond what has been credited back, as the sender sees it. */
	let outstanding = 0;
	/** Bytes the consumer has taken and not yet credited back. */
	let consumed = 0;
	let remoteEnded = false;
	let failure: Error | undefined;
	let localClosed = false;
	let released = false;
	const waiters = new Set<Waiter>();

	const wakeAll = () => {
		for (const waiter of waiters) waiter.wake();
	};
	const release = () => {
		if (released) return;
		released = true;
		deps.release();
	};
	const sendQuietly = (message: RelayMessage) =>
		deps.send(message).catch(() => undefined);

	const reset = (reason: string, quiet = false) => {
		if (failure === undefined) failure = new Error(reason);
		if (!quiet && !localClosed) void sendQuietly({ type: RELAY_MESSAGE.RESET });
		release();
		wakeAll();
	};

	const finished = () => failure !== undefined || localClosed || remoteEnded;

	/** Resolves when `ready` holds or the channel fails; rejects on timeout. */
	const until = (ready: () => boolean, timeoutMs: number | undefined) =>
		new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter: Waiter = {
				wake() {
					if (!ready() && !finished()) return;
					waiters.delete(waiter);
					if (timer !== undefined) clearTimeout(timer);
					resolve();
				},
			};
			if (ready() || finished()) {
				resolve();
				return;
			}
			waiters.add(waiter);
			if (timeoutMs !== undefined)
				timer = setTimeout(() => {
					waiters.delete(waiter);
					reset("the relay peer stopped taking bytes");
					reject(failure);
				}, timeoutMs);
		});

	const receive = (message: RelayMessage) => {
		if (failure !== undefined || localClosed) return;
		switch (message.type) {
			case RELAY_MESSAGE.DATA:
				if (remoteEnded) return;
				outstanding += message.payload.length;
				if (outstanding > deps.windowBytes) {
					reset("the relay peer sent past its credit");
					return;
				}
				inbox.push(message.payload.slice());
				break;
			case RELAY_MESSAGE.CREDIT:
				credit += message.bytes;
				break;
			case RELAY_MESSAGE.END:
				remoteEnded = true;
				break;
			case RELAY_MESSAGE.RESET:
				reset("the relay peer reset the session", true);
				return;
			case RELAY_MESSAGE.OPEN:
				return;
		}
		wakeAll();
	};

	const take = (chunk: Uint8Array) => {
		consumed += chunk.length;
		if (consumed >= deps.windowBytes / 2) {
			const bytes = consumed;
			consumed = 0;
			outstanding -= bytes;
			void sendQuietly({ type: RELAY_MESSAGE.CREDIT, bytes });
		}
	};

	let bytesSent = 0;
	let bytesReceived = 0;
	let closing:
		| Promise<Readonly<{ bytesSent: number; bytesReceived: number }>>
		| undefined;

	const stream = (peer: string): FleetStream => ({
		peer,
		async *read() {
			for (;;) {
				await until(() => inbox.length > 0 || remoteEnded, undefined);
				const chunk = inbox.shift();
				if (chunk !== undefined) {
					take(chunk);
					bytesReceived += chunk.length;
					yield chunk;
					continue;
				}
				if (failure !== undefined) throw failure;
				return;
			}
		},
		async write(chunk) {
			for (let offset = 0; offset < chunk.length; offset += MAX_DATA_BYTES) {
				const piece = chunk.subarray(offset, offset + MAX_DATA_BYTES);
				await until(() => credit >= piece.length, deps.creditTimeoutMs);
				if (failure !== undefined) throw failure;
				if (localClosed) throw new Error("the relay session is closed");
				// The peer has closed and reads no more: what it would not read is dropped.
				if (remoteEnded) return;
				credit -= piece.length;
				bytesSent += piece.length;
				await deps.send({ type: RELAY_MESSAGE.DATA, payload: piece });
			}
		},
		close() {
			closing ??= (async () => {
				if (failure === undefined && !localClosed)
					await sendQuietly({ type: RELAY_MESSAGE.END });
				localClosed = true;
				release();
				wakeAll();
				return Object.freeze({ bytesSent, bytesReceived });
			})();
			return closing;
		},
	});

	return { stream, receive, reset };
}
