import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	canonicalResourceIntentJson,
	decodeResourceIntent,
	encodeResourceIntent,
	RESOURCE_INTENT_SCHEMA,
	ResourceIntentError,
} from "../src/index.js";

/**
 * The PACT in `contracts/pacts/` is executed here rather than left as a data
 * file. A contract nobody runs records what someone once intended; running it
 * makes it a gate.
 *
 * The boundary this covers is real: a declaration leaves the Planner's lowering
 * stage as a wire record and arrives at matching, which is the point where a
 * provider-shaped field or a presence-losing region would become someone else's
 * problem. Each refusal interaction pins the exact message the consumer will
 * see, so tightening a refusal without updating the contract fails here.
 */

type PactValue = string | number | boolean | null | PactValue[] | PactBody;
type PactBody = { readonly [key: string]: PactValue };
type Interaction = {
	readonly description: string;
	readonly request: { readonly body: PactBody };
	readonly response: {
		readonly status: number;
		readonly body: PactBody;
	};
};

const PACT_SOURCE = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/resource-intent-declaration.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
);

// SAFETY: PACT_SOURCE is the repository-owned Pact schema under test.
const PACT = PACT_SOURCE as {
	consumer: { name: string };
	provider: { name: string };
	interactions: readonly Interaction[];
};

describe("hobo-resource-intent-declaration (provider contract)", () => {
	it("is a well-formed pact naming this boundary", () => {
		expect(PACT.consumer.name).toBe("hobo-planner");
		expect(PACT.provider.name).toBe("hobo-resource-intent-declaration");
		expect(PACT.interactions).toHaveLength(4);
	});

	for (const interaction of PACT.interactions) {
		it(interaction.description, () => {
			expect(interaction.response.body.schema).toBe(RESOURCE_INTENT_SCHEMA);

			if (interaction.response.body.accepted === true) {
				expect(interaction.response.status).toBe(200);
				const parsed = decodeResourceIntent(interaction.request.body);
				expect(canonicalResourceIntentJson(parsed)).toBe(
					interaction.response.body.canonical,
				);
				// The wire record the contract publishes is the one this package
				// emits — not merely one it can read.
				expect(encodeResourceIntent(parsed)).toStrictEqual(
					interaction.request.body,
				);
				return;
			}

			expect(interaction.response.status).toBe(422);
			let thrown: unknown;
			try {
				decodeResourceIntent(interaction.request.body);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ResourceIntentError);
			// SAFETY: the preceding assertion verifies the caught value is ResourceIntentError.
			const error = thrown as ResourceIntentError;
			expect(error.code).toBe(interaction.response.body.code);
			expect(error.path).toBe(interaction.response.body.path);
			expect(error.message).toBe(interaction.response.body.message);
		});
	}
});
