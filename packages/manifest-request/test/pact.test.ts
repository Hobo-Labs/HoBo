import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	canonicalSelectionCandidateJson,
	fromSelectionCandidateRecord,
	parseSelectionCandidate,
	SELECTION_CANDIDATE_SCHEMA_VERSION,
	SelectionCandidateError,
} from "../src/index.js";

type Interaction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body: unknown;
	};
	readonly response: {
		readonly status: number;
		readonly body: Record<string, unknown>;
	};
};

const PACT = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/selection-candidate-catalog.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: readonly Interaction[];
};

describe("hobo-selection-candidate-catalog (provider contract)", () => {
	it("is a well-formed pact naming this boundary", () => {
		expect(PACT.consumer.name).toBe("hobo-planner");
		expect(PACT.provider.name).toBe("hobo-selection-candidate-catalog");
		expect(PACT.interactions).toHaveLength(6);
	});

	it("carries both real catalog rows, not one shape twice", () => {
		const accepted = PACT.interactions
			.filter((interaction) => interaction.response.body.accepted === true)
			.map(
				(interaction) =>
					(interaction.request.body as { definitionId: string }).definitionId,
			);
		expect(accepted).toStrictEqual([
			"neon.claimable-postgres/v1",
			"cloudflare.temporary-hyperdrive/v1",
		]);
	});

	for (const interaction of PACT.interactions) {
		it(interaction.description, () => {
			expect(interaction.request.method).toBe("POST");
			expect(interaction.request.path).toBe(
				"/catalog/hobo.selection-candidate/v1",
			);
			expect(interaction.response.body.schema).toBe(
				SELECTION_CANDIDATE_SCHEMA_VERSION,
			);

			if (interaction.response.body.accepted === true) {
				expect(interaction.response.status).toBe(200);
				const parsed = parseSelectionCandidate(interaction.request.body);
				const canonical = canonicalSelectionCandidateJson(parsed);
				expect(canonical).toBe(interaction.response.body.canonical);
				expect(
					canonicalSelectionCandidateJson(
						fromSelectionCandidateRecord(JSON.parse(canonical)),
					),
				).toBe(canonical);
				return;
			}

			expect(interaction.response.status).toBe(422);
			let thrown: unknown;
			try {
				parseSelectionCandidate(interaction.request.body);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(SelectionCandidateError);
			const error = thrown as SelectionCandidateError;
			expect(error.code).toBe(interaction.response.body.code);
			expect(error.path).toBe(interaction.response.body.path);
			expect(error.message).toBe(interaction.response.body.message);
		});
	}

	it("exercises canonicalisation on a row a provider actually authored unsorted", () => {
		const neon = PACT.interactions[0];
		expect(neon).toBeDefined();
		const authored = (
			neon?.request.body as { producesBindingProfiles: readonly string[] }
		).producesBindingProfiles;
		expect(authored).toStrictEqual([
			"binding.postgresql/v1",
			"binding.neon-serverless/v1",
		]);
		expect(
			JSON.parse(String(neon?.response.body.canonical))
				.produces_binding_profiles,
		).toStrictEqual(["binding.neon-serverless/v1", "binding.postgresql/v1"]);
	});
});
