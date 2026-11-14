// Golden upcaster corpus for the env.* promotion events (append-only).
import { readFileSync } from "node:fs";
import {
	createCorpusBaseline,
	runCanDeployUpcasterGate,
	validateEventBody,
} from "@hobo/events";
import { describe, expect, it } from "vitest";
import { VerificationVerdict } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import {
	PROMOTION_EVENT_CONTRACTS,
	promotionCorpusBaseline,
	toPromotionCorpusBody,
} from "../../src/promotion/index.js";
import { resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { camp, fid, HOUR } from "./store.js";

const fixture = new URL(
	"./fixtures/promotion-corpus-baseline.json",
	import.meta.url,
);
const pinned = JSON.parse(readFileSync(fixture, "utf8"));

const OWNED = [
	CD_EVENTS.EnvPromoteRequested,
	CD_EVENTS.EnvPromoted,
	CD_EVENTS.EnvPromoteRejected,
	CD_EVENTS.EnvPromoteSuperseded,
	CD_EVENTS.EnvPromoteRolledBack,
	CD_EVENTS.EnvCloned,
	CD_EVENTS.EnvExpired,
];

describe("upcaster corpus for env.* promotion events", () => {
	it("has one evolution contract per owned event type", () => {
		expect(PROMOTION_EVENT_CONTRACTS.map((c) => c.type).sort()).toEqual(
			[...OWNED].sort(),
		);
	});

	it.each(
		PROMOTION_EVENT_CONTRACTS.map((c) => [c.type, c] as const),
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
		expect(promotionCorpusBaseline()).toEqual(pinned);
		expect(
			createCorpusBaseline(
				PROMOTION_EVENT_CONTRACTS.flatMap((c) => c.goldenCorpus),
			).entries.length,
		).toBeGreaterThanOrEqual(8);
	});

	it("every env.* body the saga appends validates against the current schema of its type", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.freight.add("f2");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		h.gate.effect = "require-approval";
		await h.service.promote(
			{ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "a" },
			h.ctx(),
		);
		h.gate.effect = "allow";
		await h.service.promote(
			{ freightId: fid("f2"), targets: [camp("dev-1")], idempotencyKey: "b" },
			h.ctx(),
		);
		h.verification.verdictByCamp.set("dev-2", VerificationVerdict.FAIL);
		await h.service.promote(
			{ freightId: fid("f2"), targets: [camp("dev-2")], idempotencyKey: "c" },
			h.ctx(),
		);
		await h.service.rollback(
			{ campId: camp("dev-1"), reason: "x", idempotencyKey: "rb" },
			h.ctx(),
		);
		await h.service.createPreview(
			{
				freightId: fid("f2"),
				sourceCampId: camp("dev-1"),
				ttlMs: HOUR,
				idempotencyKey: "pv",
			},
			h.ctx(),
		);
		h.clock.advance(HOUR);
		await h.service.expirePreviews(h.ctx());
		const seen = new Set<string>();
		for (const { event } of h.store.all) {
			const contract = PROMOTION_EVENT_CONTRACTS.find(
				(c) => c.type === event.type,
			);
			if (!contract) continue;
			const schema = contract.schemas.find(
				(s) => s.version === contract.currentVersion,
			);
			if (!schema) throw new Error("no current schema");
			const validation = validateEventBody(
				schema,
				toPromotionCorpusBody(event.data),
			);
			expect(validation.errors, event.type).toEqual([]);
			seen.add(event.type);
		}
		expect([...seen].sort()).toEqual([...OWNED].sort());
	});
});
