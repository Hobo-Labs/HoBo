import {
	type HttpTransport,
	TransportGuardError,
	type TransportResponse,
} from "@hobo/core";

// public-contract: the cross-package marker a latin1 (byte) transport carries.
export const HTTP_TRANSPORT_BODY_ENCODING = Symbol.for(
	"hobo.http-transport.body-encoding",
);

export function declareLatin1Transport(
	transport: HttpTransport,
): HttpTransport {
	Object.defineProperty(transport, HTTP_TRANSPORT_BODY_ENCODING, {
		value: "latin1",
		enumerable: false,
	});
	return transport;
}

export function isLatin1Transport(transport: HttpTransport): boolean {
	return (
		Object.getOwnPropertyDescriptor(transport, HTTP_TRANSPORT_BODY_ENCODING)
			?.value === "latin1"
	);
}

export function createLatin1FetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): HttpTransport {
	return declareLatin1Transport(async (request) => {
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
		const timer = setTimeout(() => controller.abort(), request.timeoutMs);
		try {
			const init: RequestInit = {
				method: request.method,
				headers: { ...request.headers },
				redirect: "manual",
				signal: controller.signal,
			};
			if (request.body !== undefined)
				init.body = Buffer.from(request.body, "latin1");
			const response = await options.fetchImpl(request.url, init);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
			const tooLarge = () =>
				new TransportGuardError(
					"TRANSPORT_BODY_TOO_LARGE",
					`provider response exceeded the ${request.maxResponseBytes} byte cap`,
				);
			const declared = Number(headers["content-length"]);
			if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
				controller.abort();
				throw tooLarge();
			}
			if (response.body === null)
				return { status: response.status, headers, body: "" };
			const chunks: Uint8Array[] = [];
			let size = 0;
			const reader = response.body.getReader();
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					size += next.value.byteLength;
					if (size > request.maxResponseBytes) {
						controller.abort();
						throw tooLarge();
					}
					chunks.push(next.value);
				}
			} finally {
				reader.releaseLock();
			}
			return {
				status: response.status,
				headers,
				body: Buffer.concat(chunks).toString("latin1"),
			};
		} catch (error) {
			if (controller.signal.aborted && !(error instanceof TransportGuardError))
				throw new TransportGuardError(
					"TRANSPORT_TIMEOUT_EXCEEDED",
					"provider request exceeded its total deadline; its external outcome remains unknown",
				);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	});
}

function nonAscii(text: string): boolean {
	for (let index = 0; index < text.length; index++)
		if (text.charCodeAt(index) > 0x7f) return true;
	return false;
}

export function ociLatin1Transport(
	host: HttpTransport,
	options: { readonly fetchImpl?: typeof globalThis.fetch } = {},
): HttpTransport {
	if (isLatin1Transport(host)) return host;
	let bytes: HttpTransport | undefined;
	return declareLatin1Transport(async (request) => {
		if (request.body !== undefined && nonAscii(request.body)) {
			bytes ??= createLatin1FetchTransport({
				fetchImpl: options.fetchImpl ?? globalThis.fetch,
			});
			return bytes(request);
		}
		const response: TransportResponse = await host(request);
		return nonAscii(response.body)
			? {
					...response,
					body: Buffer.from(response.body, "utf8").toString("latin1"),
				}
			: response;
	});
}
