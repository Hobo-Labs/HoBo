import assert from "node:assert/strict";
import { test } from "vitest";

import {
	COUNCIL_PERSONAS,
	computeProposalDigest,
	evaluateDesignRelevance,
	evaluateMergeEligibility,
} from "../.agents/skills/optimizexp/harness/lib/design-council.mts";

const digest = (character: string) => character.repeat(64);
const yayVotes = Object.fromEntries(
	COUNCIL_PERSONAS.map((persona) => [persona, "yay"]),
);

function mergeInput() {
	return {
		required: true,
		independentReviewPassed: true,
		commentsResolved: true,
		checks: [{ name: "ci", status: "pass" as const }],
		currentHeadSha: digest("a"),
		currentProposalDigest: digest("b"),
		consensus: {
			result: "yay" as const,
			reviewedHeadSha: digest("a"),
			proposalDigest: digest("b"),
			votes: yayVotes,
			openHardBlockers: [],
		},
	};
}

function mergeInputWithoutConsensus() {
	const { consensus: _consensus, ...input } = mergeInput();
	return input;
}

test("visual paths require designer consensus", () => {
	for (const changedPath of [
		"apps/web/src/onboarding.tsx",
		"site/src/page.tsx",
		"packages/shared/assets/logo.svg",
	]) {
		const result = evaluateDesignRelevance({
			changedPaths: [changedPath],
			exemption: {
				code: "no-visual-design-change",
				justification: "A visual path cannot be exempted from designer review.",
			},
		});

		assert.equal(result.required, true, changedPath);
		assert.equal(result.exemptionAccepted, false, changedPath);
		assert.notEqual(result.reasons.length, 0, changedPath);
	}
});

test("public non-visual paths need a no-visual exemption, not an internal one", () => {
	for (const changedPath of [
		"packages/cli/src/commands/deploy.ts",
		"packages/sdk/src/public-api.ts",
		"docs/tutorials/first-deploy.md",
		"examples/hello-hobo/README.md",
		".optimizexp/features/deploy-journey/feature.json",
	]) {
		const unexempted = evaluateDesignRelevance({ changedPaths: [changedPath] });
		assert.equal(unexempted.required, true, changedPath);
		assert.deepEqual(unexempted.reasons, [], changedPath);

		assert.deepEqual(
			evaluateDesignRelevance({
				changedPaths: [changedPath],
				exemption: {
					code: "no-visual-design-change",
					justification:
						"The change alters command and document text with no visual interface change.",
				},
			}),
			{ required: false, reasons: [], exemptionAccepted: true },
			changedPath,
		);

		assert.equal(
			evaluateDesignRelevance({
				changedPaths: [changedPath],
				exemption: {
					code: "internal-no-public-behavior",
					justification:
						"Private cache rename; exports, errors, and observable behavior are unchanged.",
				},
			}).required,
			true,
			changedPath,
		);
	}
});

test("only a justified internal-only diff is exempt", () => {
	assert.deepEqual(
		evaluateDesignRelevance({
			changedPaths: ["packages/core/src/internal/cache.ts"],
			exemption: {
				code: "internal-no-public-behavior",
				justification:
					"Private cache rename; exports, errors, and observable behavior are unchanged.",
			},
		}),
		{ required: false, reasons: [], exemptionAccepted: true },
	);
	assert.equal(
		evaluateDesignRelevance({
			changedPaths: ["packages/core/src/internal/cache.ts"],
			exemption: {
				code: "internal-no-public-behavior",
				justification: "internal",
			},
		}).required,
		true,
	);
	assert.equal(
		evaluateDesignRelevance({
			changedPaths: ["packages/core/src/internal/cache.ts"],
			priorCouncilCycle: true,
			exemption: {
				code: "internal-no-public-behavior",
				justification:
					"Private cache rename; exports, errors, and observable behavior are unchanged.",
			},
		}).required,
		true,
	);
});

test("SDLC merge eligibility requires current exact-six unanimous approval", () => {
	assert.equal(evaluateMergeEligibility(mergeInput()).eligible, true);
	assert.deepEqual(
		evaluateMergeEligibility(mergeInputWithoutConsensus()).reasons,
		["designer-consensus-missing"],
	);
	assert.ok(
		evaluateMergeEligibility({
			...mergeInput(),
			consensus: {
				...mergeInput().consensus,
				result: "nay",
				votes: { ...yayVotes, "jony-ive": "nay" },
			},
		}).reasons.includes("designer-consensus-not-unanimous"),
	);
	assert.ok(
		evaluateMergeEligibility({
			...mergeInput(),
			currentHeadSha: digest("c"),
		}).reasons.includes("designer-consensus-stale-head"),
	);
	assert.ok(
		evaluateMergeEligibility({
			...mergeInput(),
			consensus: {
				...mergeInput().consensus,
				votes: { ...yayVotes, "unknown-designer": "yay" },
			},
		}).reasons.includes("exact-six-membership"),
	);
});

test("billing-only CI never waives council approval", () => {
	const billingOnly = {
		...mergeInput(),
		checks: [{ name: "ci", status: "billing-red" as const }],
	};
	assert.equal(evaluateMergeEligibility(billingOnly).eligible, true);
	assert.equal(
		evaluateMergeEligibility({
			...mergeInputWithoutConsensus(),
			checks: billingOnly.checks,
		}).eligible,
		false,
	);
	assert.equal(
		evaluateMergeEligibility({
			...billingOnly,
			checks: [{ name: "ci", status: "fail" as const }],
		}).eligible,
		false,
	);
});

test("a lower-layer merge that changes an upper effective diff invalidates approval", () => {
	const proposal = {
		subject: { kind: "pull-request" as const, number: 123 },
		baseSha: digest("1"),
		headSha: digest("2"),
		changedPaths: ["packages/cli/src/help.ts"],
		normalizedDiffHash: digest("3"),
		acceptanceDigest: digest("4"),
		evidenceDigest: digest("5"),
		relevanceSignals: {
			categories: ["cli"],
			acceptanceTags: ["dx"],
			featureTags: [],
			keywords: [],
		},
		evidenceSignals: {
			evidenceTypes: ["executable-test"],
			currentHead: true,
			acceptanceMapped: true,
		},
		council: COUNCIL_PERSONAS,
		protocolSchemaVersion: 1,
	};
	const approvedDigest = computeProposalDigest(proposal);
	const rebasedDigest = computeProposalDigest({
		...proposal,
		baseSha: digest("6"),
		normalizedDiffHash: digest("7"),
	});
	const result = evaluateMergeEligibility({
		...mergeInput(),
		currentProposalDigest: rebasedDigest,
		consensus: { ...mergeInput().consensus, proposalDigest: approvedDigest },
	});

	assert.notEqual(rebasedDigest, approvedDigest);
	assert.ok(result.reasons.includes("designer-consensus-stale-proposal"));
	assert.equal(result.eligible, false);
});
