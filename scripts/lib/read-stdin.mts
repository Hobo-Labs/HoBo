/**
 * Standard input, read to end of file synchronously on a pipe that may be in
 * non-blocking mode.
 *
 * `readFileSync(0)` gives up at the first read that would block. On a
 * non-blocking pipe whose writer has not written yet, that read fails with
 * EAGAIN, so `git diff --name-only HEAD^1 HEAD | node … scripts/ci/job-scope.mts`
 * crashed whenever node reached the read before git wrote: PR #1772's
 * "artifact signing and install verification" job died that way in 14 s, and
 * the same job passed on other PRs. Node 22 puts the pipe in that mode itself.
 * `import process from "node:process"` builds the module's exports from every
 * property of `process`, which runs the lazy `process.stdin` getter; on a pipe
 * that opens a `net.Socket` over fd 0, and libuv's `uv_pipe_open` sets
 * O_NONBLOCK. The flag belongs to the pipe's open file description, so every
 * later read of fd 0 sees it, `readFileSync(0)` included.
 *
 * `readStdin` reads with `readSync` and takes EAGAIN to mean "nothing yet": it
 * sleeps on `Atomics.wait`, so it does not spin, and reads again. It gives up
 * only when nothing has arrived for `STDIN_IDLE_LIMIT_MS`.
 *
 * Node builtins only: job-scope.mts imports it and runs before `pnpm install`.
 */
import { Buffer } from "node:buffer";
import { readSync } from "node:fs";

/** Where `readStdin` reads and how it waits. Tests pass their own. */
export type StdinSource = Readonly<{
	/**
	 * Fills `buffer` from its start and returns the byte count, 0 at end of
	 * file. Throws EAGAIN while the pipe is empty and still open.
	 */
	read: (buffer: Buffer) => number;
	/** Blocks the thread for `ms` milliseconds. */
	sleep: (ms: number) => void;
	/** Milliseconds on a clock that never runs backwards. */
	now: () => number;
}>;

/** How long `readStdin` sleeps after a read finds the pipe empty. */
export const STDIN_RETRY_MS = 10;
/** How long `readStdin` waits with nothing arriving before it gives up. */
export const STDIN_IDLE_LIMIT_MS = 30_000;

const CHUNK_BYTES = 64 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** This process's fd 0. */
export const processStdin: StdinSource = {
	read: (buffer) => readSync(0, buffer, 0, buffer.length, null),
	sleep: (ms) => {
		Atomics.wait(sleeper, 0, 0, ms);
	},
	now: () => performance.now(),
};

/** Everything up to end of file, decoded as UTF-8, as `readFileSync(0, "utf8")` returns it. */
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
