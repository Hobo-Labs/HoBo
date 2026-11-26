/**
 * Offline `start-redis` fixtures.
 *
 * The markdown files beside this one capture the real response *shape* with
 * every credential replaced by an obviously fake `FAKE-` string. The transport
 * is a pure function from request to canned response, so the whole
 * provisioning flow runs without touching upstash.com.
 *
 * The fake token is deliberately under 40 characters with a hyphen in it, so
 * that a fixture leaking into a receipt would still be caught by the
 * credential scanner rather than passing because the value happens to be
 * short.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SecretCustodyPort } from "../../src/custody.js";
import {
	type ProviderErrorCode,
	UpstashProviderError,
} from "../../src/errors.js";
import type {
	TransportRequest,
	TransportResponse,
	UpstashTransport,
} from "../../src/transport.js";

function load(name: string): string {
	return readFileSync(
		fileURLToPath(new URL(`./${name}`, import.meta.url)),
		"utf8",
	);
}

export const VALID_PAYLOAD = load("start-redis-valid.md");
export const MISSING_TOKEN_PAYLOAD = load("start-redis-missing-token.md");
export const EXTRA_FIELD_PAYLOAD = load("start-redis-extra-field.md");
export const DUPLICATE_TOKEN_PAYLOAD = load("start-redis-duplicate-token.md");

/** The same document, padded past the byte ceiling. */
export const OVERSIZED_PAYLOAD = `${VALID_PAYLOAD}\n${"padding ".repeat(3_000)}`;

export const FAKE_DATABASE_ID = "fa1cefa1-ce00-4000-8000-000000000001";
export const FAKE_REST_TOKEN = "FAKE-upstash-rest-token-DO-NOT-USE-0000";
export const FAKE_REST_HOST = "fake-mallard-000000.upstash.io";
export const FAKE_REST_URL = `https://${FAKE_REST_HOST}`;
export const FAKE_CONSOLE_URL = `https://upstash.com/start-redis/console/${FAKE_DATABASE_ID}`;
export const FAKE_METRICS_URL = `https://upstash.com/start-redis/metrics/${FAKE_DATABASE_ID}`;

/** `2026-08-11T00:00:00.000Z`, the instant the valid fixture expires. */
export const FIXTURE_EXPIRES_AT_MS = Date.parse("2026-08-11T00:00:00.000Z");

/** Creation instant implied by the fixture's "3 days from creation". */
export const FIXTURE_CREATED_AT_MS = Date.parse("2026-08-08T00:00:00.000Z");

export type StubResponse = {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
};

export type StubTransport = UpstashTransport & {
	readonly requests: readonly TransportRequest[];
};

/**
 * A transport that replays a scripted sequence of responses.
 *
 * A queue rather than a single response, because the interesting cases here
 * are all sequences: a 500 then a success, a create then an adoption. The last
 * entry repeats once the script runs out, so a test that only cares about the
 * steady state can supply one entry.
 */
export function expectUpstashCode(
	run: () => void,
	code: ProviderErrorCode,
): UpstashProviderError {
	try {
		run();
	} catch (error) {
		if (error instanceof UpstashProviderError && error.code === code) {
			return error;
		}
		throw error;
	}
	throw new Error(`expected UpstashProviderError ${code}`);
}

export async function rejectUpstashCode(
	run: () => Promise<object | undefined>,
	code: ProviderErrorCode,
): Promise<UpstashProviderError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof UpstashProviderError && error.code === code) {
			return error;
		}
		throw error;
	}
	throw new Error(`expected UpstashProviderError ${code}`);
}

export function createStubTransport(options: {
	readonly script?: readonly StubResponse[];
	readonly throws?: readonly Error[];
}): StubTransport {
	const requests: TransportRequest[] = [];
	const script = options.script ?? [{ status: 200, body: VALID_PAYLOAD }];
	let call = 0;

	return {
		requests,
		async request(request: TransportRequest): Promise<TransportResponse> {
			requests.push(request);
			const index = call;
			call += 1;

			const thrown = options.throws?.[index];
			if (thrown !== undefined) throw thrown;

			const stub = script[Math.min(index, script.length - 1)] ?? {
				status: 200,
				body: VALID_PAYLOAD,
			};
			return {
				status: stub.status,
				headers: stub.headers ?? { "content-type": "text/markdown" },
				body: stub.body ?? (stub.status === 200 ? VALID_PAYLOAD : ""),
			};
		},
	};
}

/**
 * An in-memory secret custody port.
 *
 * `deposit` returns a locator and keeps the material in a private map, which
 * is what lets a test assert both halves of the custody contract: that the
 * driver emitted only refs, and that the ref resolves to the token the
 * provider actually sent.
 */
export function createStubCustody(): SecretCustodyPort & {
	readonly deposited: ReadonlyMap<string, string>;
} {
	const deposited = new Map<string, string>();
	let counter = 0;
	return {
		deposited,
		async deposit(value, scope) {
			counter += 1;
			const ref = `hobo-secret://upstash/${scope.purpose}-${counter}`;
			deposited.set(ref, value);
			return ref;
		},
	};
}
