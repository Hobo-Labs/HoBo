import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { it } from "node:test";
import { asList, asObject, asText } from "../ci/attestation.mts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

it("runs pricing models and affected suites for stacked pull requests", () => {
	const workflow = workflowDocument(
		readFileSync(".github/workflows/pricing-ci.yml", "utf8"),
	);
	const events = asObject(workflow.on);
	const pull = asObject(events?.pull_request);
	const push = asObject(events?.push);
	assert.ok(pull);
	assert.ok(push);
	assert.equal(pull.branches, undefined);
	assert.equal(pull["branches-ignore"], undefined);
	assert.deepEqual(asList(push.branches), ["main"]);
	for (const event of [pull, push]) {
		const patterns = asList(event.paths)?.map(asText);
		assert.ok(patterns?.every((pattern) => pattern !== undefined));
		for (const path of [
			"packages/pricing/model/IacDestroyPricing.tla",
			"packages/pricing/model/IacFixedPricing.tla",
			"packages/pricing/model/IacPricingScope.tla",
			"packages/pricing/src/fixed-charge-coverage.ts",
			"packages/pricing/src/quote.ts",
			"packages/broker/model/IacBudget.tla",
			"packages/broker/model/IacPricedReceipt.tla",
			"packages/broker/model/IacPricedReceipt.cfg",
			"packages/broker/src/iac-target.ts",
			"packages/cloud/model/IacTransitions.tla",
			"packages/cloud/src/orchestrator/recovery.ts",
			"packages/dispatcher/model/IacRouting.tla",
			"packages/dispatcher/src/iac-target-routing.ts",
			"packages/provider-manifest/src/billing.ts",
			"scripts/check-iac-models.ts",
			"scripts/lib/bounded-tlc.ts",
			"scripts/test/bounded-tlc.test.ts",
			"scripts/test/pricing-workflow-model-trigger.test.ts",
			".github/workflows/pricing-ci.yml",
		])
			assert.ok(
				patterns.some((pattern) => matchesGlob(path, pattern)),
				path,
			);
	}
	const jobs = asObject(workflow.jobs);
	const pricingSteps = asList(asObject(jobs?.["pricing-gate"])?.steps);
	assert.ok(
		pricingSteps?.some((step) =>
			asText(asObject(step)?.run)?.includes(
				"scripts/test/pricing-workflow-model-trigger.test.ts",
			),
		),
	);
	const testStep = pricingSteps
		?.map((step) => asText(asObject(step)?.run))
		.find((run) => run?.includes("pnpm exec turbo run build test"));
	assert.ok(testStep);
	const words = new Set(testStep.split(/\s+/u));
	for (const name of [
		"@hobo/pricing",
		"@hobo/broker",
		"@hobo/cloud",
		"@hobo/dispatcher",
		"@hobo/events",
		"@hobo/provider-manifest",
	])
		assert.ok(words.has(`--filter=${name}`), name);
	const modelSteps = asList(asObject(jobs?.["pricing-models"])?.steps);
	for (const checker of [
		"scripts/test/bounded-tlc.test.ts",
		"scripts/check-iac-models.ts",
	])
		assert.ok(
			modelSteps?.some((step) =>
				asText(asObject(step)?.run)?.includes(checker),
			),
			checker,
		);
});
