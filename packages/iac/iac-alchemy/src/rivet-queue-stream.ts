/** Maximum time to receive a queue request or its complete response. */
export const RIVET_QUEUE_TIMEOUT_MS = 10_000;
export const RIVET_QUEUE_CHUNK_BYTES = 65_536;

/**
 * Read bounded bytes. Non-BYOB streams are accepted only when a trusted host
 * verifies that the entire upstream path enforces both total and chunk limits.
 */
export async function readRivetQueueStream(
	body: ReadableStream<Uint8Array> | null,
	maximum: number,
	signal?: AbortSignal,
	verifyDefaultStream?: () => boolean | Promise<boolean>,
): Promise<Uint8Array> {
	if (body === null) throw new Error("queue body is missing");
	let reader:
		| ReadableStreamBYOBReader
		| ReadableStreamDefaultReader<Uint8Array>
		| undefined;
	let byob = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const deadline = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("queue request aborted"));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() => reject(new Error("queue stream timed out")),
			RIVET_QUEUE_TIMEOUT_MS,
		);
	});
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		try {
			reader = body.getReader({ mode: "byob" });
		} catch {
			byob = false;
			if (
				verifyDefaultStream === undefined ||
				(await Promise.race([verifyDefaultStream(), deadline])) !== true
			)
				throw new Error("trusted queue ingress required for non-BYOB streams");
			reader = body.getReader();
		}
		while (true) {
			const limit = Math.min(RIVET_QUEUE_CHUNK_BYTES, maximum - total + 1);
			// SAFETY: the reader type follows the successfully selected mode.
			const next = await Promise.race([
				byob
					? (reader as ReadableStreamBYOBReader).read(new Uint8Array(limit))
					: (reader as ReadableStreamDefaultReader<Uint8Array>).read(),
				deadline,
			]);
			if (next.done) break;
			if (
				!(next.value instanceof Uint8Array) ||
				next.value.byteLength === 0 ||
				next.value.byteLength > RIVET_QUEUE_CHUNK_BYTES ||
				chunks.length >= 4096
			)
				throw new Error("invalid or oversized queue chunk");
			total += next.value.byteLength;
			if (total > maximum) throw new Error("queue body exceeds limit");
			chunks.push(new Uint8Array(next.value));
		}
	} catch (error) {
		if (reader !== undefined) void reader.cancel().catch(() => {});
		else void body.cancel().catch(() => {});
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (abort !== undefined) signal?.removeEventListener("abort", abort);
		reader?.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
