// Executable PACT evidence for the runner <-> anonymous-adapter boundary.
//
// The pact is the contract an adapter implements: it names the exact request
// the runner sends for a case and the exact response body the adapter answers
// with. Replaying every recorded interaction through the real judges is what
// keeps the JSON honest — a pact nobody executes drifts from the code within a
// release.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";

import {
	type AnonymousCaseOutcome,
	BINDING_CONFORMANCE_SUITE,
	BOOTSTRAP_CONFORMANCE_SUITE,
	CLAIM_CONFORMANCE_SUITE,
	MIGRATION_CONFORMANCE_SUITE,
	runAnonymousSuite,
} from "../../src/suites/anonymous/index.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact: {
	interactions: Array<{
		description: string;
		request: { path: string; body: JsonObject };
		response: { body: JsonObject };
	}>;
} = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/anonymous-conformance-adapter.pact.json"),
		"utf8",
	),
);

const SUITES = {
	"/anonymous/bootstrap/attempt": BOOTSTRAP_CONFORMANCE_SUITE,
	"/anonymous/claim/step": CLAIM_CONFORMANCE_SUITE,
	"/anonymous/binding/probe": BINDING_CONFORMANCE_SUITE,
	"/anonymous/migration/step": MIGRATION_CONFORMANCE_SUITE,
} as const;

describe("anonymous conformance adapter boundary", () => {
	it("covers all four dimensions", () => {
		const paths = new Set(
			pact.interactions.map((interaction) => interaction.request.path),
		);
		expect([...paths].sort()).toEqual(Object.keys(SUITES).sort());
	});

	it("sends the request each recorded case actually declares", () => {
		for (const interaction of pact.interactions) {
			// SAFETY: assertion to `teraction.request.path as keyof typeof SUITES];` is required at this boundary.
			const suite = SUITES[interaction.request.path as keyof typeof SUITES];
			const caseId = interaction.request.body.caseId;
			const declared = suite.cases.find((suiteCase) => suiteCase.id === caseId);
			expect(declared, `no case declares ${String(caseId)}`).toBeDefined();
			expect(declared?.request).toEqual(interaction.request.body);
		}
	});

	it("passes each recorded response through the real judge", async () => {
		for (const interaction of pact.interactions) {
			// SAFETY: assertion to `teraction.request.path as keyof typeof SUITES];` is required at this boundary.
			const suite = SUITES[interaction.request.path as keyof typeof SUITES];
			const caseId = String(interaction.request.body.caseId);

			// Only the recorded case runs; everything else is left `unknown`,
			// which is exactly how a partial run must report.
			const report = await runAnonymousSuite(
				suite,
				() => interaction.response.body,
				{ caseIds: [caseId], subjectId: "pact-recorded-adapter" },
			);
			const result = report.cases.find((entry) => entry.caseId === caseId);
			expect(
				result?.outcome,
				`${interaction.description}: ${result?.detail ?? "no result"}`,
			).toBe("pass" satisfies AnonymousCaseOutcome);
		}
	});
});
