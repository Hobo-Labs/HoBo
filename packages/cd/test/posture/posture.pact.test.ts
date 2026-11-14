// Provider verification of the posture boundaries against the consumer pact
// beside it: CampPolicy (promotion), ShadowRecorder and conflicts (the gate),
// PostureSeriesReader (the HOBO_POSTURE health source) and observeFields (the
// desired-state feed). Digests in the pact are short aliases
// (`sha256:aaaa` = sha256 of 64 `a`s).
import { readFileSync } from "node:fs";
import { create, toJson } from "@bufbuild/protobuf";
import type { PolicyPack } from "@hobo/contracts";
import type { JsonObject, JsonValue } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	FreightQualifiedRecordSchema,
	PipelineRecordSchema,
	PolicyBindingRecordSchema,
	PolicyMode,
	PostureFindingRecordSchema,
	RemediationMode,
	ShadowDecisionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type { Digest } from "../../src/ports.js";
import { createShadowRecorder } from "../../src/posture/index.js";
import { isJsonObject } from "../../src/posture/journal.js";
import {
	camp,
	digest,
	observe,
	promotion,
	railDelivery,
	railFreight,
	resolvedSet,
	T0,
} from "./fakes.js";
import { type PostureHarness, postureHarness } from "./harness.js";

type Interaction = {
	description: string;
	request: { method: string; body: JsonObject };
	response: {
		body: JsonObject;
		matchingRules?: Record<string, { match: string; regex: string }>;
	};
};

const pact: { interactions: Interaction[] } = JSON.parse(
	readFileSync(new URL("./posture.pact.json", import.meta.url), "utf8"),
);
const PROD = camp("prod-1");

function interaction(description: string): Interaction {
	const found = pact.interactions.find((i) => i.description === description);
	if (!found) throw new Error(`no interaction ${description}`);
	return found;
}

/** Real digests → pact aliases, so observed bodies compare with the pact. */
function alias<T>(value: T): JsonValue {
	return JSON.parse(
		JSON.stringify(value ?? null).replace(
			/sha256:([0-9a-f])\1{63}/gu,
			(_m, c: string) => `sha256:${c.repeat(4)}`,
		),
	);
}

function real(aliasDigest: string): Digest {
	const match = /^sha256:([0-9a-f])\1{3}$/u.exec(aliasDigest);
	if (!match?.[1]) throw new Error(`not an alias: ${aliasDigest}`);
	return digest(match[1]);
}

function verify<T>(i: Interaction, value: T): void {
	const observed = alias(value);
	const rules = i.response.matchingRules ?? {};
	const expected = structuredClone(i.response.body);
	for (const [path, rule] of Object.entries(rules)) {
		const keys = path.replace(/^\$\.body\./u, "").split(".");
		let cursor: JsonValue | undefined = observed;
		for (const key of keys)
			cursor = isJsonObject(cursor) ? cursor[key] : undefined;
		expect(String(cursor)).toMatch(new RegExp(rule.regex, "u"));
	}
	expect(observed).toMatchObject(expected);
}

const PACKS = new Map<string, PolicyPack>([
	[digest("b"), { id: "rail-new", version: "2", rules: [] }],
]);

async function qualify(h: PostureHarness, freightId: string) {
	const pipeline = create(PipelineRecordSchema, {
		name: "rail-eu",
		nodes: [{ name: "shadow", campIds: [PROD], policyMode: PolicyMode.INFORM }],
	});
	// SAFETY: toJson of a message is a JSON object.
	await h.store.put(
		CD_STREAMS.pipeline("rail-eu"),
		CD_EVENTS.PipelineApplied,
		toJson(PipelineRecordSchema, pipeline) as JsonObject,
	);
	const qualified = create(FreightQualifiedRecordSchema, {
		freightId,
		campId: PROD,
		pipeline: "rail-eu",
		node: "shadow",
		verificationId: "v",
		qualifiedAt: new Date(T0).toISOString(),
	});
	// SAFETY: toJson of a message is a JSON object.
	await h.store.put(
		CD_STREAMS.freight(freightId),
		CD_EVENTS.FreightQualified,
		toJson(FreightQualifiedRecordSchema, qualified) as JsonObject,
	);
}

describe("posture provider verification (PACT)", () => {
	it("BIND INFORM", async () => {
		const i = interaction(
			"promotion binds a Rail in INFORM and the candidate is set",
		);
		const h = postureHarness();
		const out = await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(real(String(i.request.body.railDigest))),
				mode: PolicyMode.INFORM,
				promotionId: promotion(String(i.request.body.promotionId)),
			},
			h.ctx(),
		);
		if (!out.ok) throw new Error("refused");
		verify(i, {
			ok: true,
			record: toJson(PolicyBindingRecordSchema, out.value),
			events: h.store.events(CD_STREAMS.campSpec(PROD)).map((e) => e.type),
			stream: CD_STREAMS.campSpec(PROD),
		});
	});

	it("BIND ENFORCE without INFORM", async () => {
		const i = interaction(
			"promotion binds a Rail in ENFORCE without a qualified INFORM node and is refused",
		);
		const h = postureHarness();
		const out = await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(real(String(i.request.body.railDigest))),
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p2"),
			},
			h.ctx(),
		);
		if (out.ok) throw new Error("accepted");
		verify(i, {
			ok: false,
			code: out.reasons[0]?.code,
			hasRemediation: (out.reasons[0]?.remediation ?? "") !== "",
		});
	});

	it("RESTORE", async () => {
		const i = interaction(
			"promotion rolls an ENFORCE binding back to the previous digest",
		);
		const h = postureHarness();
		const a = railFreight(digest("a"), `sha256:${"1".repeat(64)}`);
		const b = railFreight(digest("b"), `sha256:${"2".repeat(64)}`);
		await qualify(h, a.freightId);
		await qualify(h, b.freightId);
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: a,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p0"),
			},
			h.ctx(),
		);
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: b,
				mode: PolicyMode.ENFORCE,
				promotionId: promotion("p3"),
			},
			h.ctx(),
		);
		const out = await h.campPolicy.restore(
			{ campId: PROD, promotionId: promotion("p3") },
			h.ctx(),
		);
		if (!out.ok) throw new Error("refused");
		verify(i, {
			ok: true,
			record: toJson(PolicyBindingRecordSchema, out.value),
		});
	});

	it("SHADOW_CANDIDATE and SHADOW_RECORD", async () => {
		const h = postureHarness();
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(digest("b")),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx(),
		);
		const shadow = createShadowRecorder({
			...h.deps,
			resolvePack: async (d) =>
				PACKS.get(d) ?? { id: "none", version: "0", rules: [] },
		});
		const candidate = await shadow.candidate(PROD);
		verify(
			interaction(
				"the gate asks for the candidate Rail while the Camp is bound INFORM",
			),
			{
				railDigest: candidate?.railDigest,
				policyPack: candidate?.policyPack.id,
			},
		);
		const i = interaction("the gate records a diverged shadow decision");
		await shadow.record(
			create(ShadowDecisionRecordSchema, {
				campId: PROD,
				deltaId: String(i.request.body.deltaId),
				enforcedRailDigest: digest("a"),
				candidateRailDigest: digest("b"),
				enforcedEffect: String(i.request.body.enforcedEffect),
				candidateEffect: String(i.request.body.candidateEffect),
				decidedAt: new Date(T0).toISOString(),
			}),
			h.ctx(),
		);
		const events = h.store.events(CD_STREAMS.compliance(PROD));
		verify(i, {
			events: events.map((e) => e.type),
			stream: CD_STREAMS.compliance(PROD),
			record: events[0]?.data,
		});
	});

	it("CONFLICTS", async () => {
		const i = interaction("the gate reads open ownership conflicts");
		const h = postureHarness();
		h.inventory.add(PROD);
		h.rails.byCamp.set(
			PROD,
			railDelivery(digest("a"), [
				{ pack: "tls-baseline", remediation: RemediationMode.ENFORCE },
			]),
		);
		h.desired.seed(
			PROD,
			resolvedSet(PROD, [
				{ name: "api", parameters: { tls: { min_version: "1.0" } } },
			]),
		);
		await observe(h.store, PROD, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.0" },
			},
		]);
		await h.service.tick(h.ctx());
		const conflicts = (await h.service.conflicts(PROD)).map((f) =>
			toJson(PostureFindingRecordSchema, f),
		);
		verify(i, { conflicts });
	});

	it("SERIES", async () => {
		const i = interaction(
			"the HOBO_POSTURE health source reads the noncompliant-ratio and divergence series",
		);
		const h = postureHarness();
		h.inventory.add(PROD);
		h.rails.byCamp.set(
			PROD,
			railDelivery(digest("a"), [
				{ pack: "tls-baseline", remediation: RemediationMode.INFORM },
			]),
		);
		h.rails.byDigest.set(
			digest("b"),
			railDelivery(digest("b"), [
				{ pack: "tls-strict", remediation: RemediationMode.INFORM },
			]),
		);
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(digest("b")),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx(),
		);
		await observe(h.store, PROD, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.3" },
			},
		]);
		await h.service.tick(h.ctx());
		const shadow = createShadowRecorder({
			...h.deps,
			resolvePack: async () => ({ id: "p", version: "1", rules: [] }),
		});
		await shadow.record(
			create(ShadowDecisionRecordSchema, {
				campId: PROD,
				deltaId: "d1",
				candidateRailDigest: digest("b"),
				enforcedEffect: "allow",
				candidateEffect: "deny",
				decidedAt: new Date(T0 + 1).toISOString(),
			}),
			h.ctx(),
		);
		const railDigest = real(String(i.request.body.railDigest));
		const window = { campId: PROD, railDigest, fromMs: T0, toMs: T0 + 60_000 };
		verify(i, {
			noncompliantRatio: await h.service.noncompliantRatio(window),
			shadowDivergence: await h.service.shadowDivergence(window),
			emptyWindow: await h.service.shadowDivergence({
				...window,
				fromMs: T0 + 120_000,
				toMs: T0 + 180_000,
			}),
		});
	});

	it("OBSERVE_FIELDS", async () => {
		const i = interaction(
			"the desired-state feed asks which attributes reconcilers must report",
		);
		const h = postureHarness();
		h.rails.byCamp.set(
			PROD,
			railDelivery(digest("a"), [
				{ pack: "tls-baseline", remediation: RemediationMode.ENFORCE },
			]),
		);
		h.rails.byDigest.set(
			digest("b"),
			railDelivery(digest("b"), [
				{ pack: "tls-strict", remediation: RemediationMode.INFORM },
			]),
		);
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(digest("b")),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx(),
		);
		verify(i, { observeFields: await h.service.observeFields(PROD) });
	});
});
