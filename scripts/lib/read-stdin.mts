import { Buffer } from "node:buffer";
import { readSync } from "node:fs";

export type StdinSource = Readonly<{
	read: (buffer: Buffer) => number;
	sleep: (ms: number) => void;
	now: () => number;
}>;

export const STDIN_RETRY_MS = 10;
export const STDIN_IDLE_LIMIT_MS = 30_000;

const CHUNK_BYTES = 64 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export const processStdin: StdinSource = {
	read: (buffer) => readSync(0, buffer, 0, buffer.length, null),
	sleep: (ms) => {
		Atomics.wait(sleeper, 0, 0, ms);
	},
	now: () => performance.now(),
};

export function readStdin(source: StdinSource = processStdin): string {
	const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
	const chunks: Buffer[] = [];
	let lastArrival = source.now();
	for (;;) {
		let bytes: number;
		try {
			bytes = source.read(buffer);
		} catch (error) {
			const empty =
				error instanceof Error && "code" in error && error.code === "EAGAIN";
			if (!empty) throw error;
			if (source.now() - lastArrival >= STDIN_IDLE_LIMIT_MS)
				throw new Error(
					`stdin: nothing arrived for ${STDIN_IDLE_LIMIT_MS / 1000} s, and the writer has not closed the pipe`,
					{ cause: error },
				);
			source.sleep(STDIN_RETRY_MS);
			continue;
		}
		if (bytes === 0) return Buffer.concat(chunks).toString("utf8");
		chunks.push(Buffer.from(buffer.subarray(0, bytes)));
		lastArrival = source.now();
	}
}
