import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	COUNCIL_PERSONAS,
	advanceInvestment,
	aggregateVotes,
	carryInvestment,
	clamp01,
	computeProposalDigest,
	decayForEvidence,
	evaluateDesignRelevance,
	evaluateMergeEligibility,
	evidenceStrengthFromSignals,
	initialInvestment,
	round4,
	validateCouncilMembership,
} from "../lib/design-council.mts";

const digest = (character: string) => character.repeat(64);

describe("designer council pure protocol", () => {
	it("seeds and monotonically decays deterministic synthetic investment", () => {
		assert.equal(clamp01(-1), 0);
		assert.equal(clamp01(2), 1);
		assert.equal(round4(0.123456), 0.1235);
		assert.equal(initialInvestment(0.75, 0.8), 0.6975);
		assert.equal(decayForEvidence(0.8), 0.196);
		assert.equal(advanceInvestment(0.6975, 0.196), 0.5015);
		assert.equal(carryInvestment(0.2, 0.9), 0.2);
		assert.equal(carryInvestment(0.8, 0.3), 0.3);
		let investment = initialInvestment(1, 1);
		while (investment > 0) investment = advanceInvestment(investment, decayForEvidence(1));
		assert.equal(investment, 0);
		assert.ok(decayForEvidence(1) < decayForEvidence(0));
	});

	it("derives evidence strength from evidence, not confidence", () => {
		assert.equal(evidenceStrengthFromSignals({ evidenceTypes: [] }), 0);
		assert.equal(evidenceStrengthFromSignals({ evidenceTypes: ["prose"] }), 0.25);
		assert.equal(evidenceStrengthFromSignals({ evidenceTypes: ["code-path"] }), 0.5);
		assert.equal(evidenceStrengthFromSignals({ evidenceTypes: ["executable-test"] }), 0.75);
		assert.equal(
			evidenceStrengthFromSignals({
				evidenceTypes: ["executable-test", "screenshot"],
				currentHead: true,
				acceptanceMapped: true,
			}),
			1,
		);
	});

	it("canonicalizes proposal inputs before hashing", () => {
		const common = {
			subject: { kind: "surface" as const, surface: "digest test" },
			baseSha: digest("a"),
			headSha: digest("b"),
			normalizedDiffHash: digest("c"),
			acceptanceDigest: digest("d"),
			evidenceDigest: digest("e"),
			relevanceSignals: { categories: [], acceptanceTags: [], featureTags: [], keywords: [] },
			evidenceSignals: { evidenceTypes: [], currentHead: true, acceptanceMapped: true },
			council: [...COUNCIL_PERSONAS],
			protocolSchemaVersion: 1,
		};
		assert.equal(
			computeProposalDigest({ ...common, changedPaths: ["z", "a"] }),
			computeProposalDigest({ ...common, changedPaths: ["a", "z"] }),
		);
		assert.notEqual(
			computeProposalDigest({ ...common, changedPaths: ["a", "z"] }),
			computeProposalDigest({ ...common, changedPaths: ["a", "y"] }),
		);
	});

	it("requires exactly the canonical six and unanimous yay", () => {
		assert.deepEqual(validateCouncilMembership([...COUNCIL_PERSONAS]), []);
		assert.ok(validateCouncilMembership(COUNCIL_PERSONAS.slice(0, 5)).length > 0);
		assert.ok(validateCouncilMembership([...COUNCIL_PERSONAS, "extra"]).length > 0);
		const yays = Object.fromEntries(COUNCIL_PERSONAS.map((id) => [id, "yay"]));
		assert.deepEqual(aggregateVotes(yays, []), {
			result: "yay",
			nayPersonas: [],
		});
		assert.equal(aggregateVotes({ ...yays, "jony-ive": "nay" }, []).result, "nay");
		assert.equal(aggregateVotes(yays, ["HB-1"]).result, "nay");
		assert.throws(() => aggregateVotes(Object.fromEntries(COUNCIL_PERSONAS.slice(1).map((id) => [id, "yay"])), []));
	});

	it("requires visual review without treating technical contracts as visual design", () => {
		const exemption = { code: "no-visual-design-change" as const, justification: "The test contracts and package documentation have no visual interface change." };
		assert.deepEqual(
			evaluateDesignRelevance({ changedPaths: ["packages/testing/README.md", "packages/testing/data-models/test_harness.cue", "packages/testing/data-models/test_harness.proto", "packages/testing/contracts/pacts/app-test-harness.pact.json", "packages/control-yard/data-models/control_yard.proto", "packages/control-yard/contracts/pacts/control-yard-ui.pact.json", "packages/control-yard/package.json", "packages/control-yard/docs/asset-index-learnings.md", "site/README.md", ".optimizexp/features/agent-check-staged/feature.json"], exemption }),
			{ required: false, reasons: [], exemptionAccepted: true },
		);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["site/src/page.tsx"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/shared/assets/logo.svg"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/control-yard/contracts/example.png"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["site/DESIGN.md"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/control-yard/assets/bo/bo-idle.png"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/control-yard/src/scenes/yard-scene.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/control-yard/public/yard-game.js"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/mcp/src/secret-capture/html.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/hobo/src/mcp-store-choice.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/providers/provider-vercel/src/temporary-station.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/providers/provider-lakebed/src/temporary-station.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/status-page/src/site.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/status-page/src/tokens.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/connect-ui/src/view.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/connect-ui/src/steps.ts"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/shared/assets/type.woff2"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["src/internal/cache.ts"], acceptanceTags: ["ux"], exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["src/internal/cache.ts"], explicitlyRequested: true, exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["src/internal/cache.ts"], priorCouncilCycle: true, exemption }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["src/internal/cache.ts"], exemption: { code: "no-visual-design-change", justification: "short" } }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["src/internal/cache.ts"], exemption: { code: "internal-no-public-behavior", justification: "Private cache rename; exported behavior and errors unchanged." } }).required, false);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["packages/testing/data-models/test_harness.proto"], exemption: { code: "internal-no-public-behavior", justification: "Private cache rename; exported behavior and errors unchanged." } }).required, true);
		assert.equal(evaluateDesignRelevance({ changedPaths: ["src/internal/cache.ts"], acceptanceTags: ["dx"], exemption: { code: "internal-no-public-behavior", justification: "Private cache rename; exported behavior and errors unchanged." } }).required, true);
	});

	it("never lets billing-only CI waive current unanimous consensus", () => {
		const yays = Object.fromEntries(COUNCIL_PERSONAS.map((id) => [id, "yay"])) as Record<(typeof COUNCIL_PERSONAS)[number], "yay">;
		const common = {
			required: true,
			independentReviewPassed: true,
			commentsResolved: true,
			checks: [{ name: "ci", status: "billing-red" as const }],
			currentHeadSha: digest("a"),
			currentProposalDigest: digest("b"),
		};
		assert.equal(evaluateMergeEligibility(common).eligible, false);
		assert.equal(
			evaluateMergeEligibility({
				...common,
				consensus: {
					result: "yay",
					reviewedHeadSha: digest("a"),
					proposalDigest: digest("b"),
					votes: yays,
					openHardBlockers: [],
				},
			}).eligible,
			true,
		);
		assert.equal(
			evaluateMergeEligibility({
				...common,
				currentProposalDigest: digest("c"),
				consensus: {
					result: "yay",
					reviewedHeadSha: digest("a"),
					proposalDigest: digest("b"),
					votes: yays,
					openHardBlockers: [],
				},
			}).eligible,
			false,
		);
	});
});
