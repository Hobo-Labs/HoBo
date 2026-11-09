import {
	type HttpTransport,
	TransportGuardError,
	type TransportResponse,
} from "./http-transport.js";

/** WHATWG transport with an enforced total deadline and a streaming memory bound.
 * Compose with guardTransport for provider-specific origin and path authority. */
export function createBoundedFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): HttpTransport {
	return async (request) => {
		if (
			!Number.isSafeInteger(request.timeoutMs) ||
			request.timeoutMs <= 0 ||
			request.timeoutMs > 2_147_483_647
		)
			throw new TransportGuardError(
				"TRANSPORT_TIMEOUT_EXCEEDED",
				"request timeout must be a positive supported integer duration",
			);
		if (
			!Number.isSafeInteger(request.maxResponseBytes) ||
			request.maxResponseBytes <= 0
		)
			throw new TransportGuardError(
				"TRANSPORT_BODY_TOO_LARGE",
				"response byte cap must be a positive safe integer",
			);
		const controller = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			controller.abort();
			void reader?.cancel().catch(() => {});
		};
		const tooLarge = () =>
			new TransportGuardError(
				"TRANSPORT_BODY_TOO_LARGE",
				`provider response exceeded the ${request.maxResponseBytes} byte cap`,
			);
		const deadline = new Promise<never>((_resolve, reject) => {
			deadlineTimer = setTimeout(() => {
				cancel();
				reject(
					new TransportGuardError(
						"TRANSPORT_TIMEOUT_EXCEEDED",
						"provider request exceeded its total deadline; its external outcome remains unknown",
					),
				);
			}, request.timeoutMs);
		});
		const perform = async (): Promise<TransportResponse> => {
			const init: RequestInit = {
				method: request.method,
				headers: { ...request.headers },
				redirect: "manual",
				signal: controller.signal,
			};
			if (request.body !== undefined) init.body = request.body;
			const response = await options.fetchImpl(request.url, init);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
			const declaredLength = Number(headers["content-length"]);
			if (
				Number.isFinite(declaredLength) &&
				declaredLength > request.maxResponseBytes
			) {
				controller.abort();
				void response.body?.cancel().catch(() => {});
				throw tooLarge();
			}
			if (response.body === null)
				return { status: response.status, headers, body: "" };
			reader = response.body.getReader();
			const decoder = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			});
			const chunks: string[] = [];
			let bytes = 0;
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					bytes += next.value.byteLength;
					if (bytes > request.maxResponseBytes) {
						cancel();
						throw tooLarge();
					}
					chunks.push(decoder.decode(next.value, { stream: true }));
				}
				chunks.push(decoder.decode());
				return { status: response.status, headers, body: chunks.join("") };
			} catch (error) {
				cancel();
				throw error;
			} finally {
				reader.releaseLock();
			}
		};
		try {
			return await Promise.race([perform(), deadline]);
		} catch (error) {
			cancel();
			throw error;
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		}
	};
}
