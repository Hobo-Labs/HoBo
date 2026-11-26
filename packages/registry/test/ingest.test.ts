/**
 * Cases live in `ingest.cases.jsonl`.
 *
 * One thing stays hand-written: canonical digesting is a claim about *two*
 * calls agreeing, and a case row describes one call.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { bundleManifestDigest, ingestBundleManifest } from "../src/index.js";
import * as ingest from "../src/ingest.js";

const VALID = {
	schema: "hobo.registry.bundle-manifest/v1",
	name: "kv-cache",
	version: "1.0.0",
	provider: "cloudflare",
	capabilities: [
		{ port: "hobo:kv", features: ["ttl"] },
		{ port: "hobo:runner", features: [] },
	],
	description: "KV cache bundle",
};

describeConcern("ingestBundleManifest", {
	subject: () => ingest,
	cases: path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"ingest.cases.jsonl",
	),
	uncovered: {
		bundleManifestDigest:
			"a two-call agreement claim, which a single-call case row cannot express",
	},
});

describe("bundleManifestDigest", () => {
	it("is canonical regardless of capability ordering", () => {
		const reordered = {
			...VALID,
			capabilities: [...VALID.capabilities].reverse(),
		};
		const a = ingestBundleManifest(VALID);
		const b = ingestBundleManifest(reordered);
		if (!a.ok || !b.ok) throw new Error("expected both to parse");
		expect(bundleManifestDigest(a.manifest)).toBe(
			bundleManifestDigest(b.manifest),
		);
	});
});
