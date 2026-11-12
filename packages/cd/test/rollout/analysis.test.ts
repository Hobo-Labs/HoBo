// PACT consumer verification for the optional analysis-webhook HealthSource
// (pacts/analysis-webhook.pact.json) and its fail-closed behavior (I5): the
// real source runs over a transport that serves each contracted interaction,
// the request must match the contract, and every non-answer is a refusal.
import { create } from "@bufbuild/protobuf";
import type { TransportRequest, TransportResponse } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	Cohort,
	HealthQueryRecordSchema,
	HealthSourceKind,
} from "../../src/_generated/cd_pb.js";
import type { CredentialResolver, HealthSource } from "../../src/ports.js";
import { pointer, withAnalysisWebhooks } from "../../src/rollout/analysis.js";
import { camp, clock, context } from "./fakes.js";
import pact from "./pacts/analysis-webhook.pact.json" with { type: "json" };

const FROM = 1794484800000;
const TO = 1794485400000;

type Interaction = (typeof pact.interactions)[number];

function interaction(description: string): Interaction {
	const found = pact.interactions.find((item) => item.description === description);
	if (!found) throw new Error(`Pact interaction missing: ${description}`);
	return found;
}

function served(contract: Interaction, seen: TransportRequest[]) {
	return async (request: TransportRequest): Promise<TransportResponse> => {
		seen.push(request);
		const url = new URL(request.url);
		expect(request.method).toBe(contract.request.method);
		expect(url.pathname).toBe(contract.request.path);
		const headers = "headers" in contract.request ? contract.request.headers : {};
		for (const [name, value] of Object.entries(headers ?? {})) expect(request.headers[name]).toBe(value);
		if ("body" in contract.request && contract.request.body !== undefined)
			expect(JSON.parse(request.body ?? "null")).toEqual(contract.request.body);
		const body = "body" in contract.response ? JSON.stringify(contract.response.body) : "";
		return { status: contract.response.status, headers: {}, body };
	};
}

const credentials: CredentialResolver = {
	resolve: async (ref) => {
		if (ref !== "gate-credential") throw new Error("unknown credential");
		return { authorization: "Bearer gate-token" };
	},
};

function query(endpointRef: string, q = "", credentialRef = "gate-credential") {
	return create(HealthQueryRecordSchema, {
		name: "checkout-gate",
		source: HealthSourceKind.HTTP_JSON,
		endpointRef,
		query: q,
		credentialRef,
	});
}

function ask(source: HealthSource, endpointRef: string, q = "", credentialRef = "gate-credential") {
	const time = clock();
	return source.query(
		{ query: query(endpointRef, q, credentialRef), campId: camp("prod-a"), cohort: Cohort.CANARY, fromMs: FROM, toMs: TO, signal: new AbortController().signal },
		context(time.now),
	);
}

const GATE = "analysis+status:https://gate.example.com/gate/checkout";
const METRIC = "analysis+metric:https://runs.example.com/runs/42";

describe("withAnalysisWebhooks (PACT)", () => {
	it("status gate: 2xx is one passing sample", async () => {
		const seen: TransportRequest[] = [];
		const source = withAnalysisWebhooks({ http: served(interaction("status gate passes the stage"), seen), credentials });
		const result = await ask(source, GATE);
		expect(result).toEqual({ ok: true, value: { values: [1], fromMs: FROM, toMs: TO } });
		expect(seen).toHaveLength(1);
	});

	it("status gate: 4xx is one failing sample", async () => {
		const source = withAnalysisWebhooks({ http: served(interaction("status gate rejects the stage"), []), credentials });
		expect(await ask(source, GATE)).toEqual({ ok: true, value: { values: [0], fromMs: FROM, toMs: TO } });
	});

	it("status gate down is a refusal (no data, so FAIL) — never a fallback pass", async () => {
		const source = withAnalysisWebhooks({ http: served(interaction("status gate is down"), []), credentials });
		const result = await ask(source, GATE);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]?.code).toBe("analysis-webhook-unavailable");
	});

	it("json metric: the pointer's numeric array becomes the samples", async () => {
		const source = withAnalysisWebhooks({ http: served(interaction("json metric series at a pointer"), []), credentials });
		expect(await ask(source, METRIC, "/metrics/0/measurements")).toEqual({
			ok: true,
			value: { values: [0.01, 0.02, 0.015], fromMs: FROM, toMs: TO },
		});
	});

	it("json metric with no numeric value is a refusal", async () => {
		const source = withAnalysisWebhooks({ http: served(interaction("json metric without a numeric value"), []), credentials });
		const result = await ask(source, METRIC, "/metrics/0/measurements");
		expect(result.ok).toBe(false);
	});
});

describe("withAnalysisWebhooks (boundaries)", () => {
	const never = async (): Promise<TransportResponse> => {
		throw new Error("must not call the network");
	};

	it("delegates every other query to the wrapped source of the same kind", async () => {
		const base: HealthSource = {
			kind: HealthSourceKind.HTTP_JSON,
			query: async () => ({ ok: true, value: { values: [7], fromMs: 1, toMs: 2 } }),
		};
		const source = withAnalysisWebhooks({ http: never, credentials, base });
		expect(source.kind).toBe(HealthSourceKind.HTTP_JSON);
		expect(await ask(source, "https://metrics.example.com/series")).toEqual({ ok: true, value: { values: [7], fromMs: 1, toMs: 2 } });
	});

	it("refuses non-https or credential-in-URL endpoints and unresolvable credentials without calling out", async () => {
		const source = withAnalysisWebhooks({ http: never, credentials });
		for (const ref of ["analysis+status:http://gate.example.com/x", "analysis+metric:https://user:pw@gate.example.com/x", "https://plain.example.com"]) {
			const result = await ask(source, ref);
			expect(result.ok).toBe(false);
		}
		const result = await ask(source, GATE, "", "missing-credential");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]?.message).not.toContain("gate-token");
	});

	it("a transport failure is a refusal", async () => {
		const source = withAnalysisWebhooks({ http: never, credentials });
		const result = await ask(source, METRIC, "/x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]?.code).toBe("analysis-webhook-unavailable");
	});

	it("resolves RFC 6901 pointers", () => {
		const doc = { "a/b": { "m~n": [1, 2] } };
		expect(pointer(doc, "/a~1b/m~0n/1")).toBe(2);
		expect(pointer(doc, "")).toEqual(doc);
		expect(pointer(doc, "nope")).toBeUndefined();
		expect(pointer(doc, "/a~1b/m~0n/9")).toBeUndefined();
	});
});
