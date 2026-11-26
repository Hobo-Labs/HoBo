/**
 * Fixtures for the remote broker client tests: a discovery document and a
 * credential that satisfy their declared types, a discovery client, and a
 * fetch that answers from a script with real `Response` objects.
 */
import {
	BROKER_DISCOVERY_SCHEMA,
	type BrokerDiscoveryClient,
	type BrokerDiscoveryDocument,
} from "../../src/broker-discovery.js";
import { createRemoteBrokerClient } from "../../src/broker-remote-client.js";
import type { PresentedCredential } from "../../src/credential-presenter.js";
import type { JsonObject, JsonValue } from "../../src/json.js";

export const BROKER = "https://broker.example";

export const DISCOVERY: BrokerDiscoveryDocument = {
	schemaVersion: BROKER_DISCOVERY_SCHEMA,
	brokerId: "broker-1",
	issuer: BROKER,
	authMethods: ["svid"],
	supportsAnonymous: true,
	anonymousSessionEndpoint: "/v1/anonymous-session",
	placeEndpoint: "/v1/place",
	claimEndpoint: "/v1/claim",
};

export const CREDENTIAL: PresentedCredential = {
	scheme: "bearer-session",
	principal: { id: "user-1", kind: "user" },
	tenant: "acme",
	accessToken: "tok-1",
	audience: BROKER,
	expiresAt: "2026-01-01T00:00:00.000Z",
};

/** A discovery client answering with a fixed document. */
export function discoveryFor(document: BrokerDiscoveryDocument = DISCOVERY) {
	let calls = 0;
	const client: BrokerDiscoveryClient = {
		async discover() {
			calls += 1;
			return document;
		},
	};
	return {
		client,
		get calls() {
			return calls;
		},
	};
}

/** One scripted broker answer: its status (200) and its JSON body (`{}`). */
export interface ScriptedAnswer {
	readonly status?: number;
	/** `undefined` is a body no wire can carry, handed to the parser as-is. */
	readonly json?: JsonValue | undefined;
	/** Answer with a body that is not JSON, as a gateway's error page is. */
	readonly jsonThrows?: boolean;
}

/** A real `Response` whose `json()` yields the scripted value unchanged. */
export class ScriptedResponse extends Response {
	readonly #answer: ScriptedAnswer;

	constructor(answer: ScriptedAnswer) {
		super(null, { status: answer.status ?? 200 });
		this.#answer = answer;
	}

	override async json(): Promise<JsonValue | undefined> {
		if (this.#answer.jsonThrows) throw new SyntaxError("not json");
		// `Object.hasOwn`, not `?? {}` — a deliberate `null` payload has to
		// reach the parser as null so its own refusal is what fires.
		return Object.hasOwn(this.#answer, "json") ? this.#answer.json : {};
	}
}

/** A fetch stand-in recording requests and answering from a queue. */
export function fetchStub(responses: readonly ScriptedAnswer[]) {
	const seen: Array<{ url: string; init: RequestInit }> = [];
	let index = 0;
	const impl: typeof fetch = async (url, init = {}) => {
		seen.push({ url: String(url), init });
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		return new ScriptedResponse(next ?? {});
	};
	return { impl, seen };
}

/** The payload with one field left out, as a broker that forgot it sends it. */
export function without(payload: JsonObject, field: string): JsonObject {
	return Object.fromEntries(
		Object.entries(payload).filter(([key]) => key !== field),
	);
}

/** The payload with one field replaced, or left out when the value is `undefined`. */
export function withField(
	payload: JsonObject,
	field: string,
	value: JsonValue | undefined,
): JsonObject {
	return value === undefined
		? without(payload, field)
		: { ...payload, [field]: value };
}

/** Whether a recorded request carried this header, in any casing. */
export function sentHeader(
	init: RequestInit | undefined,
	name: string,
): boolean {
	return new Headers(init?.headers).has(name);
}

export const SESSION_PAYLOAD = {
	// `user`, not `ephemeral`: PrincipalKind is user|agent|service|system, and
	// `principalFrom` refuses anything else, so an "ephemeral" kind makes every
	// session in this file unparseable. The mock lane models anonymous sessions
	// the same way -- a user principal whose id is `anonymous:<deploymentId>`.
	ephemeralPrincipal: { id: "anon-1", kind: "user" },
	accessToken: "at-1",
	claimToken: "ct-1",
	claimUrl: "https://broker.example/claim/ct-1",
	primaryUrl: "https://app.example",
	expiresAt: "2026-01-01T00:00:00.000Z",
	deploymentId: "dep-1",
};

export const PLACE_PAYLOAD = {
	deploymentId: "dep-1",
	primaryUrl: "https://app.example",
	brokerId: "broker-1",
};

export const CLAIM_PAYLOAD = {
	deploymentId: "dep-1",
	owner: { id: "user-1", kind: "user" },
	primaryUrl: "https://app.example",
};

export function client(
	responses: readonly ScriptedAnswer[] = [],
	document: BrokerDiscoveryDocument = DISCOVERY,
) {
	const discovery = discoveryFor(document);
	const fetched = fetchStub(responses);
	return {
		client: createRemoteBrokerClient({
			brokerUri: BROKER,
			discovery: discovery.client,
			fetchImpl: fetched.impl,
		}),
		discovery,
		seen: fetched.seen,
	};
}
