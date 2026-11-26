/**
 * Test-only: ProviderStub → Fetch for HTTP clients under PACT mocks.
 */

import {
	createMockProviderFromPact,
	type PactDocument,
	type PactRequest,
	type ProviderStub,
} from "@hobo/contract-harness";
import { isJsonString, type JsonValue } from "../../src/json.js";

export function createPactFetch(pact: PactDocument): typeof fetch {
	return createFetchFromProvider(createMockProviderFromPact(pact));
}

export function createFetchFromProvider(provider: ProviderStub): typeof fetch {
	return async (input, init) => {
		const requestInput = input instanceof Request ? input : undefined;
		const url = new URL(
			isJsonString(input)
				? input
				: input instanceof URL
					? input.toString()
					: (requestInput?.url ?? ""),
		);
		const rawMethod = (
			init?.method ??
			requestInput?.method ??
			"GET"
		).toUpperCase();
		// SAFETY: pact request methods are the HTTP verbs the stub already handles.
		const method = rawMethod as PactRequest["method"];

		let body: JsonValue;
		const rawBody = init?.body;
		if (isJsonString(rawBody) && rawBody.length > 0) {
			const ct =
				headerValue(init?.headers, "content-type") ??
				headerValue(init?.headers, "Content-Type") ??
				"";
			if (
				ct.includes("application/json") ||
				rawBody.trimStart().startsWith("{")
			) {
				try {
					body = JSON.parse(rawBody);
				} catch {
					body = rawBody;
				}
			} else if (ct.includes("application/x-www-form-urlencoded")) {
				body = Object.fromEntries(new URLSearchParams(rawBody).entries());
			} else {
				body = undefined;
			}
		}

		const path = `${url.pathname}${url.search}`;
		const request: PactRequest = {
			method,
			path,
			...(body !== undefined ? { body } : undefined),
		};
		const response = await Promise.resolve(provider.handle(request));
		// SAFETY: assertion required at this I/O or test boundary.
		const headers = new Headers(response.headers as HeadersInit | undefined);
		if (!headers.has("content-type") && response.body !== undefined) {
			headers.set(
				"content-type",
				isJsonString(response.body) && response.body.trimStart().startsWith("<")
					? "text/xml; charset=utf-8"
					: "application/json",
			);
		}
		const payload =
			response.body === undefined
				? ""
				: isJsonString(response.body)
					? response.body
					: JSON.stringify(response.body);
		return new Response(payload, {
			status: response.status,
			headers,
		});
	};
}

function headerValue(
	headers: HeadersInit | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (Array.isArray(headers)) {
		const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
		return hit?.[1];
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const rec = headers as Record<string, string>;
	for (const [k, v] of Object.entries(rec)) {
		if (k.toLowerCase() === name.toLowerCase()) return v;
	}
	return undefined;
}

/**
 * Finds the pact for a provider, or fails the test naming what was missing.
 *
 * The call sites previously spelled this `pacts.find(…)` followed by
 * `expect(pact).toBeDefined()` and then a `!` on every later use. That reads
 * as a narrowing but is not one — the assertion silences the type error while
 * the runtime failure stays a `Cannot read properties of undefined`, several
 * lines from the actual problem. Throwing here narrows for real and says which
 * provider was not found and which ones were.
 */
export function requirePact(
	pacts: readonly PactDocument[],
	providerName: string,
): PactDocument {
	const pact = pacts.find((p) => p.provider.name === providerName);
	if (!pact) {
		const available = pacts.map((p) => p.provider.name).sort();
		throw new Error(
			`no pact for provider "${providerName}"; loaded providers: ${
				available.length > 0 ? available.join(", ") : "(none)"
			}`,
		);
	}
	return pact;
}
