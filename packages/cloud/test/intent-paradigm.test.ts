import { type ManifestV1, parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";

import { lowerManifest } from "../src/intent.js";

function manifest(entries: readonly (readonly [string, string])[]): ManifestV1 {
	const resources = Object.fromEntries(
		entries.map(([name, paradigm]) => [
			name,
			{ type: "data.v1", port: "data", paradigm },
		]),
	);
	return parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasmtime", version: "1.0.0" },
		resources,
	});
}

describe("lowering a Bindle's backing resources", () => {
	it("asks for the capability port of each paradigm, not the bare data port", () => {
		const intents = lowerManifest(
			manifest([
				["cache", "key-value"],
				["jobs", "queue"],
				["config", "secret"],
				["journal", "relational"],
				["blobs", "object"],
			]),
		);
		expect(Object.fromEntries(intents.map((i) => [i.name, i.port]))).toEqual({
			blobs: "objectStore",
			cache: "kv",
			config: "secretRef",
			jobs: "queue",
			journal: "database",
		});
	});
});
