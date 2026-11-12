// PACT consumer verification for the hobo.freight-manifest/v1 boundary
// (contracts/freight.pact.json): the real parser and ledger must produce the
// hand-authored responses from the hand-authored requests.
import { toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { FreightOrigin, FreightRecordSchema } from "../src/_generated/cd_pb.js";
import { createFreightLedger, parseFreightManifest, writeFreightManifest } from "../src/freight/index.js";
import { context, MapArtifactVerifier, MemoryEventStore, RecordingTelemetry, TENANT } from "../test/freight/fakes.js";
import pact from "./freight.pact.json" with { type: "json" };

type Interaction = (typeof pact.interactions)[number];

function interaction(description: string): Interaction {
	const found = pact.interactions.find((item) => item.description === description);
	if (!found) throw new Error(`freight Pact interaction missing: ${description}`);
	return found;
}

function bytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

async function record(item: Interaction, tamper: boolean) {
	const request = item.request.contents;
	const artifacts = new MapArtifactVerifier();
	for (const artifact of request.manifest.artifacts) artifacts.register(artifact.coordinate, artifact.digest);
	if (tamper) artifacts.register("store://api", "sha256:0000000000000000000000000000000000000000000000000000000000000000");
	const atMs = Date.parse("at" in request ? request.at : "");
	const ledger = createFreightLedger({
		store: new MemoryEventStore(),
		tenant: TENANT,
		now: () => atMs,
		artifacts,
		telemetry: new RecordingTelemetry(),
	});
	const parsed = parseFreightManifest(bytes(request.manifest));
	if (!parsed.ok) return parsed;
	return ledger.record({ manifest: parsed.value, origin: FreightOrigin.MANIFEST }, context(() => atMs));
}

describe("hobo.freight-manifest/v1 consumer contract", () => {
	it("is a v4 synchronous-message Pact", () => {
		expect(pact.metadata.pactSpecification.version).toBe("4.0.0");
		expect(pact.interactions.every((item) => item.type === "Synchronous/Messages")).toBe(true);
	});

	it("records the document into the expected FreightRecord", async () => {
		const item = interaction("record a hobo.freight-manifest/v1 document whose digests verify");
		const outcome = await record(item, false);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(toJson(FreightRecordSchema, outcome.value)).toEqual(item.response[0]?.contents);
	});

	it("the request document is exactly what writeFreightManifest emits", () => {
		const item = interaction("record a hobo.freight-manifest/v1 document whose digests verify");
		const parsed = parseFreightManifest(bytes(item.request.contents.manifest));
		if (!parsed.ok) throw new Error("pact manifest refused");
		expect(JSON.parse(new TextDecoder().decode(writeFreightManifest(parsed.value)))).toEqual(item.request.contents.manifest);
	});

	it("refuses a digest mismatch with the contracted codes", async () => {
		const item = interaction("refuse a manifest whose artifact digest does not match the bytes at its coordinate");
		const outcome = await record(item, true);
		expect({ ok: outcome.ok, codes: outcome.ok ? [] : outcome.reasons.map((reason) => reason.code) }).toEqual(item.response[0]?.contents);
	});

	it("refuses unknown fields with the contracted code", () => {
		const item = interaction("refuse a manifest with an unknown field instead of dropping it");
		const outcome = parseFreightManifest(bytes(item.request.contents.manifest));
		expect({ ok: outcome.ok, codes: outcome.ok ? [] : outcome.reasons.map((reason) => reason.code) }).toEqual(item.response[0]?.contents);
	});
});
