// PipelineController.apply (D4, D21, D24): graph validation at the parse
// boundary, governance, one pipeline per Bindle, idempotent re-apply.
import { describe, expect, it } from "vitest";
import {
	AutoPromotion,
	Availability,
	CampManagement,
	FreightSubject,
	HookKind,
	HookPoint,
	PolicyMode,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, SHADOW_REQUIRED } from "../../src/events.js";
import { PIPELINE_METRIC, PIPELINE_REASON } from "../../src/pipelines/index.js";
import { AGENT, context } from "./fakes.js";
import { harness, node, pipeline } from "./harness.js";

async function refusalCodes(h: ReturnType<typeof harness>, record: Parameters<typeof h.controller.apply>[0]): Promise<string[]> {
	const result = await h.controller.apply(record, h.ctx);
	if (result.ok) return [];
	expect(result.reasons.every((r) => r.remediation !== "")).toBe(true);
	return result.reasons.map((r) => r.code);
}

function linear() {
	return pipeline("shop", [
		node("dev", { campIds: ["dev-1"], fromSources: ["images"], autoPromotion: AutoPromotion.NEWEST }),
		node("staging", { campIds: ["staging-1", "staging-2"], fromNodes: ["dev"] }),
		node("prod", { campIds: ["prod-1"], fromNodes: ["staging"], availability: Availability.ALL }),
	]);
}

describe("apply", () => {
	it("records pipeline.Applied once, normalized and stamped, and lists it", async () => {
		const h = harness();
		await h.source("images");
		const first = await h.controller.apply(linear(), h.ctx);
		const again = await h.controller.apply(linear(), h.ctx);
		expect(first.ok && again.ok).toBe(true);
		if (first.ok) expect(first.value).toMatchObject({ schemaVersion: "hobo.cd.pipeline/v1", definedBy: "user:ops@acme", subject: FreightSubject.BINDLE });
		expect(h.store.events(CD_EVENTS.PipelineApplied)).toHaveLength(1);
		expect((await h.controller.get("shop"))?.nodes.map((n) => n.name)).toEqual(["dev", "staging", "prod"]);
		expect((await h.controller.list()).map((p) => p.name)).toEqual(["shop"]);
		expect(h.telemetry.named(PIPELINE_METRIC.applied)).toHaveLength(1);
	});

	it("cycles are refused", async () => {
		const h = harness();
		await h.source("images");
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("dev", { campIds: ["dev-1"], fromSources: ["images"], fromNodes: ["prod"] }),
				node("staging", { campIds: ["staging-1"], fromNodes: ["dev"] }),
				node("prod", { campIds: ["prod-1"], fromNodes: ["staging"] }),
			]),
		);
		expect(codes).toContain(PIPELINE_REASON.cycle);
	});

	it("refuses an empty graph, unknown sources and upstreams, and nodes with no source", async () => {
		const h = harness();
		expect(await refusalCodes(h, pipeline("shop", []))).toContain(PIPELINE_REASON.invalid);
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("dev", { campIds: ["dev-1"], fromSources: ["nope"] }),
				node("staging", { campIds: ["staging-1"], fromNodes: ["ghost"] }),
				node("prod", { campIds: ["prod-1"] }),
			]),
		);
		expect(codes).toEqual(expect.arrayContaining([PIPELINE_REASON.unknownSource, PIPELINE_REASON.unknownUpstream, PIPELINE_REASON.noSource]));
	});

	it("accepts origin pseudo-sources for pushed Freight", async () => {
		const h = harness();
		const result = await h.controller.apply(pipeline("shop", [node("dev", { campIds: ["dev-1"], fromSources: ["origin:manifest", "origin:local-build"] })]), h.ctx);
		expect(result.ok).toBe(true);
		expect(await refusalCodes(h, pipeline("shop", [node("dev", { campIds: ["dev-1"], fromSources: ["origin:telepathy"] })]))).toContain(PIPELINE_REASON.unknownSource);
	});

	it("refuses Camps outside the topology, outside the Bindle's project, observe-only, or in two nodes", async () => {
		const h = harness();
		await h.source("images");
		h.topology.add("other-project", { labels: { "hobo.cd/project": "globex" } });
		h.topology.add("brownfield", { management: CampManagement.OBSERVE_ONLY });
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("dev", { campIds: ["dev-1", "missing", "other-project", "brownfield"], fromSources: ["images"] }),
				node("staging", { campIds: ["dev-1"], fromNodes: ["dev"] }),
			]),
		);
		expect(codes).toEqual(expect.arrayContaining([PIPELINE_REASON.unknownCamp, PIPELINE_REASON.campOutsideProject, PIPELINE_REASON.campNotManaged, PIPELINE_REASON.duplicateCamp]));
		h.topology.add("acme-camp", { labels: { "hobo.cd/project": "acme" } });
		expect((await h.controller.apply(pipeline("shop", [node("dev", { campIds: ["acme-camp"], fromSources: ["images"] })]), h.ctx)).ok).toBe(true);
	});

	it("preview nodes are leaves", async () => {
		const h = harness();
		await h.source("images");
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("dev", { campIds: ["dev-1"], fromSources: ["images"] }),
				node("pr", { campIds: ["preview-1"], fromNodes: ["dev"], previewTtlMs: 3_600_000n }),
				node("prod", { campIds: ["prod-1"], fromNodes: ["pr"] }),
			]),
		);
		expect(codes).toContain(PIPELINE_REASON.previewNotLeaf);
	});

	it("Kargo parity: MATCH_UPSTREAM needs exactly one upstream node", async () => {
		const h = harness();
		await h.source("images");
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("a", { campIds: ["dev-1"], fromSources: ["images"] }),
				node("b", { campIds: ["staging-1"], fromSources: ["images"] }),
				node("prod", { campIds: ["prod-1"], fromNodes: ["a", "b"], autoPromotion: AutoPromotion.MATCH_UPSTREAM }),
			]),
		);
		expect(codes).toContain(PIPELINE_REASON.matchUpstream);
	});

	it("validates exactly one of camp_ids or placement per node, and that the placement exists", async () => {
		const h = harness();
		await h.source("images");
		h.placement.add("fleet", ["pilot"]);
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("both", { campIds: ["dev-1"], placement: "fleet", fromSources: ["images"] }),
				node("neither", { fromSources: ["images"] }),
				node("ghost", { placement: "missing", fromSources: ["images"] }),
				node("misgroup", { placement: "fleet", fromSources: ["images"], fanout: { mandatoryGroups: ["canaries"] } }),
				node("listy", { campIds: ["prod-1"], fromSources: ["images"], fanout: {} }),
			]),
		);
		expect(codes.filter((c) => c === PIPELINE_REASON.targets)).toHaveLength(2);
		expect(codes).toEqual(expect.arrayContaining([PIPELINE_REASON.unknownPlacement, PIPELINE_REASON.unknownGroup, PIPELINE_REASON.placedFieldOnList]));
	});

	it("refuses ALL availability over a placed upstream (one unreachable Camp would block forever)", async () => {
		const h = harness();
		await h.source("images");
		h.placement.add("fleet");
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("fleet", { placement: "fleet", fromSources: ["images"] }),
				node("prod", { campIds: ["prod-1"], fromNodes: ["fleet"], availability: Availability.ALL }),
			]),
		);
		expect(codes).toContain(PIPELINE_REASON.availability);
	});

	it("checks stage percents, hooks and window names", async () => {
		const h = harness();
		await h.source("images");
		const codes = await refusalCodes(
			h,
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					stagePercents: [50, 25],
					hooks: [{ kind: HookKind.UNSPECIFIED, point: HookPoint.BEFORE_APPLY, ref: "" }],
					windows: ["Not A Slug"],
				}),
			]),
		);
		expect(codes.filter((c) => c === PIPELINE_REASON.invalid).length).toBeGreaterThanOrEqual(3);
	});

	it("keeps one pipeline per Bindle", async () => {
		const h = harness();
		await h.source("images");
		expect((await h.controller.apply(linear(), h.ctx)).ok).toBe(true);
		const other = linear();
		other.name = "shop-two";
		expect(await refusalCodes(h, other)).toContain(PIPELINE_REASON.bindleTaken);
	});

	it("is governed: denied and proposal-only principals cannot apply", async () => {
		const h = harness();
		await h.source("images");
		const agent = await h.controller.apply(linear(), context(h.c.now, AGENT));
		expect(!agent.ok && agent.reasons[0]?.code).toBe(PIPELINE_REASON.proposalOnly);
		h.authorizer.deny.add("pipeline.apply");
		expect(await refusalCodes(h, linear())).toContain(PIPELINE_REASON.unauthorized);
		expect(h.store.events(CD_EVENTS.PipelineApplied)).toHaveLength(0);
		expect(h.telemetry.named(PIPELINE_METRIC.refused).length).toBeGreaterThan(0);
	});
});

describe("apply: policy delivery (D24)", () => {
	function rail(nodes: Parameters<typeof pipeline>[1]) {
		return pipeline("baseline", nodes, { bindle: "rail-baseline", subject: FreightSubject.RAIL });
	}

	it("policy_mode appears only in RAIL pipelines, and every RAIL node declares one", async () => {
		const h = harness();
		await h.source("images");
		await h.source("rails");
		expect(await refusalCodes(h, pipeline("shop", [node("dev", { campIds: ["dev-1"], fromSources: ["images"], policyMode: PolicyMode.INFORM })]))).toContain(PIPELINE_REASON.policyMode);
		expect(await refusalCodes(h, rail([node("shadow", { campIds: ["dev-1"], fromSources: ["rails"] })]))).toContain(PIPELINE_REASON.policyMode);
	});

	it("ENFORCE without INFORM upstream is refused at apply", async () => {
		const h = harness();
		await h.source("rails");
		expect(await refusalCodes(h, rail([node("enforce", { campIds: ["prod-1"], fromSources: ["rails"], policyMode: PolicyMode.ENFORCE })]))).toContain(SHADOW_REQUIRED);
		expect(
			await refusalCodes(
				h,
				rail([
					node("first", { campIds: ["dev-1"], fromSources: ["rails"], policyMode: PolicyMode.ENFORCE }),
					node("second", { campIds: ["prod-1"], fromNodes: ["first"], policyMode: PolicyMode.ENFORCE }),
				]),
			),
		).toContain(SHADOW_REQUIRED);
		const ok = await h.controller.apply(
			rail([
				node("shadow", { campIds: ["dev-1", "prod-1"], fromSources: ["rails"], policyMode: PolicyMode.INFORM }),
				node("enforce", { campIds: ["staging-1"], fromNodes: ["shadow"], policyMode: PolicyMode.ENFORCE }),
			]),
			h.ctx,
		);
		expect(ok.ok).toBe(true);
	});

	it("lets an INFORM node of a RAIL pipeline include observe-only Camps", async () => {
		const h = harness();
		await h.source("rails");
		h.topology.add("brownfield", { management: CampManagement.OBSERVE_ONLY });
		expect((await h.controller.apply(rail([node("shadow", { campIds: ["brownfield"], fromSources: ["rails"], policyMode: PolicyMode.INFORM })]), h.ctx)).ok).toBe(true);
	});
});
