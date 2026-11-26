/**
 * The PACT in `contracts/pacts/` is executed here, not left as a data file.
 *
 * A contract nobody runs records what someone once intended. Running it makes
 * it a gate: every interaction's request body is driven through this package's
 * real parse and wire boundaries, and the recorded response has to match
 * exactly — including the encoded wire string, byte for byte.
 *
 * The boundary is real. `contracts/pact-inventory.json` names the two committed
 * PACTs that already carry this shape across a process boundary
 * (`POST /capabilities/select` and `POST /matching/resolve`). What those two
 * do not pin is the *encoding*: they show the requirement going in, never the
 * canonical bytes coming out. That is what this contract adds, and it is the
 * property the rest of the package exists to guarantee.
 *
 * Each refusal interaction pins the exact code and message a consumer sees, so
 * tightening or renaming a refusal without updating the contract fails here
 * rather than silently changing what a caller can rely on.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	type CapabilityRequirementInput,
	parseCapabilityRequirement,
} from "../src/requirement.js";
import {
	fromCapabilityRequirementWire,
	toCapabilityRequirementWire,
} from "../src/wire.js";

/** Matches the `schema` every interaction's response carries. */
const CAPABILITY_REQUIREMENT_SCHEMA = "hobo.capability-requirement/v1";

type Interaction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body: Record<string, unknown>;
	};
	readonly response: {
		readonly status: number;
		readonly body: {
			readonly schema: string;
			readonly accepted: boolean;
			readonly wire?: string;
			readonly code?: string;
			readonly message?: string;
		};
	};
};

const PACT = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/capability-requirement.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: readonly Interaction[];
	metadata: { pactSpecification: { version: string } };
};

describe("hobo-capability-manifest (provider contract)", () => {
	it("is a well-formed pact naming this boundary", () => {
		expect(PACT.consumer.name).toBe("hobo-planner");
		expect(PACT.provider.name).toBe("hobo-capability-manifest");
		expect(PACT.metadata.pactSpecification.version).toBe("2.0.0");
		// Pinned, so an interaction that is deleted rather than fixed fails.
		expect(PACT.interactions).toHaveLength(8);
	});

	it("covers both outcomes and both boundaries", () => {
		const accepted = PACT.interactions.filter((i) => i.response.body.accepted);
		const refused = PACT.interactions.filter((i) => !i.response.body.accepted);
		expect(accepted.length).toBeGreaterThan(0);
		expect(refused.length).toBeGreaterThan(0);
		// A contract that only ever refuses at one boundary is not describing
		// this package: parse and decode fail for different reasons.
		expect(new Set(refused.map((i) => i.response.body.code))).toEqual(
			new Set(["INVALID_CAPABILITY_REQUIREMENT", "INVALID_CAPABILITY_WIRE"]),
		);
	});

	for (const interaction of PACT.interactions) {
		it(interaction.description, () => {
			expect(interaction.response.body.schema).toBe(
				CAPABILITY_REQUIREMENT_SCHEMA,
			);

			// The decode-side interaction hands over a wire record, not an input.
			if (interaction.request.path.endsWith("/decode")) {
				expect(interaction.response.body.accepted).toBe(false);
				try {
					fromCapabilityRequirementWire(interaction.request.body);
					expect.unreachable("expected the decode boundary to refuse");
				} catch (error) {
					expect((error as { code?: string }).code).toBe(
						interaction.response.body.code,
					);
					expect((error as Error).message).toBe(
						interaction.response.body.message,
					);
				}
				return;
			}

			const input = interaction.request
				.body as unknown as CapabilityRequirementInput;

			if (!interaction.response.body.accepted) {
				expect(interaction.response.status).toBe(422);
				try {
					parseCapabilityRequirement(input);
					expect.unreachable("expected the parse boundary to refuse");
				} catch (error) {
					expect((error as { code?: string }).code).toBe(
						interaction.response.body.code,
					);
					expect((error as Error).message).toBe(
						interaction.response.body.message,
					);
				}
				return;
			}

			expect(interaction.response.status).toBe(200);
			const parsed = parseCapabilityRequirement(input);
			const encoded = JSON.stringify(toCapabilityRequirementWire(parsed));
			// Byte-identical, because that is the whole claim.
			expect(encoded).toBe(interaction.response.body.wire);

			// And the contract's own recorded bytes decode back to the same
			// requirement — so the wire string is a round trip, not a snapshot.
			const decoded = fromCapabilityRequirementWire(
				JSON.parse(interaction.response.body.wire as string),
			);
			expect(JSON.stringify(decoded)).toBe(JSON.stringify(parsed));
		});
	}
});
