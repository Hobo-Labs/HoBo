// One outbound call: bounded time and size, status mapped to typed failures.
// Credentials arrive per call from the CredentialResolver and are placed in
// headers only; they are never logged, recorded or returned.

import type { CredentialResolver } from "@hobo/cd";
import type {
	HttpTransport,
	TransportMethod,
	TransportResponse,
} from "@hobo/core";
import { GitopsError } from "./errors.js";

export const CALL_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 4_194_304;

export type Call = Readonly<{
	method: TransportMethod;
	url: string;
	headers?: Readonly<Record<string, string>>;
	body?: string;
}>;

/** Send a call; transport failures become `gitops-host-unavailable`. */
export async function send(
	http: HttpTransport,
	call: Call,
): Promise<TransportResponse> {
	try {
		return await http({
			method: call.method,
			url: call.url,
			headers: { accept: "application/json", ...call.headers },
			...(call.body !== undefined ? { body: call.body } : undefined),
			timeoutMs: CALL_TIMEOUT_MS,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		});
	} catch (error) {
		throw new GitopsError(
			"gitops-host-unavailable",
			`${call.method} ${new URL(call.url).pathname}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Map a non-2xx Git host status to its typed failure. */
export function hostFailure(
	response: TransportResponse,
	what: string,
): GitopsError {
	const { status } = response;
	if (status === 401 || status === 403)
		return new GitopsError(
			"gitops-host-auth-failed",
			`${what}: HTTP ${status}`,
			status,
		);
	if (status === 404)
		return new GitopsError(
			"gitops-host-not-found",
			`${what}: HTTP 404`,
			status,
		);
	if (status === 409 || status === 412 || status === 422) {
		return new GitopsError(
			"gitops-host-conflict",
			`${what}: HTTP ${status}`,
			status,
		);
	}
	if (status === 429 || status >= 500)
		return new GitopsError(
			"gitops-host-unavailable",
			`${what}: HTTP ${status}`,
			status,
		);
	return new GitopsError(
		"gitops-host-response-invalid",
		`${what}: HTTP ${status}`,
		status,
	);
}

export function ok(response: TransportResponse): boolean {
	return response.status >= 200 && response.status < 300;
}

export function parseJson(
	response: TransportResponse,
	what: string,
): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(response.body);
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			// SAFETY: checked to be a non-array object above.
			return value as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	throw new GitopsError(
		"gitops-host-response-invalid",
		`${what}: body is not a JSON object`,
	);
}

/** Read a string at a dotted path of a parsed JSON object. */
export function pick(value: unknown, path: string): string | undefined {
	let cursor: unknown = value;
	for (const key of path.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		// SAFETY: walking a parsed JSON object.
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return typeof cursor === "string" ? cursor : undefined;
}

/** Resolve the `token` behind a credential reference for one scoped use. */
export async function token(
	credentials: CredentialResolver,
	ref: string,
	scope: string,
): Promise<string> {
	const resolved = await credentials.resolve(ref, scope);
	const value = resolved.token;
	if (value === undefined || value === "") {
		throw new GitopsError(
			"gitops-credential-missing",
			`credential ${ref} has no token`,
		);
	}
	return value;
}

export function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
