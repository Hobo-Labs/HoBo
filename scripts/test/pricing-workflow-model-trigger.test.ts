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
			"packages/pricing/src/quote.ts",
			"packages/pricing/src/fixed-charge-coverage.ts",
			"packages/broker/model/IacBudget.tla",
			"packages/broker/model/IacPricedReceipt.tla",
			"packages/broker/model/IacPricedReceipt.cfg",
			"packages/broker/src/iac-target.ts",
			"packages/cloud/model/IacTransitions.tla",
			"packages/cloud/src/orchestrator/recovery.ts",
			"packages/core/src/ports/durable-messaging.ts",
			"packages/core/test/durable-messaging-model.test.ts",
			"packages/runtime/src/durable-messaging-host.ts",
			"packages/runtime/test/durable-messaging-jspi-component.test.ts",
			"packages/runtimes/runtime-rivet/src/distributed-journal.ts",
			"packages/runtimes/runtime-rivet/test/distributed-journal.test.ts",
			"packages/runtimes/runtime-rivet/model/DurableTopic.tla",
			"packages/runtimes/runtime-rivet/model/DurableTopic.cfg",
			"scripts/check-durable-topic-model.ts",
			"packages/conformance/src/durable-messaging-conformance.ts",
			"packages/conformance/test/durable-messaging-conformance.test.ts",
			"packages/wit/wit/deps/hobo-durable-messaging/hobo-durable-messaging.wit",
			"packages/wit/wit/deps/hobo-durable-messaging-jspi/hobo-durable-messaging-jspi.wit",
			"packages/iac/iac-alchemy/model/IacGrant.tla",
			"packages/iac/iac-alchemy/model/RivetQueue.tla",
			"packages/iac/iac-alchemy/model/RivetQueue.cfg",
			"packages/iac/iac-alchemy/model/check-rivet-queue.mts",
			"packages/iac/iac-alchemy/model/RivetKv.tla",
			"packages/iac/iac-alchemy/model/RivetKv.cfg",
			"packages/iac/iac-alchemy/model/check-rivet-kv.mts",
			"packages/iac/iac-alchemy/model/RivetHttpKv.tla",
			"packages/iac/iac-alchemy/model/RivetHttpKv.cfg",
			"packages/iac/iac-alchemy/model/check-rivet-http-kv.mts",
			"packages/iac/iac-alchemy/model/RivetHttpQueue.tla",
			"packages/iac/iac-alchemy/model/RivetHttpQueue.cfg",
			"packages/iac/iac-alchemy/model/CloudflareGrant.tla",
			"packages/iac/iac-alchemy/model/CloudflareGrant.cfg",
			"packages/iac/iac-alchemy/model/check-cloudflare-grants.mts",
			"packages/iac/iac-alchemy/model/check-rivet-http-queue.mts",
			"packages/iac/iac-alchemy/src/index.ts",
			"test/iac-alchemy-integration.test.ts",
			"packages/extension-alchemy-rivet/src/index.ts",
			"packages/extension-alchemy-rivet/test/rivet-topic-bus-alchemy.test.ts",
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
		"@hobo/core",
		"@hobo/runtime",
		"@hobo/runtime-rivet",
		"@hobo/conformance",
		"@hobo/wit",
		"@hobo/iac-alchemy",
		"@hobo/alchemy-rivet",
		"@hobo/dispatcher",
		"@hobo/events",
		"@hobo/provider-manifest",
	])
		assert.ok(words.has(`--filter=${name}`), name);
	assert.ok(
		pricingSteps?.some((step) =>
			asText(asObject(step)?.run)?.includes(
				"pnpm --filter @hobo/wit run wit:check",
			),
		),
	);
	const integrationIndex =
		pricingSteps?.findIndex((step) =>
			asText(asObject(step)?.run)?.includes(
				"test/iac-alchemy-integration.test.ts",
			),
		) ?? -1;
	const prerequisitesIndex =
		pricingSteps?.findIndex((step) => {
			const run = asText(asObject(step)?.run);
			return (
				run?.includes("turbo run build") &&
				run.includes("--filter=@hobo/bindles") &&
				run.includes("--filter=@hobo/runtime-local")
			);
		}) ?? -1;
	assert.ok(integrationIndex >= 0, "Alchemy financial integration must run");
	assert.ok(
		prerequisitesIndex >= 0 && prerequisitesIndex < integrationIndex,
		"Alchemy integration prerequisites must build before the test",
	);
	const modelSteps = asList(asObject(jobs?.["pricing-models"])?.steps);
	const modelCheck = modelSteps
		?.map(asObject)
		.find(
			(step) => asText(step?.name) === "Verify tool digest and check models",
		);
	assert.equal(
		asText(asObject(modelCheck?.env)?.JAVA_TOOL_OPTIONS),
		"-XX:ActiveProcessorCount=2",
	);
	for (const checker of [
		"scripts/test/bounded-tlc.test.ts",
		"scripts/check-iac-models.ts",
		"scripts/check-durable-topic-model.ts",
		"packages/iac/iac-alchemy/model/check-rivet-queue.mts",
		"packages/iac/iac-alchemy/model/check-rivet-kv.mts",
		"packages/iac/iac-alchemy/model/check-rivet-http-kv.mts",
		"packages/iac/iac-alchemy/model/check-rivet-http-queue.mts",
		"packages/iac/iac-alchemy/model/check-cloudflare-grants.mts",
	])
		assert.ok(
			modelSteps?.some((step) =>
				asText(asObject(step)?.run)?.includes(checker),
			),
			checker,
		);
});
