import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { HttpTransport } from "@hobo/core";

/** Internal seam: a transport constructed with an arbitrary sender is never
 * enrolled. The public factory passes the imported Node HTTPS implementation. */
export type JournalHttpRequest = (
	url: URL,
	options: RequestOptions,
	onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const MAX_RESPONSE_HEADER_BYTES = 16_384;

/** One native request, with no redirect handling or retry. The deadline covers
 * connection, request and response. Body bytes are counted before buffering. */
export function createJournalHttpTransport(
	send: JournalHttpRequest,
	agent?: RequestOptions["agent"],
): HttpTransport {
	return (request) =>
		new Promise((resolve, reject) => {
			let done = false;
			let outbound: ClientRequest | undefined;
			let incoming: IncomingMessage | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error: string) => {
				if (done) return;
				done = true;
				if (timer) clearTimeout(timer);
				incoming?.destroy();
				outbound?.destroy();
				reject(new Error(error));
			};
			timer = setTimeout(
				() => finish("Upstash Blob journal request timed out"),
				request.timeoutMs,
			);
			try {
				outbound = send(
					new URL(request.url),
					{
						method: request.method,
						headers: request.headers,
						maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
						...(agent ? { agent } : undefined),
					},
					(response) => {
						incoming = response;
						const status = response.statusCode ?? 0;
						if (status >= 300 && status < 400) {
							finish("Upstash Blob journal redirect refused");
							return;
						}
						const headers: Record<string, string> = {};
						for (const [name, value] of Object.entries(response.headers)) {
							if (Array.isArray(value)) headers[name] = value.join(", ");
							else if (value !== undefined) headers[name] = value;
						}
						if (
							headers["content-encoding"] &&
							headers["content-encoding"] !== "identity"
						) {
							finish("Upstash Blob journal content encoding refused");
							return;
						}
						const declared = Number(headers["content-length"]);
						if (
							Number.isFinite(declared) &&
							declared > request.maxResponseBytes
						) {
							finish("Upstash Blob journal response exceeds its byte cap");
							return;
						}
						const chunks: Buffer[] = [];
						let bytes = 0;
						response.on("data", (chunk: Buffer) => {
							if (done) return;
							if (!Buffer.isBuffer(chunk)) {
								finish("Upstash Blob journal response is invalid");
								return;
							}
							bytes += chunk.length;
							if (bytes > request.maxResponseBytes) {
								finish("Upstash Blob journal response exceeds its byte cap");
								return;
							}
							chunks.push(chunk);
						});
						response.once("aborted", () =>
							finish("Upstash Blob journal response was interrupted"),
						);
						response.once("error", () =>
							finish("Upstash Blob journal response was interrupted"),
						);
						response.once("end", () => {
							if (done) return;
							let body: string;
							try {
								body = new TextDecoder("utf-8", {
									fatal: true,
									ignoreBOM: true,
								}).decode(Buffer.concat(chunks, bytes));
							} catch {
								finish("Upstash Blob journal response is invalid");
								return;
							}
							done = true;
							if (timer) clearTimeout(timer);
							resolve({ status, headers, body });
						});
					},
				);
				outbound.once("error", () =>
					finish("Upstash Blob journal request failed"),
				);
				outbound.end(request.body);
			} catch {
				finish("Upstash Blob journal request failed");
			}
		});
}
