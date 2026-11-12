// data-models/pipelines.cue and the parse boundary agree: what the controller
// records vets clean, and the single-record rules the parser refuses, CUE
// refuses too.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import type { PipelineRecord } from "../../src/_generated/cd_pb.js";
import {
	AutoPromotion,
	FreightAvailabilityRecordSchema,
	FreightSubject,
	PipelineRecordSchema,
	PolicyMode,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { normalizePipeline } from "../../src/pipelines/index.js";
import { jsonOf } from "../../src/windows/journal.js";
import { cue, vets } from "./cue.js";
import { T0 } from "./fakes.js";
import { harness, node, pipeline } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/pipelines.cue");
/** The recorded form: subject explicit, as normalizePipeline writes it. */
const json = (record: PipelineRecord) =>
	toJson(PipelineRecordSchema, normalizePipeline(record, "user:ops@acme"));

describe.skipIf(cue === undefined)(
	"pipelines.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets what the controller records: pipeline.Applied and pipeline.FreightAvailable bodies", async () => {
			const h = harness();
			await h.source("images");
			h.placement.add("fleet");
			const applied = await h.controller.apply(
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						autoPromotion: AutoPromotion.NEWEST,
						stagePercents: [5, 25, 50, 100],
					}),
					node("fleet", {
						placement: "fleet",
						fromNodes: ["dev"],
						fanout: { maxFailuresPercent: 5 },
						quorum: { minQualifiedPercent: 95 },
					}),
				]),
				h.ctx,
			);
			expect(applied.ok).toBe(true);
			h.ledger.add("f1", T0);
			await h.controller.tick(h.ctx);
			for (const event of h.store.events(CD_EVENTS.PipelineApplied))
				expect(vets(schema, "#Pipeline", jsonOf(event.data) ?? null)).toBe(
					true,
				);
			const facts = h.store.events(CD_EVENTS.PipelineFreightAvailable);
			expect(facts.length).toBeGreaterThan(0);
			for (const event of facts)
				expect(
					vets(
						schema,
						"#FreightAvailabilityRecord",
						jsonOf(event.data) ?? null,
					),
				).toBe(true);
			const rail = await h.controller.apply(
				pipeline(
					"baseline",
					[
						node("shadow", {
							campIds: ["dev-1"],
							fromSources: ["images"],
							policyMode: PolicyMode.INFORM,
						}),
					],
					{ bindle: "rail-baseline", subject: FreightSubject.RAIL },
				),
				h.ctx,
			);
			expect(rail.ok).toBe(true);
			if (rail.ok)
				expect(vets(schema, "#Pipeline", json(rail.value))).toBe(true);
			const available = await h.controller.available({
				pipeline: "shop",
				node: "dev",
			});
			for (const record of available)
				expect(
					vets(
						schema,
						"#FreightAvailabilityRecord",
						toJson(FreightAvailabilityRecordSchema, record),
					),
				).toBe(true);
		});

		it("refuses what the parser refuses for a single record", async () => {
			const h = harness();
			await h.source("images");
			h.placement.add("fleet");
			const cases: PipelineRecord[] = [
				pipeline("Bad Name", [
					node("dev", { campIds: ["dev-1"], fromSources: ["images"] }),
				]),
				pipeline("shop", []),
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						placement: "fleet",
						fromSources: ["images"],
					}),
				]),
				pipeline("shop", [node("dev", { fromSources: ["images"] })]),
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						fanout: {},
					}),
				]),
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						policyMode: PolicyMode.INFORM,
					}),
				]),
				pipeline(
					"shop",
					[node("dev", { campIds: ["dev-1"], fromSources: ["images"] })],
					{ subject: FreightSubject.RAIL },
				),
				pipeline("shop", [
					node("dev", {
						placement: "fleet",
						fromSources: ["images"],
						fanout: { maxFailuresPercent: 101 },
					}),
				]),
				pipeline("shop", [
					node("dev", {
						placement: "fleet",
						fromSources: ["images"],
						previewTtlMs: 60_000n,
					}),
				]),
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						stagePercents: [0, 100],
					}),
				]),
			];
			for (const record of cases) {
				const parsed = await h.controller.apply(record, h.ctx);
				expect(parsed.ok, JSON.stringify(json(record))).toBe(false);
				expect(
					vets(schema, "#Pipeline", json(record)),
					JSON.stringify(json(record)),
				).toBe(false);
			}
		});
	},
);
