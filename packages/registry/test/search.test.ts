import { describe, expect, it } from "vitest";

import {
	BUNDLE_MANIFEST_SCHEMA,
	type BundleIndexEntry,
	ingestBundleManifest,
	searchBundles,
	toIndexEntry,
} from "../src/index.js";

function entryOf(
	name: string,
	provider: string,
	ports: string[],
	version = "1.0.0",
): BundleIndexEntry {
	const result = ingestBundleManifest({
		schema: BUNDLE_MANIFEST_SCHEMA,
		name,
		version,
		provider,
		capabilities: ports.map((port) => ({ port, features: [] })),
		description: "",
	});
	if (!result.ok) throw new Error("fixture manifest must parse");
	return toIndexEntry(result.manifest);
}

const entries = [
	entryOf("kv-cache", "cloudflare", ["hobo:kv"]),
	entryOf("kv", "aws", ["hobo:kv"]),
	entryOf("queue-kv-bridge", "aws", ["hobo:kv", "hobo:queue"]),
	entryOf("runner", "cloudflare", ["hobo:runner"]),
];

describe("searchBundles", () => {
	it("matches nothing for an empty query", () => {
		expect(searchBundles(entries, {})).toEqual([]);
	});

	it("ranks exact name above prefix above substring, deterministically", () => {
		const results = searchBundles(entries, { name: "kv" });
		expect(results.map((r) => r.entry.name)).toEqual([
			"kv",
			"kv-cache",
			"queue-kv-bridge",
		]);
		expect(results.map((r) => r.score)).toEqual([100, 60, 30]);
	});

	it("requires every provided criterion to match", () => {
		const results = searchBundles(entries, {
			capability: "hobo:kv",
			provider: "aws",
		});
		expect(results.map((r) => r.entry.name)).toEqual(["kv", "queue-kv-bridge"]);
		expect(results.every((r) => r.score === 40)).toBe(true);
	});

	it("breaks score ties by name in codepoint order", () => {
		const results = searchBundles(entries, { capability: "hobo:kv" });
		expect(results.map((r) => r.entry.name)).toEqual([
			"kv",
			"kv-cache",
			"queue-kv-bridge",
		]);
	});

	it("is stable across repeated runs and input copies", () => {
		const first = searchBundles(entries, { name: "kv", capability: "hobo:kv" });
		const second = searchBundles([...entries].reverse(), {
			name: "kv",
			capability: "hobo:kv",
		});
		expect(second).toEqual(first);
	});

	it("projects sorted deduplicated ports onto the index entry", () => {
		const entry = entryOf("dup", "aws", ["hobo:queue", "hobo:kv", "hobo:kv"]);
		expect(entry.ports).toEqual(["hobo:kv", "hobo:queue"]);
		expect(entry.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});
