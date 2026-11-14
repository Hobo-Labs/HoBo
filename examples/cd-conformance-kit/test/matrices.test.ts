// The toolset and platform matrices and the WP20-owned §10 rows (plan 0024):
//   - "Same Freight via seven ingress paths" → same Freight id
//   - "Air-gapped Yard, egress disabled" → promotes via local source and agent
//   - "Journal replay of a full pipeline run" → identical state
// All run offline: no network, no clock, no credentials.
import {
	CD_INGRESS_PATHS,
	type CdConformanceReport,
	createEgressGuard,
	platformCells,
	runAirgapConformance,
	runJournalReplayConformance,
	runPlatformMatrix,
	runToolsetMatrix,
} from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import {
	type AirgapMutant,
	type PlatformMutant,
	type ReplayMutant,
	refAirgapHarness,
	refPlatformHarness,
	refReplayHarness,
	refToolsetHarness,
	type ToolsetMutant,
} from "../src/index.js";
import { failed, summary } from "./report.js";

describe("toolset matrix", () => {
	it("§10 WP20: the same Freight via seven ingress paths yields one Freight id", async () => {
		const report = await runToolsetMatrix(refToolsetHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.freightIds).sort()).toEqual([...CD_INGRESS_PATHS].sort());
		expect(new Set(Object.values(report.freightIds)).size).toBe(1);
	});
	it.each<[ToolsetMutant, string]>([
		["path-in-id", "sameFreightIdAcrossPaths"],
		["unordered-artifacts", "sameFreightIdAcrossPaths"],
		["trusts-payload", "payloadAloneCreatesNoFreight"],
	])("catches an ingress that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runToolsetMatrix(refToolsetHarness(mutant)))).toContain(assertion);
	});
	it("fails when the harness cannot show a bare CDEvent creating nothing", async () => {
		const { nudgeWithoutEvidence: _omit, ...harness } = refToolsetHarness();
		expect(failed(await runToolsetMatrix(harness))).toEqual(["payloadAloneCreatesNoFreight"]);
	});
});

describe("platform matrix", () => {
	it("delivers one Freight across every traffic rung and none, every artifact kind, built-in and WASM-component resolvers", async () => {
		const report: CdConformanceReport<string> = await runPlatformMatrix(refPlatformHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toHaveLength(platformCells().length);
		expect(platformCells().length).toBe(2 * 7 * 6);
	});
	it.each<[PlatformMutant, string]>([
		["silent-downgrade", "built-in/OCI_IMAGE/none/canary"],
		["rebuilds-vm-images", "wasm-component/VM_IMAGE/edge.canary/canary"],
		["wasm-unsupported", "wasm-component/WASM_COMPONENT/lb.weighted/canary"],
	])("catches a platform that %s (%s)", async (mutant, cell) => {
		expect(failed(await runPlatformMatrix(refPlatformHarness(mutant)))).toContain(cell);
	});
});

describe("§10 WP20: air-gapped Yard, egress disabled", () => {
	it("promotes via a local source and an agent with no egress beyond the Yard", async () => {
		const report = await runAirgapConformance(refAirgapHarness());
		expect(summary(report)).toBe("");
	});
	it.each<[AirgapMutant, string]>([
		["phones-home", "noEgressBeyondTheYard"],
		["station-dials-agent", "stationNeverDialsTheAgent"],
	])("catches a deployment that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runAirgapConformance(refAirgapHarness(mutant)))).toContain(assertion);
	});
	it("the egress guard refuses hosts outside the Yard and records them", async () => {
		const guard = createEgressGuard(["registry.yard.internal"], async () => ({ status: 200, headers: {}, body: "" }));
		await guard.transport({ method: "GET", url: "https://registry.yard.internal/v2/", headers: {}, timeoutMs: 1, maxResponseBytes: 1 });
		await expect(guard.transport({ method: "GET", url: "https://ghcr.io/v2/", headers: {}, timeoutMs: 1, maxResponseBytes: 1 })).rejects.toThrow(/egress to ghcr.io is disabled/);
		expect(guard.allowed()).toEqual(["registry.yard.internal"]);
		expect(guard.refused()).toEqual(["ghcr.io"]);
	});
});

describe("§10 WP20: journal replay of a full pipeline run", () => {
	it("rebuilds identical state from the journal", async () => {
		const report = await runJournalReplayConformance(refReplayHarness());
		expect(summary(report)).toBe("");
	});
	it.each<[ReplayMutant, string]>([
		["unjournaled-state", "replayEqualsLive"],
		["wall-clock", "replayIsStable"],
	])("catches state that is %s (%s)", async (mutant, assertion) => {
		expect(failed(await runJournalReplayConformance(refReplayHarness(mutant)))).toContain(assertion);
	});
});
