import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactRefSchema, FreightSubject } from "../../src/_generated/cd_pb.js";
import { FREIGHT_MANIFEST_SCHEMA } from "../../src/events.js";
import {
	ALIAS_ADJECTIVES,
	ALIAS_NOUNS,
	FREIGHT_REASON,
	FreightManifestError,
	freightAlias,
	freightIdentity,
	parseFreightManifest,
	writeFreightManifest,
} from "../../src/freight/index.js";
import { artifact, manifest } from "./builders.js";
import { digestOf } from "./fakes.js";

function parsed(input: Parameters<typeof parseFreightManifest>[0]) {
	const outcome = parseFreightManifest(input);
	if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
	return outcome.value;
}

function codes(input: Parameters<typeof parseFreightManifest>[0]): string[] {
	const outcome = parseFreightManifest(input);
	return outcome.ok ? [] : outcome.reasons.map((reason) => reason.code);
}

describe("Freight identity (D2)", () => {
	it("identical manifests give identical ids and aliases", () => {
		const a = freightIdentity(parsed(manifest()));
		const b = freightIdentity(parsed(manifest()));
		expect(a).toEqual(b);
		expect(a.freightId).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(a.alias).toMatch(/^[a-z]+-[a-z]+$/);
		expect(freightAlias(a.freightId)).toBe(a.alias);
	});

	it("alias word lists are unique lowercase words and malformed ids are rejected", () => {
		for (const list of [ALIAS_ADJECTIVES, ALIAS_NOUNS]) {
			expect(new Set(list).size).toBe(list.length);
			expect(list.length).toBeGreaterThanOrEqual(250);
			for (const word of list) expect(word).toMatch(/^[a-z]+$/);
		}
		expect(() => freightAlias("sha256:xyz")).toThrow(TypeError);
	});

	it("artifact order, coordinates, labels, source and provenance do not change the id", () => {
		const base = freightIdentity(parsed(manifest()));
		const reordered = freightIdentity(parsed(manifest({ artifacts: [artifact("web"), artifact("api")] })));
		const mirrored = freightIdentity(
			parsed(
				manifest({
					artifacts: [artifact("api", "api", "oci://mirror.local/api"), artifact("web", "web", "oci://mirror.local/web")],
					labels: { other: "x" },
					provenance: [],
				}),
			),
		);
		expect(reordered.freightId).toBe(base.freightId);
		expect(mirrored.freightId).toBe(base.freightId);
	});

	it("a config-only change (new declaration hash, same artifacts) is new Freight", () => {
		const base = freightIdentity(parsed(manifest()));
		const config = freightIdentity(parsed(manifest({ declarationHash: digestOf("shop-declaration-v2") })));
		expect(config.freightId).not.toBe(base.freightId);
	});

	it("different artifact bytes give a different id", () => {
		const base = freightIdentity(parsed(manifest()));
		const rebuilt = freightIdentity(parsed(manifest({ artifacts: [artifact("api", "api-2"), artifact("web")] })));
		expect(rebuilt.freightId).not.toBe(base.freightId);
	});

	it("UNSPECIFIED subject reads as BINDLE and gives the same id", () => {
		const explicit = freightIdentity(parsed(manifest({ subject: FreightSubject.BINDLE })));
		const implicit = parsed(manifest({ subject: FreightSubject.UNSPECIFIED }));
		expect(implicit.subject).toBe(FreightSubject.BINDLE);
		expect(freightIdentity(implicit).freightId).toBe(explicit.freightId);
	});

	it("a RAIL subject carries no artifacts and is distinct from a Bindle with the same hash", () => {
		const rail = parsed(manifest({ bindle: "rail-eu", subject: FreightSubject.RAIL, artifacts: [], provenance: [] }));
		const bindle = parsed(manifest({ bindle: "rail-eu", artifacts: [], provenance: [] }));
		expect(freightIdentity(rail).freightId).not.toBe(freightIdentity(bindle).freightId);
	});
});

describe("hobo.freight-manifest/v1 parse boundary", () => {
	it("round-trips through writeFreightManifest byte for byte", () => {
		const record = parsed(manifest({ artifacts: [artifact("web"), artifact("api")] }));
		const bytes = writeFreightManifest(record);
		const again = parsed(bytes);
		expect(again).toEqual(record);
		expect(writeFreightManifest(again)).toEqual(bytes);
		const text = new TextDecoder().decode(bytes);
		expect(JSON.parse(text).schemaVersion).toBe(FREIGHT_MANIFEST_SCHEMA);
		expect(text.indexOf('"api"')).toBeLessThan(text.indexOf('"web"'));
	});

	it("parses a JSON string and refuses malformed JSON with a typed reason", () => {
		expect(parsed(new TextDecoder().decode(writeFreightManifest(parsed(manifest())))).bindle).toBe("shop");
		expect(codes("{not json")).toEqual([FREIGHT_REASON.manifestInvalid]);
	});

	it("refuses unknown fields rather than dropping them", () => {
		const text = new TextDecoder().decode(writeFreightManifest(parsed(manifest())));
		const tampered = JSON.stringify({ ...JSON.parse(text), deployNow: true });
		expect(codes(tampered)).toEqual([FREIGHT_REASON.manifestInvalid]);
	});

	it.each([
		["schema version", { schemaVersion: "hobo.freight-manifest/v0" }],
		["bindle", { bindle: "Shop With Spaces" }],
		["declaration hash", { declarationHash: "sha256:abc" }],
	])("refuses an invalid %s with remediation", (_name, overrides) => {
		const outcome = parseFreightManifest(manifest(overrides));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reasons[0]?.code).toBe(FREIGHT_REASON.manifestInvalid);
		expect(outcome.reasons[0]?.remediation).not.toBe("");
	});

	it("refuses malformed digests, unspecified kinds and duplicate names per artifact", () => {
		const bad = manifest({
			artifacts: [
				create(ArtifactRefSchema, { name: "api", kind: ArtifactKind.WASM_COMPONENT, digest: "sha256:XYZ", coordinate: "store://api" }),
				create(ArtifactRefSchema, { name: "web", kind: ArtifactKind.UNSPECIFIED, digest: digestOf("w"), coordinate: "store://web" }),
				artifact("web"),
			],
		});
		const outcome = parseFreightManifest(bad);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reasons.map((reason) => reason.subject)).toEqual(["artifacts[0].digest", "artifacts[1].kind", "artifacts[2].name"]);
	});

	it("refuses a RAIL manifest that carries artifacts", () => {
		expect(codes(manifest({ subject: FreightSubject.RAIL }))).toEqual([FREIGHT_REASON.manifestInvalid]);
	});

	it("refuses credentials in a coordinate or label (secret-free records, I9)", () => {
		expect(codes(manifest({ artifacts: [artifact("api", "api", "https://bot:hunter2@registry.example.com/api")] }))).toEqual([
			FREIGHT_REASON.secretInRecord,
		]);
		expect(codes(manifest({ labels: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }))).toEqual([FREIGHT_REASON.secretInRecord]);
	});

	it("writeFreightManifest throws a typed error carrying the reasons", () => {
		expect(() => writeFreightManifest(manifest({ bindle: "" }))).toThrow(FreightManifestError);
		try {
			writeFreightManifest(manifest({ bindle: "" }));
		} catch (error) {
			expect(error instanceof FreightManifestError && error.reasons[0]?.code).toBe(FREIGHT_REASON.manifestInvalid);
		}
	});
});
