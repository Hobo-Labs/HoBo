/**
 * The schema is the contract, so something has to make it fail.
 *
 * A `.proto` and a `.cue` that nothing reads are documentation that rots. This
 * suite reads both files as text and checks them against the wire form the
 * code actually emits:
 *
 *   - every message's field names equal the keys `src/wire.ts` produces;
 *   - every field CUE marks optional (`?:`) is exactly a field that is absent
 *     from a minimal encoding and present in a maximal one;
 *   - every such field is given explicit presence in proto3 — `optional` for a
 *     scalar, a `StringList` wrapper for a repeated field — because a bare
 *     `repeated` cannot distinguish absent from empty, and test/round-trip
 *     shows that distinction moving a digest twelve golden offers carry.
 *
 * The TypeScript side is *derived*, never listed by hand: it comes from
 * encoding real values and reading their keys. A hand-written list would drift
 * with the code it was supposed to be checking.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCapabilityRequirement } from "../src/requirement.js";
import { STANDARD_CAPABILITY_PROFILES } from "../src/standard-profiles.js";
import {
	toCapabilityProfileCatalogWire,
	toCapabilityProfileDescriptorWire,
	toCapabilityRequirementWire,
} from "../src/wire.js";

const dataModel = (name: string): string =>
	readFileSync(
		fileURLToPath(new URL(`../data-models/${name}`, import.meta.url)),
		"utf8",
	);

const PROTO_TEXT = [
	dataModel("capability_requirement.proto"),
	dataModel("capability_profile.proto"),
].join("\n");
const CUE_TEXT = [
	dataModel("capability_requirement.cue"),
	dataModel("capability_profile.cue"),
].join("\n");

type ProtoField = {
	readonly name: string;
	readonly type: string;
	readonly label: "single" | "optional" | "repeated";
};

/**
 * Field names, types and labels per message. `oneof` members are flattened
 * into their enclosing message, which is what proto3 JSON does too.
 */
function parseProtoMessages(
	text: string,
): ReadonlyMap<string, readonly ProtoField[]> {
	const messages = new Map<string, ProtoField[]>();
	const stack: string[] = [];
	let current: string | undefined;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		const message = /^message\s+(\w+)\s*\{$/u.exec(line);
		if (message) {
			current = message[1] as string;
			messages.set(current, []);
			stack.push("message");
			continue;
		}
		if (/^oneof\s+\w+\s*\{$/u.test(line)) {
			stack.push("oneof");
			continue;
		}
		if (line === "}") {
			const popped = stack.pop();
			if (popped === "message") current = undefined;
			continue;
		}
		const field =
			/^(optional\s+|repeated\s+)?([A-Za-z_][\w.]*)\s+([a-z_]\w*)\s*=\s*\d+\s*;/u.exec(
				line,
			);
		if (!field || current === undefined) continue;
		const prefix = (field[1] ?? "").trim();
		messages.get(current)?.push({
			name: field[3] as string,
			type: field[2] as string,
			label:
				prefix === "optional"
					? "optional"
					: prefix === "repeated"
						? "repeated"
						: "single",
		});
	}
	return messages;
}

type CueField = { readonly name: string; readonly optional: boolean };

/** Field names and `?` markers per `#Definition`. Ignores `_`-prefixed constraints. */
function parseCueDefinitions(
	text: string,
): ReadonlyMap<string, readonly CueField[]> {
	const definitions = new Map<string, CueField[]>();
	let current: string | undefined;
	for (const rawLine of text.split("\n")) {
		const open = /^#(\w+):\s*\{$/u.exec(rawLine);
		if (open) {
			current = open[1] as string;
			definitions.set(current, []);
			continue;
		}
		if (rawLine === "}") {
			current = undefined;
			continue;
		}
		if (current === undefined) continue;
		const field = /^\t([a-z]\w*)(\??):/u.exec(rawLine);
		if (!field) continue;
		definitions.get(current)?.push({
			name: field[1] as string,
			optional: field[2] === "?",
		});
	}
	return definitions;
}

const PROTO = parseProtoMessages(PROTO_TEXT);
const CUE = parseCueDefinitions(CUE_TEXT);

/** A requirement populating every optional field. */
const MAXIMAL_REQUIREMENT = toCapabilityRequirementWire(
	parseCapabilityRequirement({
		requiredProfiles: [{ profileId: "data.postgres/v1", versionRange: ">=16" }],
		preferredProfiles: [{ profileId: "data.vector.pgvector/v1", weight: 2 }],
		prohibitedProfiles: [{ profileId: "data.sqlite/v1" }],
		runtime: { required: "oci", allowed: ["oci"], preferred: ["oci"] },
		realization: { allowNative: true, allowPack: true, allowBridge: true },
		features: [
			{
				key: "extensions",
				operator: "includes-all",
				value: ["pgvector"],
				necessity: "required",
			},
		],
		guarantees: [{ key: "tls", operator: "equals", value: true }],
		portability: { requireStandardBinding: true },
		trustRef: "trust/postgres-v1",
	}),
);

/** The same shape with every optional field absent. */
const MINIMAL_REQUIREMENT = toCapabilityRequirementWire(
	parseCapabilityRequirement({
		requiredProfiles: [{ profileId: "data.postgres/v1" }],
		preferredProfiles: [{ profileId: "data.vector.pgvector/v1", weight: 2 }],
		prohibitedProfiles: [{ profileId: "data.sqlite/v1" }],
		features: [
			{
				key: "extensions",
				operator: "includes-all",
				value: ["pgvector"],
				necessity: "required",
			},
		],
		guarantees: [{ key: "tls", operator: "equals", value: true }],
	}),
);

/**
 * A descriptor populating `conflicts_with`, `requires`, `enum_values` and a
 * source-ref `note` — none of which any first-party profile uses, which is
 * precisely why they need a maximal case built here.
 */
const MAXIMAL_DESCRIPTOR = toCapabilityProfileDescriptorWire({
	schemaVersion: "hobo.capability-profile/v1",
	id: "data.vector.pgvector/v1",
	primitive: "data",
	displayName: "pgvector",
	description: "Vector search through the PostgreSQL pgvector extension.",
	refines: ["data.vector/v1"],
	conflictsWith: ["data.sqlite/v1"],
	requires: ["data.postgres/v1"],
	requirementSchemaRef: "hobo.capability-requirement/data-vector-pgvector-v1",
	conformanceSuiteRef: "conformance.data.vector.pgvector/v1",
	features: [
		{
			key: "indexKind",
			description: "Index algorithm.",
			valueKind: "enum",
			enumValues: ["hnsw", "ivfflat"],
		},
	],
	guarantees: [
		{
			key: "distanceMetric",
			description: "Supported distance metric.",
			valueKind: "enum",
			enumValues: ["cosine", "l2"],
		},
	],
	maturity: "preview",
	sourceRefs: [
		{
			url: "https://github.com/pgvector/pgvector",
			checkedAt: "2026-08-08",
			note: "the extension's own documentation",
		},
	],
});

/**
 * `kv.redis-compatible/v1` is the catalog's minimal descriptor: it declares
 * features and guarantees (so those nodes exist to check) while omitting
 * `conflictsWith`, `requires`, every `enumValues`, and — unlike the profiles
 * that cite `hoboSource(...)` — the source-ref `note`. The assertion below
 * pins that, so a catalog edit that adds a note there fails with an
 * explanation instead of quietly making this suite check less.
 */
const MINIMAL_DESCRIPTOR_ID = "kv.redis-compatible/v1";

const MINIMAL_DESCRIPTOR = toCapabilityProfileDescriptorWire(
	STANDARD_CAPABILITY_PROFILES.find(
		(profile) => profile.id === MINIMAL_DESCRIPTOR_ID,
	) as (typeof STANDARD_CAPABILITY_PROFILES)[number],
);

/**
 * Message name -> the encoded node whose keys it must describe.
 *
 * Only the *node selection* is written by hand; the key names come from the
 * encoder. `RequirementValue` is absent here because a oneof node holds one
 * arm at a time and is checked separately.
 */
const MAXIMAL_NODES: Readonly<Record<string, unknown>> = {
	CapabilityRequirement: MAXIMAL_REQUIREMENT,
	ProfileConstraint: MAXIMAL_REQUIREMENT.required_profiles[0],
	WeightedPreference: MAXIMAL_REQUIREMENT.preferred_profiles[0],
	RuntimeRequirement: MAXIMAL_REQUIREMENT.runtime,
	RealizationAllowance: MAXIMAL_REQUIREMENT.realization,
	StructuredFeatureRequirement: MAXIMAL_REQUIREMENT.features[0],
	StructuredGuaranteeRequirement: MAXIMAL_REQUIREMENT.guarantees[0],
	PortabilityRequirement: MAXIMAL_REQUIREMENT.portability,
	StringList: MAXIMAL_DESCRIPTOR.conflicts_with,
	CapabilityProfileDescriptor: MAXIMAL_DESCRIPTOR,
	FeatureDescriptor: MAXIMAL_DESCRIPTOR.features[0],
	GuaranteeDescriptor: MAXIMAL_DESCRIPTOR.guarantees[0],
	EvidenceSourceRef: MAXIMAL_DESCRIPTOR.source_refs[0],
	CapabilityProfileCatalog: toCapabilityProfileCatalogWire([]),
};

const MINIMAL_NODES: Readonly<Record<string, unknown>> = {
	CapabilityRequirement: MINIMAL_REQUIREMENT,
	ProfileConstraint: MINIMAL_REQUIREMENT.required_profiles[0],
	WeightedPreference: MINIMAL_REQUIREMENT.preferred_profiles[0],
	RuntimeRequirement: MINIMAL_REQUIREMENT.runtime,
	RealizationAllowance: MINIMAL_REQUIREMENT.realization,
	StructuredFeatureRequirement: MINIMAL_REQUIREMENT.features[0],
	StructuredGuaranteeRequirement: MINIMAL_REQUIREMENT.guarantees[0],
	PortabilityRequirement: MINIMAL_REQUIREMENT.portability,
	StringList: MAXIMAL_DESCRIPTOR.conflicts_with,
	CapabilityProfileDescriptor: MINIMAL_DESCRIPTOR,
	FeatureDescriptor: MINIMAL_DESCRIPTOR.features[0],
	GuaranteeDescriptor: MINIMAL_DESCRIPTOR.guarantees[0],
	EvidenceSourceRef: MINIMAL_DESCRIPTOR.source_refs[0],
	CapabilityProfileCatalog: toCapabilityProfileCatalogWire([]),
};

const keysOf = (node: unknown): readonly string[] =>
	Object.keys(node as Record<string, unknown>).sort();

describe("the .proto files describe the wire the encoder emits", () => {
	it("still has a genuinely minimal descriptor to contrast against", () => {
		expect(MINIMAL_DESCRIPTOR.id).toBe(MINIMAL_DESCRIPTOR_ID);
		expect(
			[
				"conflicts_with" in MINIMAL_DESCRIPTOR,
				"requires" in MINIMAL_DESCRIPTOR,
				MINIMAL_DESCRIPTOR.features.some((f) => "enum_values" in f),
				MINIMAL_DESCRIPTOR.guarantees.some((g) => "enum_values" in g),
				MINIMAL_DESCRIPTOR.source_refs.some((s) => "note" in s),
			],
			`${MINIMAL_DESCRIPTOR_ID} must omit every optional field, otherwise the optionality checks below compare a maximal encoding against another maximal one`,
		).toEqual([false, false, false, false, false]);
		expect(MINIMAL_DESCRIPTOR.features.length).toBeGreaterThan(0);
		expect(MINIMAL_DESCRIPTOR.guarantees.length).toBeGreaterThan(0);
		expect(MINIMAL_DESCRIPTOR.source_refs.length).toBeGreaterThan(0);
	});

	it("parses both schema files rather than silently finding nothing", () => {
		expect([...PROTO.keys()].sort()).toEqual(
			[...Object.keys(MAXIMAL_NODES), "RequirementValue"].sort(),
		);
	});

	it.each(
		Object.keys(MAXIMAL_NODES),
	)("message %s names exactly the fields the encoder writes", (message) => {
		const declared = (PROTO.get(message) ?? [])
			.map((field) => field.name)
			.sort();
		expect(declared).toEqual(keysOf(MAXIMAL_NODES[message]));
	});

	it("declares every RequirementValue arm the encoder can produce", () => {
		const declared = (PROTO.get("RequirementValue") ?? [])
			.map((field) => field.name)
			.sort();
		expect(declared).toEqual([
			"bool_value",
			"double_value",
			"int_value",
			"string_set_value",
			"string_value",
		]);

		const emitted = new Set<string>();
		for (const value of [true, 1, 1.5, "x", ["x"]] as const) {
			const wire = toCapabilityRequirementWire(
				parseCapabilityRequirement({
					requiredProfiles: [{ profileId: "data.postgres/v1" }],
					features: [
						{
							key: "k",
							operator: "equals",
							value,
							necessity: "required",
						},
					],
				}),
			);
			for (const key of Object.keys(
				wire.features[0]?.value as Record<string, unknown>,
			)) {
				emitted.add(key);
			}
		}
		expect([...emitted].sort()).toEqual(declared);
	});
});

describe("the .cue files describe the same wire, with optionality", () => {
	it("parses definitions for every message", () => {
		for (const message of Object.keys(MAXIMAL_NODES)) {
			expect(CUE.has(message), `#${message} is missing from the CUE`).toBe(
				true,
			);
		}
	});

	it.each(
		Object.keys(MAXIMAL_NODES),
	)("#%s names exactly the fields the encoder writes", (message) => {
		const declared = (CUE.get(message) ?? []).map((field) => field.name).sort();
		expect(declared).toEqual(keysOf(MAXIMAL_NODES[message]));
	});

	it.each(
		Object.keys(MAXIMAL_NODES),
	)("#%s marks optional exactly the fields a minimal encoding omits", (message) => {
		const optionalInCue = (CUE.get(message) ?? [])
			.filter((field) => field.optional)
			.map((field) => field.name)
			.sort();
		const maximal = new Set(keysOf(MAXIMAL_NODES[message]));
		const minimal = new Set(keysOf(MINIMAL_NODES[message]));
		const omittedWhenMinimal = [...maximal]
			.filter((key) => !minimal.has(key))
			.sort();
		expect(optionalInCue).toEqual(omittedWhenMinimal);
	});
});

describe("every optional field is given explicit presence in proto3", () => {
	/**
	 * This is the rule the round-trip failure came from. A field that can be
	 * absent must be `optional` (scalar) or `StringList` (repeated). A bare
	 * `repeated` here would decode absent as empty, which is a different value
	 * and a different digest.
	 */
	it.each(
		Object.keys(MAXIMAL_NODES),
	)("message %s gives presence to every optional field", (message) => {
		const fields = PROTO.get(message) ?? [];
		const optionalNames = new Set(
			(CUE.get(message) ?? [])
				.filter((field) => field.optional)
				.map((field) => field.name),
		);
		const withoutPresence = fields
			.filter((field) => optionalNames.has(field.name))
			.filter(
				(field) => field.label !== "optional" && field.type !== "StringList",
			)
			.map((field) => `${field.label} ${field.type} ${field.name}`);
		expect(
			withoutPresence,
			"these fields can be absent but proto3 cannot tell absent from the zero value for them",
		).toEqual([]);
	});

	it("uses StringList for every repeated field that can be absent", () => {
		const wrapped = [...PROTO.entries()].flatMap(([message, fields]) =>
			fields
				.filter((field) => field.type === "StringList")
				.map((field) => `${message}.${field.name}`),
		);
		expect(wrapped.sort()).toEqual([
			"CapabilityProfileDescriptor.conflicts_with",
			"CapabilityProfileDescriptor.requires",
			"FeatureDescriptor.enum_values",
			"GuaranteeDescriptor.enum_values",
			"RequirementValue.string_set_value",
		]);
	});
});
