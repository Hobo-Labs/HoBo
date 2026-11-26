// Self-test for the realization-result conformance suite (E20): a reference
// producer built on the @hobo/core adapters passes every assertion, and
// broken producers (secret laundering, unstable output) are caught.

import { fromIacOutputs, fromRecipeOutputs } from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";

import {
	REALIZATION_RESULT_CONFORMANCE_CONTRACT,
	type RealizationResultScenario,
	runRealizationResultConformance,
} from "../src/suites/realization-result.js";

// The `{resources, stackOutputs, bindings}` triple the IaC adapters emit.
const IAC_TRIPLE = {
	resources: {
		queue: {
			id: "terraform://workspace/app.queue",
			type: "queue",
			outputs: { url: "https://queue.example.test" },
		},
		bucket: {
			id: "pulumi:stack:bucket",
			type: "bucket",
			outputs: { arn: "arn:aws:s3:::bucket" },
		},
	},
	stackOutputs: { region: "eu-west-1" },
	bindings: {
		"queue.url": "https://queue.example.test",
		"bucket.arn": "arn:aws:s3:::bucket",
	},
};

function iacProducer(scenario: RealizationResultScenario): JsonValue {
	if (scenario === "raw-secret") {
		return fromIacOutputs({
			...IAC_TRIPLE,
			bindings: { ...IAC_TRIPLE.bindings, "db.password": "hunter2" },
		});
	}
	if (scenario === "unordered") {
		// Same content, reversed insertion order — parse must canonicalize.
		return fromIacOutputs({
			resources: {
				queue: IAC_TRIPLE.resources.queue,
				bucket: IAC_TRIPLE.resources.bucket,
			},
			stackOutputs: IAC_TRIPLE.stackOutputs,
			bindings: {
				"queue.url": "https://queue.example.test",
				"bucket.arn": "arn:aws:s3:::bucket",
			},
		});
	}
	return fromIacOutputs(IAC_TRIPLE);
}

function recipeProducer(scenario: RealizationResultScenario): JsonValue {
	if (scenario === "raw-secret") {
		return fromRecipeOutputs({
			secrets: { deployKey: "raw-key-value" },
			resources: [{ name: "functions" }],
		});
	}
	const base = {
		values: { deployment: "team-app" },
		secrets: { deployKey: "broker://tenant/convex-deploy-key" },
		resources: [
			{
				name: "functions",
				type: "convex.function",
				id: "convex://team-app/functions",
			},
			{ name: "auth", type: "convex.auth", id: "convex://team-app/auth" },
		],
	};
	if (scenario === "unordered") {
		return {
			...fromRecipeOutputs(base),
			bindings: [
				{ key: "functions.endpoint", value: "https://team-app.convex.test" },
				{ key: "auth.issuer", value: "https://auth.convex.test" },
			],
		};
	}
	return fromRecipeOutputs(base);
}

describe("@hobo/conformance realization-result suite", () => {
	it("passes for the fromIacOutputs reference lane", async () => {
		const report = await runRealizationResultConformance(iacProducer, {
			producer: "iac-outputs-reference",
		});
		expect(report.contract).toBe(REALIZATION_RESULT_CONFORMANCE_CONTRACT);
		expect(report.producer).toBe("iac-outputs-reference");
		expect(report.assertions).toEqual({
			schemaRoundTrip: "pass",
			refOnlySecretsEnforced: "pass",
			deterministicResourceOrder: "pass",
			deterministicBindingOrder: "pass",
		});
	});

	it("passes for the fromRecipeOutputs reference lane", async () => {
		const report = await runRealizationResultConformance(recipeProducer, {
			producer: "recipe-outputs-reference",
		});
		expect(report.assertions).toEqual({
			schemaRoundTrip: "pass",
			refOnlySecretsEnforced: "pass",
			deterministicResourceOrder: "pass",
			deterministicBindingOrder: "pass",
		});
	});

	it("fails a producer that launders a raw secret through the happy path", async () => {
		const report = await runRealizationResultConformance((scenario) =>
			// Broken: the raw-secret lane silently emits a clean result instead
			// of rejecting — the leak was laundered upstream.
			iacProducer(scenario === "raw-secret" ? "happy" : scenario),
		);
		expect(report.assertions.refOnlySecretsEnforced).toBe("fail");
		expect(report.assertions.schemaRoundTrip).toBe("pass");
	});

	it("fails a producer with unstable output across runs", async () => {
		let run = 0;
		const report = await runRealizationResultConformance((scenario) => {
			if (scenario !== "unordered") {
				return iacProducer(scenario);
			}
			run += 1;
			return fromIacOutputs({
				...IAC_TRIPLE,
				resources: {
					...IAC_TRIPLE.resources,
					queue: {
						...IAC_TRIPLE.resources.queue,
						id: `terraform://workspace/app.queue-${run}`,
					},
				},
			});
		});
		expect(report.assertions.deterministicResourceOrder).toBe("fail");
		expect(report.assertions.deterministicBindingOrder).toBe("fail");
	});

	it("fails a producer that never emits enough entries to probe ordering", async () => {
		const report = await runRealizationResultConformance(() =>
			fromRecipeOutputs({ resources: [{ name: "only" }] }),
		);
		expect(report.assertions.deterministicResourceOrder).toBe("fail");
		expect(report.assertions.deterministicBindingOrder).toBe("fail");
	});
});
