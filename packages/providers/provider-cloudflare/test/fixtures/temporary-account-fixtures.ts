/**
 * Offline fixtures for the Cloudflare temporary-account Yard.
 *
 * Every credential here is obviously fake and prefixed `FAKE-`. Nothing in this
 * file reaches the network: the transport is a pure function from request to a
 * canned response, which is what lets the whole claimable-Yard flow be tested
 * without a Cloudflare account.
 */
import { Buffer } from "node:buffer";
import type {
	TemporaryAccountHttpRequest,
	TemporaryAccountHttpResponse,
	TemporaryAccountTransportPort,
} from "../../src/temporary-account.js";
import type { JsonObject } from "../src/json.js";

export const FAKE_ACCOUNT_ID = "fake0000-0000-4000-8000-cloudflareacct";
export const FAKE_API_TOKEN =
	"FAKE-cf-temporary-api-token-DO-NOT-USE-0000000000";
export const FAKE_CLAIM_TOKEN = "FAKE-CLAIM-TOKEN-0000000000";
export const FAKE_CLAIM_URL = `https://dash.cloudflare.com/claim-preview?claimToken=${FAKE_CLAIM_TOKEN}`;

export const CHALLENGE_URL =
	"https://api.cloudflare.com/client/v4/provisioning/previews/challenge";
export const CREATE_URL =
	"https://api.cloudflare.com/client/v4/provisioning/previews";

/** Deterministic 32-byte seed. Real seeds are random; this one is all sevens. */
export const FAKE_SEED = Buffer.alloc(32, 7).toString("base64url");

export function challengeBody(k = 2, g = 2): string {
	return JSON.stringify({
		success: true,
		result: { challengeToken: "FAKE-CHALLENGE-TOKEN", seed: FAKE_SEED, k, g },
		errors: [],
		messages: [],
	});
}

export function accountBody(options: {
	readonly accountExpiresAtMs: number;
	readonly claimExpiresAtMs: number;
}): string {
	return JSON.stringify({
		success: true,
		result: {
			account: {
				id: FAKE_ACCOUNT_ID,
				name: "fake-temporary-account",
				type: "standard",
				apiToken: FAKE_API_TOKEN,
				tokenId: "FAKE-TOKEN-ID",
				expiresAt: new Date(options.accountExpiresAtMs).toISOString(),
			},
			claim: {
				token: FAKE_CLAIM_TOKEN,
				url: FAKE_CLAIM_URL,
				expiresAt: new Date(options.claimExpiresAtMs).toISOString(),
			},
		},
		errors: [],
		messages: [],
	});
}

export function accountResult(options: {
	readonly accountExpiresAtMs: number;
	readonly claimExpiresAtMs: number;
}): JsonObject {
	return (
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		(JSON.parse(accountBody(options)) as { result: JsonObject }).result
	);
}

export type StubResponse = Partial<TemporaryAccountHttpResponse> & {
	readonly status: number;
};

export type StubTransportOptions = {
	readonly challenge?: StubResponse;
	readonly create?: StubResponse;
	readonly onSend?: (request: TemporaryAccountHttpRequest) => void;
	/** Throw instead of responding, to simulate a lost mutating response. */
	readonly createThrows?: unknown;
};

export function createStubTransport(
	options: StubTransportOptions,
): TemporaryAccountTransportPort & {
	readonly requests: readonly TemporaryAccountHttpRequest[];
} {
	const requests: TemporaryAccountHttpRequest[] = [];
	return {
		requests,
		async send(request) {
			requests.push(request);
			options.onSend?.(request);
			const stub =
				request.url === CHALLENGE_URL ? options.challenge : options.create;
			if (request.url === CREATE_URL && options.createThrows !== undefined) {
				throw options.createThrows;
			}
			if (stub === undefined) {
				throw new Error(`unexpected request to ${request.url}`);
			}
			return {
				status: stub.status,
				headers: stub.headers ?? {},
				body: stub.body ?? "",
				...(stub.truncated !== undefined
					? { truncated: stub.truncated }
					: undefined),
			} satisfies TemporaryAccountHttpResponse;
		},
	};
}

/** Happy-path transport whose lease timestamps come from the caller. */
export function createHappyTransport(options: {
	readonly accountExpiresAtMs: number;
	readonly claimExpiresAtMs: number;
	readonly onSend?: (request: TemporaryAccountHttpRequest) => void;
}): ReturnType<typeof createStubTransport> {
	return createStubTransport({
		challenge: { status: 200, body: challengeBody() },
		create: { status: 200, body: accountBody(options) },
		...(options.onSend !== undefined ? { onSend: options.onSend } : undefined),
	});
}
