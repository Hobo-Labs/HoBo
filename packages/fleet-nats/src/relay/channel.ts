import type { FleetStream, MemberId } from "@hobo/fleet";
import { RELAY_MESSAGE, type RelayMessage } from "./wire.js";

export const MAX_DATA_BYTES = 128 * 1024;
export const DEFAULT_WINDOW_BYTES = 1024 * 1024;

export type ChannelDeps = Readonly<{
	id: string;
	to: MemberId;
	send(message: RelayMessage): Promise<void>;
	release(): void;
	windowBytes: number;
	creditTimeoutMs: number;
}>;

export type Channel = Readonly<{
	stream(peer: string): FleetStream;
	receive(message: RelayMessage): void;
	reset(reason: string, quiet?: boolean): void;
}>;

type Waiter = Readonly<{ wake(): void }>;

export function createChannel(deps: ChannelDeps): Channel {
	const inbox: Uint8Array[] = [];
	let credit = deps.windowBytes;
	let outstanding = 0;
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
