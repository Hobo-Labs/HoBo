/**
 * Byte transports for the OCI realizer.
 *
 * Image layers are binary. `HttpTransport` bodies are strings, and the stock
 * `createBoundedFetchTransport` sends a string body as UTF-8 and decodes a
 * response fatally as UTF-8, so a layer cannot cross it intact. A *latin1
 * transport* maps each byte to one code unit (0–255) in both directions; with
 * one, the realizer runs with `transportBodyEncoding: "latin1"` and moves any
 * blob byte for byte.
 *
 * - `createLatin1FetchTransport` is that transport over `fetch`, with the
 *   same bounds as the stock one: no redirect following, a total deadline,
 *   and a streamed response byte cap.
 * - A transport declares itself latin1 with `declareLatin1Transport`; the
 *   declaration is a `Symbol.for` property, so it survives across package
 *   copies (a test's source build and a host's `dist` build agree on it).
 * - `ociLatin1Transport(host)` adapts a host transport for the realizer: a
 *   declared latin1 host is used as is; otherwise every request whose body is
 *   ASCII (manifests, JSON, empty bodies) still goes through the host, with
 *   its UTF-8 response re-expressed as latin1, and only a request whose body
 *   carries bytes the host would re-encode (a binary layer upload) goes
 *   through the latin1 fetch transport. The realizer guards both the same way
 *   (`guardTransport` per registry host, applied on top of this adapter).
 */
import {
	type HttpTransport,
	TransportGuardError,
	type TransportResponse,
} from "@hobo/core";

// public-contract: the cross-package marker a latin1 (byte) transport carries.
export const HTTP_TRANSPORT_BODY_ENCODING = Symbol.for(
	"hobo.http-transport.body-encoding",
);

/** Mark `transport` as carrying bodies as latin1 (one code unit per byte). */
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

/** A latin1 `HttpTransport` over `fetch`, bounded like the stock transport. */
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

/** True when `text` holds a code unit outside ASCII. */
function nonAscii(text: string): boolean {
	for (let index = 0; index < text.length; index++)
		if (text.charCodeAt(index) > 0x7f) return true;
	return false;
}

/**
 * The transport the OCI realizer runs on with `transportBodyEncoding:
 * "latin1"`, built from whatever the host supplied (see the module comment).
 */
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
