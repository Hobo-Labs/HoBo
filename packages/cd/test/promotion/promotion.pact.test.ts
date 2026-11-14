// Provider verification of the promotion boundaries against the consumer pact
// beside it: PromotionService (pipelines, fan-out, operators), the webhook
// approver (outbound CloudEvent + signed callback) and the NOTIFY hook.
import { readFileSync } from "node:fs";
import { toJson } from "@bufbuild/protobuf";
import type { JsonObject, JsonValue, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	PromotionRecordSchema,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import { createWebhookApprover } from "../../src/adapters/approval.js";
import { createCloudEventsNotifier } from "../../src/adapters/hooks.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	pipelineNode,
	RecordingAuthorizer,
	RecordingTelemetry,
	resolvedFor,
} from "./doubles.js";
import { harness } from "./harness.js";
import {
	camp,
	clock,
	context,
	fid,
	HOUR,
	MemoryEventStore,
	T0,
	TENANT,
} from "./store.js";

type Interaction = {
	description: string;
	request: { method: string; body: JsonObject };
	response: {
		body: JsonObject;
		matchingRules?: Record<string, { match: string; regex: string }>;
	};
};

const pact: { interactions: Interaction[] } = JSON.parse(
	readFileSync(new URL("./promotion.pact.json", import.meta.url), "utf8"),
);

function interaction(description: string): Interaction {
	const found = pact.interactions.find((i) => i.description === description);
	if (!found) throw new Error(`no interaction ${description}`);
	return found;
}

const tag = Object.prototype.toString;
function isObject<T>(value: T): value is T & JsonObject {
	return tag.call(value) === "[object Object]";
}

/** The JSON form of an observed provider response (drops undefined). */
function observed<T>(value: T): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null));
}

/** Every expected leaf is present and equal in actual (arrays compared whole). */
function expectSubset(
	expected: JsonValue,
	actual: JsonValue | undefined,
	path = "$",
): void {
	if (isObject(expected)) {
		expect(isObject(actual), `${path} is an object`).toBe(true);
		const record = isObject(actual) ? actual : {};
		for (const [key, value] of Object.entries(expected))
			expectSubset(value, record[key], `${path}.${key}`);
		return;
	}
	expect(actual, path).toEqual(expected);
}

function expectRules(
	rules: Interaction["response"]["matchingRules"],
	body: JsonValue,
): void {
	for (const [path, rule] of Object.entries(rules ?? {})) {
		const value = path
			.replace(/^\$\.body\./, "")
			.split(".")
			.reduce<JsonValue | undefined>(
				(v, key) => (isObject(v) ? v[key] : undefined),
				body,
			);
		expect(String(value), path).toMatch(new RegExp(rule.regex));
	}
}

function verify<T>(description: string, response: T): void {
	const body = observed(response);
	const expected = interaction(description).response;
	expectSubset(expected.body, body);
	expectRules(expected.matchingRules, body);
}

function provider() {
	const h = harness();
	h.pipelines.define("shop", [
		pipelineNode("staging", { campIds: ["staging-1"] }),
		pipelineNode("prod", { campIds: ["prod-1"], fromNodes: ["staging"] }),
	]);
	h.freight.add("f0");
	h.freight.add("f1");
	h.pipelines.makeAvailable("shop", "staging", "f1");
	h.desired.seed("staging-1", "f0", resolvedFor("staging-1", "alpha", "f0"));
	return h;
}

describe("promotion pact (provider verification)", () => {
	it("PROMOTE: available Freight is promoted", async () => {
		const h = provider();
		const request = interaction(
			"a pipeline requests a promotion of available Freight and it is promoted",
		).request.body;
		const result = await h.service.promote(
			{
				freightId: fid(String(request.freightId)),
				targets: [camp("staging-1")],
				idempotencyKey: String(request.idempotencyKey),
				pipeline: "shop",
				node: "staging",
			},
			h.ctx(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const stream = CD_STREAMS.promotion(result.value.promotionId);
		const events = [
			...new Set(
				h.store
					.stream(stream)
					.map((e) => e.type)
					.filter((t) => !t.startsWith("saga.StepEmitted")),
			),
		];
		verify(
			"a pipeline requests a promotion of available Freight and it is promoted",
			{
				ok: true,
				record: toJson(PromotionRecordSchema, result.value),
				events,
				stream: "cd-promotion-<promotionId>",
			},
		);
	});

	it("PROMOTE: the same request again returns the same promotion", async () => {
		const h = provider();
		const input = {
			freightId: fid("f1"),
			targets: [camp("staging-1")],
			idempotencyKey: "k1",
			pipeline: "shop",
			node: "staging",
		};
		const first = await h.service.promote(input, h.ctx());
		const second = await h.service.promote(input, h.ctx());
		verify("the same request again returns the same promotion", {
			ok: second.ok,
			samePromotion:
				first.ok &&
				second.ok &&
				first.value.promotionId === second.value.promotionId,
			requestEvents: h.store.events(CD_EVENTS.EnvPromoteRequested).length,
		});
	});

	it("PROMOTE: lineage refusal is typed", async () => {
		const h = provider();
		const result = await h.service.promote(
			{
				freightId: fid("f1"),
				targets: [camp("prod-1")],
				idempotencyKey: "k2",
				pipeline: "shop",
				node: "prod",
			},
			h.ctx(),
		);
		verify(
			"Freight that is not available to prod is refused with a typed lineage reason",
			{
				ok: result.ok,
				code: result.ok ? "" : result.reasons[0]?.code,
				hasRemediation:
					!result.ok && (result.reasons[0]?.remediation.length ?? 0) > 0,
			},
		);
	});

	it("ROLLBACK: restores the predecessor Set", async () => {
		const h = provider();
		await h.service.promote(
			{
				freightId: fid("f1"),
				targets: [camp("staging-1")],
				idempotencyKey: "k1",
				pipeline: "shop",
				node: "staging",
			},
			h.ctx(),
		);
		const result = await h.service.rollback(
			{
				campId: camp("staging-1"),
				reason: "error spike",
				idempotencyKey: "rb1",
			},
			h.ctx(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const current = await h.desired.current(camp("staging-1"));
		verify("an operator rolls a Camp back to its predecessor Set", {
			ok: true,
			record: toJson(PromotionRecordSchema, result.value),
			setOrigin:
				SetOrigin[current?.origin ?? 0] === "ROLLBACK"
					? "SET_ORIGIN_ROLLBACK"
					: "other",
			events: h.store
				.stream(CD_STREAMS.promotion(result.value.promotionId))
				.map((e) => e.type),
		});
	});

	function webhook() {
		const c = clock(T0);
		const store = new MemoryEventStore(c.now);
		const sent: TransportRequest[] = [];
		const approver = createWebhookApprover({
			store,
			tenant: TENANT,
			now: c.now,
			http: async (request) => {
				sent.push(request);
				return { status: 202, headers: {}, body: "" };
			},
			endpoint: "https://approvals.example/hooks/hobo",
			callbackUrl: "https://cd.example/v1/cd/approvals/callback",
			source: "hobo://cd/acme",
			secrets: {
				resolver: { resolve: async () => ({ secret: "s3cr3t-hmac-key" }) },
				ref: "vault://cd/approval",
			},
			authorizer: new RecordingAuthorizer(),
			telemetry: new RecordingTelemetry(),
		});
		return { approver, sent, ctx: context(c.now) };
	}

	it("APPROVAL_REQUEST: a CloudEvent with a signed callback", async () => {
		const w = webhook();
		await w.approver.request(
			{
				subject: "promotion:promo_1/prod-1",
				summary: "Promote f1",
				obligations: [],
				expiresAtMs: T0 + HOUR,
			},
			w.ctx,
		);
		const event = JSON.parse(w.sent[0]?.body ?? "{}");
		verify("the webhook approver POSTs a CloudEvent naming a signed callback", {
			headers: w.sent[0]?.headers,
			event,
			data: event.data,
		});
	});

	it("APPROVAL_CALLBACK: approved and forged", async () => {
		const w = webhook();
		await w.approver.request(
			{
				subject: "promotion:promo_1/prod-1",
				summary: "Promote f1",
				obligations: [],
				expiresAtMs: T0 + HOUR,
			},
			w.ctx,
		);
		const token = String(
			JSON.parse(w.sent[0]?.body ?? "{}").data.callback.token,
		);
		const call = async (body: JsonObject) => {
			const response = await w.approver.callback(
				{
					method: "POST",
					path: "/v1/cd/approvals/callback",
					headers: {},
					body: new TextEncoder().encode(JSON.stringify(body)),
				},
				w.ctx,
			);
			return {
				status: response.status,
				result: JSON.parse(
					// SAFETY: test fixture; the value is the shape the port declares.
					new TextDecoder().decode(response.body as Uint8Array),
				),
			};
		};
		const forged = `${token.slice(0, token.lastIndexOf("."))}.${"A".repeat(43)}`;
		verify(
			"a callback with a forged signature is refused",
			await call({ token: forged, decision: "approved", approver: "mallory" }),
		);
		verify(
			"the approver answers on the signed callback",
			await call({ token, decision: "approved", approver: "release-bot" }),
		);
	});

	it("NOTIFY: a structured CloudEvent", async () => {
		const sent: TransportRequest[] = [];
		const notifier = createCloudEventsNotifier({
			http: async (request) => {
				sent.push(request);
				return { status: 200, headers: {}, body: "" };
			},
			endpoint: (channel) =>
				channel === "ops" ? "https://hooks.example/ops" : undefined,
			source: "hobo://cd/acme",
		});
		await notifier.notify(
			{
				channel: "ops",
				subject: "promo_1/prod-1",
				body: { point: "on-failure" },
			},
			context(() => T0),
		);
		verify("a NOTIFY hook is delivered as a structured CloudEvent", {
			headers: sent[0]?.headers,
			event: JSON.parse(sent[0]?.body ?? "{}"),
		});
		await expect(
			notifier.notify(
				{ channel: "nowhere", subject: "x", body: {} },
				context(() => T0),
			),
		).rejects.toThrow(/no endpoint/);
	});
});
