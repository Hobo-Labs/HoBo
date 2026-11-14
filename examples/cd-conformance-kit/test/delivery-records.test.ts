// Delivery-as-code suite (`runDeliveryRecordsConformance`): a sound module
// passes; each broken module fails exactly the assertion naming its defect.
import { FreightSubject, PolicyMode, RolloutStrategy } from "@hobo/cd";
import {
	CD_FREIGHT_SUBJECT,
	CD_POLICY_MODE,
	CD_ROLLOUT_STRATEGY,
	type DeliveryModuleLike,
	DELIVERY_RECORDS_ASSERTIONS,
	type PipelineNodeLike,
	runDeliveryRecordsConformance,
} from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import { failed, summary } from "./report.js";

function node(name: string, extra: Partial<PipelineNodeLike> = {}): PipelineNodeLike {
	return { name, campIds: [`camp-${name}`], placement: "", fromNodes: [], fromSources: [], windows: [], strategy: 1, stagePercents: [], policyMode: 0, ...extra };
}

const sound: DeliveryModuleLike = {
	sources: [{ name: "app", subscriptions: [{ name: "oci", requireProvenance: true, trustedBuilderIds: ["https://builder"], trustedSignerIdentities: ["release@ci"] }] }],
	publishers: [{ name: "gh", issuer: "https://token.actions.githubusercontent.com", audience: "hobo.cd", requiredClaims: { repository: "acme/app" } }],
	windows: [{ name: "freeze" }],
	pipelines: [
		{
			name: "app",
			subject: CD_FREIGHT_SUBJECT.BINDLE,
			nodes: [
				node("dev", { fromSources: ["app"] }),
				node("prod", { campIds: [], placement: "fleet", fromNodes: ["dev"], windows: ["freeze"], strategy: CD_ROLLOUT_STRATEGY.CANARY, stagePercents: [5, 25, 50, 100], fanout: { strategy: 3 } }),
			],
		},
		{
			name: "rail",
			subject: CD_FREIGHT_SUBJECT.RAIL,
			nodes: [node("shadow", { fromSources: ["app"], policyMode: CD_POLICY_MODE.INFORM }), node("enforce", { fromNodes: ["shadow"], policyMode: CD_POLICY_MODE.ENFORCE })],
		},
	],
};

const withPipelineNodes = (nodes: readonly PipelineNodeLike[], subject: number = CD_FREIGHT_SUBJECT.BINDLE): DeliveryModuleLike => ({ ...sound, pipelines: [{ name: "broken", subject, nodes }] });

describe("delivery-records conformance", () => {
	it("passes a sound delivery module on every assertion", async () => {
		const report = await runDeliveryRecordsConformance("sound", sound);
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...DELIVERY_RECORDS_ASSERTIONS]);
	});
	it.each<[string, DeliveryModuleLike, string]>([
		["a repeated node name", withPipelineNodes([node("a", { fromSources: ["app"] }), node("a", { fromSources: ["app"] })]), "nodeNamesAreUnique"],
		["an unknown upstream", withPipelineNodes([node("a", { fromNodes: ["ghost"] })]), "upstreamNodesExist"],
		["a cycle", withPipelineNodes([node("a", { fromNodes: ["b"] }), node("b", { fromNodes: ["a"] })]), "graphIsAcyclic"],
		["an unknown source", withPipelineNodes([node("a", { fromSources: ["nope"] })]), "sourcesExist"],
		["a Camp list and a placement", withPipelineNodes([node("a", { fromSources: ["app"], placement: "fleet" })]), "exactlyOneTarget"],
		["a fan-out over a Camp list", withPipelineNodes([node("a", { fromSources: ["app"], fanout: { strategy: 1 } })]), "fanoutOnlyWithPlacement"],
		["ENFORCE without INFORM", withPipelineNodes([node("e", { fromSources: ["app"], policyMode: CD_POLICY_MODE.ENFORCE })], CD_FREIGHT_SUBJECT.RAIL), "enforceFollowsInform"],
		["an unknown window", withPipelineNodes([node("a", { fromSources: ["app"], windows: ["nope"] })]), "windowsAreDefined"],
		["stages stopping short of 100", withPipelineNodes([node("a", { fromSources: ["app"], stagePercents: [5, 25] })]), "stagesAscendToFull"],
		["a wildcard claim", { ...sound, publishers: [{ name: "gh", issuer: "https://x", audience: "a", requiredClaims: { repository: "acme/*" } }] }, "publishersArePinned"],
		["unpinned provenance", { ...sound, sources: [{ name: "app", subscriptions: [{ name: "oci", requireProvenance: true, trustedBuilderIds: [], trustedSignerIdentities: [] }] }] }, "provenanceIsPinned"],
		["an inline secret", { ...sound, publishers: [{ name: "gh", issuer: "https://x", audience: "a", requiredClaims: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }] }, "recordsAreSecretFree"],
	])("catches %s", async (_what, module, assertion) => {
		expect(failed(await runDeliveryRecordsConformance("broken", module))).toContain(assertion);
	});
	it("mirrors the frozen PolicyMode, FreightSubject and RolloutStrategy enums", () => {
		expect(CD_POLICY_MODE).toEqual({ INFORM: PolicyMode.INFORM, ENFORCE: PolicyMode.ENFORCE });
		expect(CD_FREIGHT_SUBJECT).toEqual({ BINDLE: FreightSubject.BINDLE, RAIL: FreightSubject.RAIL });
		expect(CD_ROLLOUT_STRATEGY).toEqual({
			ALL_AT_ONCE: RolloutStrategy.ALL_AT_ONCE,
			CANARY: RolloutStrategy.CANARY,
			BLUE_GREEN: RolloutStrategy.BLUE_GREEN,
			EXPERIMENT: RolloutStrategy.EXPERIMENT,
		});
	});
});
