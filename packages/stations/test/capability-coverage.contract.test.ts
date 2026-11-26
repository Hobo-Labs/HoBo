/**
 * Executable contract test for
 * `contracts/pacts/station-capability-coverage.pact.json`.
 *
 * `architecture:guard` proves that file exists and is shaped like a pact, and
 * nothing more. Unexecuted, a pact can describe a boundary the code stopped
 * honouring years ago while every gate stays green. This file executes it
 * against `aggregateStationCapabilities` and `renderStationCapabilityCoverage`.
 *
 * The pact is the *input*. Every assertion reads the JSON at runtime and drives
 * the real aggregation with the interaction's own request body, then checks the
 * interaction's own response body. Nothing is restated independently, because a
 * second copy of an expectation drifts exactly as silently as no copy at all.
 *
 * This is a logical boundary, not an HTTP service, so interactions cannot be
 * replayed over a transport: each is mapped to a real call **by its
 * `description`**, and the final test refuses any interaction with no mapped
 * assertion. That guard is the load-bearing line — an unmapped interaction is
 * precisely the drift this file exists to catch.
 *
 * Determinism: the coverage record is a pure function of its input and carries
 * no timestamp. No clock, no randomness, no network, no environment reads.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	aggregateStationCapabilities,
	renderStationCapabilityCoverage,
	type StationCapabilityCoverage,
	type StationYardCatalogInput,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

interface PactInteraction {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body: {
			readonly expected: readonly string[];
			readonly yards: readonly StationYardCatalogInput[];
		};
	};
	readonly response: {
		readonly status: number;
		readonly body: JsonObject;
	};
}

interface PactFile {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactInteraction[];
	readonly metadata?: JsonObject;
}

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"pacts",
	"station-capability-coverage.pact.json",
);
// SAFETY: assertion required at this I/O or test boundary.
const pact = JSON.parse(readFileSync(pactPath, "utf8")) as PactFile;

/**
 * The Station under test is named by the interaction's own path, so a pact edit
 * that renames it moves the real call with it rather than leaving a constant
 * behind in this file.
 */
function stationIdOf(interaction: PactInteraction): string {
	const match = /^\/stations\/([^/]+)\/capability-coverage$/u.exec(
		interaction.request.path,
	);
	expect(
		match,
		`interaction path "${interaction.request.path}" does not name a Station`,
	).not.toBeNull();
	return decodeURIComponent(match?.[1] ?? "");
}

/** Drive the real aggregation from an interaction's request body. */
function aggregate(interaction: PactInteraction): StationCapabilityCoverage {
	return aggregateStationCapabilities({
		stationId: stationIdOf(interaction),
		expected: interaction.request.body.expected,
		yards: interaction.request.body.yards,
	});
}

/**
 * Descriptions that have an executable assertion below. Populated at collection
 * time, checked at run time by the unmapped-interaction guard.
 */
const MAPPED = new Set<string>();

/** Register one assertion against the interaction carrying `description`. */
function contract(
	description: string,
	assertions: (interaction: PactInteraction) => void,
): void {
	MAPPED.add(description);
	it(description, () => {
		const matches = pact.interactions.filter(
			(interaction) => interaction.description === description,
		);
		expect(
			matches.length,
			`pact must declare exactly one interaction "${description}"`,
		).toBe(1);
		// SAFETY: assertion required at this I/O or test boundary.
		assertions(matches[0] as PactInteraction);
	});
}

describe("station-capability-coverage pact (consumer: @hobo/stations)", () => {
	it("is the pact this package publishes", () => {
		expect(pact.consumer.name).toBe("@hobo/stations");
		expect(pact.provider.name).toBe("station-yard-catalog");
	});

	contract(
		"two yards both able to allocate web.hosted/v1 aggregate to coverage 2, not a conflict",
		(interaction) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const expected = interaction.response.body as {
				schema: string;
				stationId: string;
				ok: boolean;
				served: readonly {
					profile: string;
					offeringCount: number;
					yardNames: readonly string[];
					providerIds: readonly string[];
					expected: boolean;
				}[];
				gaps: readonly unknown[];
				singlySourced: readonly string[];
			};
			expect(interaction.request.method).toBe("POST");
			expect(interaction.response.status).toBe(200);

			const coverage = aggregate(interaction);
			expect(coverage.schema).toBe(expected.schema);
			expect(coverage.stationId).toBe(expected.stationId);
			expect(coverage.ok).toBe(expected.ok);
			expect([...coverage.gaps]).toEqual([...expected.gaps]);
			expect([...coverage.singlySourced]).toEqual([...expected.singlySourced]);

			expect(coverage.served.length).toBe(expected.served.length);
			for (const [index, pinned] of expected.served.entries()) {
				const entry = coverage.served[index];
				expect(entry, `no served entry at index ${index}`).toBeDefined();
				if (entry === undefined) continue;
				expect(entry.profile).toBe(pinned.profile);
				expect(entry.offeringCount).toBe(pinned.offeringCount);
				expect([...entry.yardNames]).toEqual([...pinned.yardNames]);
				expect([...entry.providerIds]).toEqual([...pinned.providerIds]);
				expect(entry.expected).toBe(pinned.expected);
				// "Coverage, not a conflict": every pinned offering survives, and
				// the offerings really are the breadth the count claims.
				expect(entry.offerings.length).toBe(pinned.offeringCount);
				// Aggregation never picks a winner, so the count must be the sum of
				// the rows the request actually declared for that profile.
				const declared = interaction.request.body.yards.flatMap((yard) =>
					yard.bindings.filter((row) => row.profile === pinned.profile),
				);
				expect(entry.offeringCount).toBe(declared.length);
			}

			// The digest an operator reads must agree with the record.
			const rendered = renderStationCapabilityCoverage(coverage);
			expect(rendered).toContain(`station ${expected.stationId}`);
			expect(rendered).toContain(expected.ok ? ": ok" : ": INCOMPLETE");
			for (const pinned of expected.served) {
				expect(rendered).toContain(
					`ok   ${pinned.profile} — ${pinned.offeringCount} offering(s)`,
				);
			}
		},
	);

	contract(
		"an expected profile no yard can allocate is a gap with remediation, and ok is false",
		(interaction) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const expected = interaction.response.body as {
				schema: string;
				stationId: string;
				ok: boolean;
				gaps: readonly { profile: string; remediation: string }[];
				singlySourced: readonly string[];
			};
			expect(interaction.response.status).toBe(200);

			const coverage = aggregate(interaction);
			expect(coverage.schema).toBe(expected.schema);
			expect(coverage.stationId).toBe(expected.stationId);
			expect(coverage.ok).toBe(expected.ok);
			expect([...coverage.singlySourced]).toEqual([...expected.singlySourced]);
			// The remediation is code-observable here (unlike a pact-prose field):
			// `StationCapabilityGap` carries it, so it is compared verbatim.
			expect(coverage.gaps.map((gap) => ({ ...gap }))).toEqual([
				...expected.gaps,
			]);
			// A gap is an absence, not a dropped row: nothing served claims it.
			for (const gap of expected.gaps) {
				expect(
					coverage.served.some((entry) => entry.profile === gap.profile),
				).toBe(false);
			}

			// Gaps lead the digest, and carry their remediation into it.
			const rendered = renderStationCapabilityCoverage(coverage);
			expect(rendered).toContain(": INCOMPLETE");
			for (const gap of expected.gaps) {
				expect(rendered).toContain(`gap  ${gap.profile} — ${gap.remediation}`);
			}
		},
	);

	contract(
		"a row constraining neither productId nor connectivityId is refused, never skipped",
		(interaction) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const expected = interaction.response.body as {
				code: string;
				remediation: string;
			};
			expect(
				interaction.response.status,
				"a refusal interaction must carry a failure status",
			).toBeGreaterThanOrEqual(400);

			let thrown: unknown;
			try {
				aggregate(interaction);
			} catch (error) {
				thrown = error;
			}
			expect(
				thrown,
				`aggregation accepted a catalog the pact says it refuses with ${expected.code}`,
			).toBeInstanceOf(Error);
			// SAFETY: assertion required at this I/O or test boundary.
			const error = thrown as { code?: string; remediation?: string };
			expect(error.code).toBe(expected.code);
			expect(error.remediation).toBe(expected.remediation);
		},
	);

	// The most important test in this file. Everything above maps one
	// interaction to real code by description; an interaction nobody mapped is
	// an unexecuted contract, which is the exact failure mode this file exists
	// to remove. Adding an interaction to the pact must fail here until someone
	// writes the assertion that proves it.
	it("asserts every interaction the pact file declares", () => {
		const declared = pact.interactions.map(
			(interaction) => interaction.description,
		);
		expect(declared.length).toBeGreaterThan(0);
		expect(
			new Set(declared).size,
			"interaction descriptions are the mapping key, so they must be unique",
		).toBe(declared.length);
		expect(
			declared.filter((description) => !MAPPED.has(description)),
			"pact interactions with no executable assertion",
		).toEqual([]);
		expect(
			[...MAPPED].filter((description) => !declared.includes(description)),
			"assertions mapped to interactions the pact no longer declares",
		).toEqual([]);
		expect(MAPPED.size).toBe(declared.length);
	});
});
