/**
 * The pact is verified by *replay*, not by being read.
 *
 * The boundary it names is the one the decomposition actually cut:
 * `SelectionCandidate` and its wire codec moved into `@hobo/manifest-request`,
 * while every gate that reads a candidate stayed in
 * `@hobo/capability-profiles`. So the contract is not "the record has these
 * keys" — a structural comparison passes that while a widened vocabulary or a
 * normalised absent field silently changes a verdict. The contract is: a
 * candidate that has been through the codec produces the same *decision*.
 *
 * Each interaction is therefore decoded with `fromSelectionCandidateRecord` and
 * run through `selectCapabilityImplementation`; the winner and the rejection
 * codes must equal the recorded response.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { fromSelectionCandidateRecord } from "@hobo/manifest-request";
import { describe, expect, it } from "vitest";

type Interaction = {
	readonly description: string;
	readonly request: {
		readonly body: {
			readonly requirement: Record<string, unknown>;
			readonly nowMs: number;
			readonly candidates: readonly unknown[];
		};
	};
	readonly response: {
		readonly winner: string | null;
		readonly rejectionCodes: readonly string[];
	};
};

const PACT = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/selection-candidate-codec.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as { readonly interactions: readonly Interaction[] };

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);

describe("selection-candidate-codec pact", () => {
	it("carries interactions, so the replay below is not vacuous", () => {
		expect(PACT.interactions.length).toBe(4);
	});

	it.each(
		PACT.interactions.map((i) => [i.description, i] as const),
	)("%s", (_description, interaction) => {
		const { requirement, nowMs, candidates } = interaction.request.body;
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement(requirement as never),
			registry,
			candidates: candidates.map((record) =>
				fromSelectionCandidateRecord(record),
			),
			policy: DEFAULT_TRUST_POLICY,
			nowMs,
		});
		expect(result.winner?.definitionId ?? null).toBe(
			interaction.response.winner,
		);
		expect(result.rejections.map((r) => r.code)).toEqual(
			interaction.response.rejectionCodes,
		);
	});
});
