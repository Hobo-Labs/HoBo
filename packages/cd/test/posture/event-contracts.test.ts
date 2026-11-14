// Golden upcaster corpus for the policy/posture events (append-only).
import { readFileSync } from "node:fs";
import { runCanDeployUpcasterGate, validateEventBody } from "@hobo/events";
import { describe, expect, it } from "vitest";
import { PolicyMode, RemediationMode } from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS } from "../../src/events.js";
import {
	createShadowRecorder,
	POSTURE_EVENT_CONTRACTS,
	postureCorpusBaseline,
	toPostureCorpusBody,
} from "../../src/posture/index.js";
import {
	camp,
	digest,
	observe,
	promotion,
	railDelivery,
	railFreight,
	resolvedSet,
} from "./fakes.js";
import { postureHarness } from "./harness.js";

const fixture = new URL(
	"./fixtures/posture-corpus-baseline.json",
	import.meta.url,
);
const pinned = JSON.parse(readFileSync(fixture, "utf8"));

const OWNED = [
	CD_EVENTS.PolicyBindingChanged,
	CD_EVENTS.PolicyShadowDecided,
	CD_EVENTS.ComplianceObserved,
	CD_EVENTS.ComplianceChanged,
	CD_EVENTS.PostureRemediationProposed,
];

describe("upcaster corpus for policy/posture events", () => {
	it("has one evolution contract per owned event type", () => {
		expect(POSTURE_EVENT_CONTRACTS.map((c) => c.type).sort()).toEqual(
			[...OWNED].sort(),
		);
	});

	it.each(
		POSTURE_EVENT_CONTRACTS.map((c) => [c.type, c] as const),
	)("%s replays clean through the can-deploy gate", (_type, contract) => {
		const baselineCorpus = {
			...pinned,
			entries: pinned.entries.filter((entry: { key: string }) =>
				entry.key.startsWith(`${contract.type}@`),
			),
		};
		const report = runCanDeployUpcasterGate(contract, { baselineCorpus });
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("the pinned baseline file equals today's corpus (append-only)", () => {
		expect(postureCorpusBaseline()).toEqual(pinned);
	});

	it("every body the posture module appends validates against the current schema of its type", async () => {
		const h = postureHarness();
		const prod = camp("prod-1");
		h.inventory.add(prod);
		h.rails.byCamp.set(
			prod,
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
		h.desired.seed(prod, resolvedSet(prod, [{ name: "api" }]));
		await h.campPolicy.bind(
			{
				campId: prod,
				freight: railFreight(digest("b")),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx(),
		);
		await observe(h.store, prod, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.0" },
			},
		]);
		await h.service.tick(h.ctx());
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await h.service.tick(h.ctx());
		const shadow = createShadowRecorder({
			...h.deps,
			resolvePack: async () => ({ id: "p", version: "1", rules: [] }),
		});
		await shadow.record(
			{
				$typeName: "hobo.cd.v1.ShadowDecisionRecord",
				campId: prod,
				deltaId: "d1",
				enforcedRailDigest: digest("a"),
				candidateRailDigest: digest("b"),
				enforcedEffect: "allow",
				candidateEffect: "deny",
				diverged: true,
				decidedAt: new Date(h.time.now()).toISOString(),
			},
			h.ctx(),
		);
		const seen = new Set<string>();
		for (const { event } of h.store.all) {
			const contract = POSTURE_EVENT_CONTRACTS.find(
				(c) => c.type === event.type,
			);
			if (!contract) continue;
			const schema = contract.schemas.find(
				(s) => s.version === contract.currentVersion,
			);
			if (!schema) throw new Error("no current schema");
			expect(
				validateEventBody(schema, toPostureCorpusBody(event.data)).errors,
				event.type,
			).toEqual([]);
			seen.add(event.type);
		}
		expect([...seen].sort()).toEqual([...OWNED].sort());
	});
});
