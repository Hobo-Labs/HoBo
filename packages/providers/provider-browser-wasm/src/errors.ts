/**
 * Stable HoBo error codes for the browser WebAssembly provider.
 *
 * Host text is never interpolated verbatim. The strings available to a page —
 * the document URL, a fetch failure, a host fault message — routinely carry
 * query-string session tokens, and an error message is the one string that
 * reliably reaches a console, a receipt and a bug report.
 */

import { createProviderRedactor } from "@hobo/core/provider-redaction";

export const BROWSER_WASM_ERROR_CODES = [
	/** The document cannot support what the placement asked for. */
	"HOST_UNSUPPORTED",
	/** The origin did not serve the guest bundle. */
	"BUNDLE_UNAVAILABLE",
	/** The bytes are not the bytes the manifest described. */
	"BUNDLE_DIGEST_MISMATCH",
	/** A core module, or something else, where a component was expected. */
	"BUNDLE_NOT_A_COMPONENT",
	"PROVIDER_CONTRACT_CHANGED",
	"PLACEMENT_REJECTED",
	/** Durable storage was asked for and the context has none. */
	"PERSISTENCE_UNAVAILABLE",
	"GUEST_INSTANTIATION_FAILED",
	"CLEANUP_INCOMPLETE",
] as const;

export type BrowserWasmErrorCode = (typeof BROWSER_WASM_ERROR_CODES)[number];

export type BrowserWasmErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type BrowserWasmErrorOptions = {
	readonly retryable?: boolean;
	readonly detail?: BrowserWasmErrorDetail;
	readonly cause?: Error;
};

const hostRedactor = createProviderRedactor();

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so host text cannot forge a console line. The shared redactor
 * (`@hobo/core/provider-redaction`) holds every shape this needs, the window
 * and the cut; a secret in a URL (`?access_token=…`) is its secret-key shape.
 */
export function redactHostText(text: string, maxLength = 256): string {
	return hostRedactor(text, maxLength);
}

export class BrowserWasmProviderError extends Error {
	readonly code: BrowserWasmErrorCode;
	readonly retryable: boolean;
	readonly detail: BrowserWasmErrorDetail;

	constructor(
		code: BrowserWasmErrorCode,
		message: string,
		options: BrowserWasmErrorOptions = {},
	) {
		super(
			redactHostText(message),
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "BrowserWasmProviderError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.detail = Object.freeze({ ...options.detail });
	}
}

export function isBrowserWasmProviderError(
	value: Error,
): value is BrowserWasmProviderError {
	return value instanceof BrowserWasmProviderError;
}

export function contractChanged(
	message: string,
	detail?: BrowserWasmErrorDetail,
): never {
	throw new BrowserWasmProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}
