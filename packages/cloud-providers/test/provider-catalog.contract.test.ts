/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof, unicorn/no-useless-fallback-in-spread -- SAFETY: this executable pact test narrows controlled JSON fixtures at the contract boundary and preserves optional-field omission semantics. */

/**
 * Executable contract test for `contracts/pacts/provider-catalog.pact.json`.
 *
 * `architecture:guard` only proves that pact file exists and is shaped like a
 * pact. A pact nobody runs is documentation wearing a test's clothes: it can
 * drift arbitrarily far from the code it claims to describe while every gate
 * stays green. This file closes that hole for the provider -> composition
 * catalog hand-off.
 *
 * The pact is the *input*, not the inspiration. Every assertion below reads the
 * JSON at runtime and drives the real code — `awsYardSpec()`/`azureYardSpec()`
 * and friends, `aws.Yard()`/`azure.Yard()`, and `composeYard` — against the
 * interaction's own request and response bodies. Nothing here restates an
 * expectation the file does not carry, because a second copy of an expectation
 * drifts exactly as silently as no copy at all.
 *
 * These are not HTTP services; the pact describes a logical boundary, so
 * requests cannot be replayed over a transport. Each interaction is therefore
 * mapped to a real call **by its `description`**, and the final test refuses
 * any interaction in the file that has no mapped assertion. That guard is the
 * load-bearing line: an unmapped interaction is precisely the drift this file
 * exists to catch.
 *
 * Determinism: no clock, no randomness, no network, no environment reads —
 * every provider catalog is a pure function of its options.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { awsYardSpec } from "@hobo/provider-aws";
import { azureYardSpec } from "@hobo/provider-azure";
import { cloudflareYardSpec } from "@hobo/provider-cloudflare";
import { digitaloceanYardSpec } from "@hobo/provider-digitalocean";
import { gcpYardSpec } from "@hobo/provider-gcp";
import { hetznerYardSpec } from "@hobo/provider-hetzner";
import { hostingerYardSpec } from "@hobo/provider-hostinger";
import { kubernetesYardSpec } from "@hobo/provider-kubernetes";
import { vercelYardSpec } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";

import {
	aws,
	azure,
	type CatalogRow,
	cloudflare,
	composeYard,
	digitalocean,
	gcp,
	hetzner,
	hostinger,
	kubernetes,
	vercel,
	type YardSpecLike,
} from "../src/index.js";

interface PactInteraction {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body?: Record<string, unknown>;
	};
	readonly response: {
		readonly status: number;
		readonly body: Record<string, unknown>;
	};
}

interface PactFile {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactInteraction[];
}

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"pacts",
	"provider-catalog.pact.json",
);
const pact = JSON.parse(readFileSync(pactPath, "utf8")) as PactFile;

/**
 * Every provider this package composes, paired with the `*YardSpec()` the
 * provider package publishes. The pact names providers by id in its bodies, so
 * this map is how a body resolves to real code.
 */
const PROVIDERS: Readonly<
	Record<
		string,
		{
			readonly Yard: () => { readonly bindings: readonly CatalogRow[] };
			readonly spec: () => YardSpecLike;
		}
	>
> = {
	aws: { Yard: () => aws.Yard(), spec: () => awsYardSpec() },
	azure: { Yard: () => azure.Yard(), spec: () => azureYardSpec() },
	cloudflare: {
		Yard: () => cloudflare.Yard(),
		spec: () => cloudflareYardSpec(),
	},
	digitalocean: {
		Yard: () => digitalocean.Yard(),
		spec: () => digitaloceanYardSpec(),
	},
	gcp: { Yard: () => gcp.Yard(), spec: () => gcpYardSpec() },
	hetzner: { Yard: () => hetzner.Yard(), spec: () => hetznerYardSpec() },
	hostinger: {
		Yard: () => hostinger.Yard(),
		spec: () => hostingerYardSpec(),
	},
	kubernetes: {
		Yard: () => kubernetes.Yard(),
		spec: () => kubernetesYardSpec(),
	},
	vercel: { Yard: () => vercel.Yard(), spec: () => vercelYardSpec() },
};

/** The ordering the pact names: `(profile, productId, connectivityId)`. */
function compareRows(a: CatalogRow, b: CatalogRow): number {
	const fields = ["profile", "productId", "connectivityId"] as const;
	for (const field of fields) {
		const left = a[field] ?? "";
		const right = b[field] ?? "";
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

/** Identity plus realization parameters — the row shape the pact pins. */
function normalizeRow(row: CatalogRow): Record<string, unknown> {
	return {
		profile: row.profile,
		...(row.productId !== undefined ? { productId: row.productId } : {}),
		...(row.connectivityId !== undefined
			? { connectivityId: row.connectivityId }
			: {}),
		properties: { ...(row.properties ?? {}) },
	};
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
		assertions(matches[0] as PactInteraction);
	});
}

describe("provider-catalog pact (consumer: @hobo/cloud-providers)", () => {
	it("is the pact this package publishes", () => {
		expect(pact.consumer.name).toBe("@hobo/cloud-providers");
		expect(pact.provider.name).toBe("@hobo/provider-*");
	});

	contract(
		"a provider publishes its allocatable catalog as flat rows sorted by (profile, productId, connectivityId)",
		(interaction) => {
			const body = interaction.response.body as {
				provider: string;
				regions: readonly string[];
				bindings: readonly CatalogRow[];
			};
			expect(interaction.request.method).toBe("GET");
			expect(interaction.response.status).toBe(200);
			expect(interaction.request.path).toContain(
				`/providers/${body.provider}/`,
			);

			const named = PROVIDERS[body.provider];
			expect(
				named,
				`pact pins provider "${body.provider}", which this package does not compose`,
			).toBeDefined();
			if (named === undefined) return;

			// The published spec is what the interaction describes.
			const spec = named.spec();
			expect(spec.provider).toBe(body.provider);
			expect([...spec.regions]).toEqual([...body.regions]);

			// The sortedness claim is about "a provider", so hold every one of
			// them to it — at publish time and after the parse into a Yard.
			for (const [providerId, provider] of Object.entries(PROVIDERS)) {
				const published = [...provider.spec().bindings];
				expect(
					published.map(normalizeRow),
					`${providerId} publishes rows out of (profile, productId, connectivityId) order`,
				).toEqual([...published].sort(compareRows).map(normalizeRow));
				const parsed = [...provider.Yard().bindings];
				expect(
					parsed.map(normalizeRow),
					`${providerId} rows lose their order through composition`,
				).toEqual([...parsed].sort(compareRows).map(normalizeRow));
			}

			// Every row the pact pins is really published, in the pinned order.
			const published = spec.bindings;
			const positions = body.bindings.map((pinned) => {
				const index = published.findIndex(
					(row) => compareRows(row, pinned) === 0,
				);
				expect(
					index,
					`${body.provider} publishes no row ${JSON.stringify(pinned)}`,
				).toBeGreaterThanOrEqual(0);
				if (index >= 0) {
					expect(normalizeRow(published[index] as CatalogRow)).toEqual(
						normalizeRow(pinned),
					);
				}
				return index;
			});
			expect(positions, "pinned rows are listed out of catalog order").toEqual(
				[...positions].sort((a, b) => a - b),
			);
		},
	);

	contract(
		"several offerings per capability is the normal case: a catalog is what CAN be allocated, never a selection",
		(interaction) => {
			const body = interaction.response.body as {
				provider: string;
				profile: string;
				count: number;
				productIds: readonly string[];
			};
			expect(interaction.request.path).toContain(`profile=${body.profile}`);

			const named = PROVIDERS[body.provider];
			expect(
				named,
				`pact pins unknown provider "${body.provider}"`,
			).toBeDefined();
			if (named === undefined) return;

			const rows = named
				.Yard()
				.bindings.filter((row) => row.profile === body.profile);
			const productIds = [
				...new Set(
					rows
						.map((row) => row.productId)
						.filter((id): id is string => id !== undefined),
				),
			].sort();

			expect(productIds).toEqual([...body.productIds]);
			expect(productIds.length).toBe(body.count);
			// Each pinned product id is a distinct row: the catalog holds the
			// breadth, it does not collapse it into a pick.
			expect(rows.length).toBe(body.count);
			// The claim the interaction is named for.
			expect(
				body.count,
				"the interaction claims several offerings per capability",
			).toBeGreaterThan(1);
		},
	);

	contract(
		"composition parses a published catalog into a Yard without narrowing it",
		(interaction) => {
			const request = interaction.request.body as {
				name: string;
				spec: YardSpecLike;
			};
			const expected = interaction.response.body as {
				kind: string;
				name: string;
				providerId: string;
				regions: readonly string[];
				bindings: readonly Record<string, unknown>[];
			};

			const built = composeYard(request.name, request.spec);
			expect(interaction.response.status).toBe(200);
			expect(built.kind).toBe(expected.kind);
			expect(built.name).toBe(expected.name);
			expect(built.providerId).toBe(expected.providerId);
			expect([...built.regions]).toEqual([...expected.regions]);
			expect(built.bindings.map((row) => ({ ...row }))).toEqual([
				...expected.bindings,
			]);

			// "Without narrowing it": rows in equals rows out, for the pact's own
			// spec and for every real provider catalog this package composes.
			expect(built.bindings.length).toBe(request.spec.bindings.length);
			for (const [providerId, provider] of Object.entries(PROVIDERS)) {
				expect(
					provider.Yard().bindings.length,
					`${providerId} lost catalog rows during composition`,
				).toBe(provider.spec().bindings.length);
			}
		},
	);

	for (const description of [
		"refusal: a published row that constrains neither productId nor connectivityId is rejected, never silently kept",
		"refusal: a credential-shaped property on a published row is rejected at the parse boundary",
		"refusal: a duplicate (profile, productId, connectivityId) triple is rejected — rows are a set, not a list",
	]) {
		contract(description, (interaction) => {
			const request = interaction.request.body as {
				name: string;
				spec: YardSpecLike;
			};
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
				composeYard(request.name, request.spec);
			} catch (error) {
				thrown = error;
			}
			expect(
				thrown,
				`composeYard accepted a spec the pact says it refuses with ${expected.code}`,
			).toBeInstanceOf(Error);
			expect((thrown as { code?: string }).code).toBe(expected.code);
			// `remediation` is pact prose: `YardBindingError` carries a code and a
			// message, not a remediation field, so this holds the pact to stating
			// one — it cannot hold the code to emitting it.
			expect(typeof expected.remediation).toBe("string");
			expect(expected.remediation.length).toBeGreaterThan(0);
		});
	}

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
