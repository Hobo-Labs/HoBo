import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@hobo/data";
import { describe, expect, it } from "vitest";

import {
	aspireFallbackEnv,
	canonicalManifestHash,
	ManifestParseError,
	parseManifest,
	parseManifestReference,
	parseOutputPlaceholder,
	serializeManifest,
} from "../../src/manifest/index.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures/manifests",
);

function readFixture<T = unknown>(...segments: string[]): T {
	// SAFETY: assertion required at this I/O or test boundary.
	return JSON.parse(readFileSync(join(fixturesDir, ...segments), "utf8")) as T;
}

describe("hobo.manifest/v1 loader", () => {
	it("preserves financial policy and effect references through canonical round trips", () => {
		const raw = readFixture<JsonObject>("golden/db-api-site.json");
		const policy = {
			budget: { hardLimitUsd: 100, softLimitUsd: 80, period: "monthly" },
			costAvailabilityProfile: { budgetUsd: 100, availabilitySlo: 0.999 },
			boundaryContracts: ["contract:checkout/writes@v1"],
			resilienceProfileRef: "resilience:production@v1",
		};
		const first = parseManifest({ ...raw, policy });
		const second = parseManifest(JSON.parse(serializeManifest(first)));
		expect(second.value.policy).toEqual(policy);
		expect(canonicalManifestHash(first)).not.toBe(
			canonicalManifestHash(parseManifest(raw)),
		);
		expect(canonicalManifestHash(first)).toBe(canonicalManifestHash(second));
	});

	it("rejects malformed policy rather than erasing a financial declaration", () => {
		const raw = readFixture<JsonObject>("golden/db-api-site.json");
		for (const policy of [null, [], "ignore budget"]) {
			expect(() => parseManifest({ ...raw, policy })).toThrow(
				ManifestParseError,
			);
		}
	});
	it("round-trips the golden manifest through parse and serialize", () => {
		const raw = readFixture("golden/db-api-site.json");
		const first = parseManifest(raw);
		const second = parseManifest(JSON.parse(serializeManifest(first)));

		expect(canonicalManifestHash(first)).toBe(canonicalManifestHash(second));
	});

	it("hashes key-reordered manifests identically", () => {
		const golden = readFixture("golden/db-api-site.json");
		const reordered = {
			resources: {
				site: golden.resources.site,
				api: golden.resources.api,
				db: golden.resources.db,
			},
			componentHost: {
				version: "1.0.0",
				kind: "wasmtime",
			},
			schema: "hobo.manifest/v1",
		};

		expect(canonicalManifestHash(parseManifest(golden))).toBe(
			canonicalManifestHash(parseManifest(reordered)),
		);
	});

	it("lists public discovery env keys only (no ConnectionStrings dual-path)", () => {
		const manifest = parseManifest(readFixture("golden/db-api-site.json"));
		// ADR-0141: golden manifest has no secret-shaped ConnectionStrings__*
		expect(aspireFallbackEnv(manifest)).toEqual({});
		expect(JSON.stringify(manifest.value.resources.api?.env ?? {})).not.toMatch(
			/ConnectionStrings__/,
		);
	});

	it("parses lazy tokens and Humanitec placeholders", () => {
		expect(parseManifestReference("{db.connectionString}")).toEqual({
			resourceId: "db",
			output: "connectionString",
		});

		expect(
			// The placeholder grammar under test is literally this string;
			// interpolating it would assert against an input the parser never sees.
			parseOutputPlaceholder("${resources.data.postgres#db.outputs.url}"),
		).toEqual({
			type: "data",
			className: "postgres",
			resourceId: "db",
			output: "url",
		});

		expect(parseOutputPlaceholder("${context.environment}")).toEqual({
			contextPath: "environment",
		});
	});

	const invalidCases: Array<{ file: string; path: string }> = [
		{ file: "missing-port.json", path: "resources.db.port" },
		{ file: "unknown-resource-type.json", path: "resources.db.type" },
		{ file: "missing-component-host.json", path: "componentHost" },
		{ file: "empty-resources.json", path: "resources" },
		{ file: "bad-resource-id.json", path: "resources.9bad" },
		{
			file: "dangling-token.json",
			path: "resources.api.env.SERVICE_REF",
		},
		{
			file: "dangling-link-import.json",
			path: "resources.api.links[0].import",
		},
		{ file: "unknown-bind-target.json", path: "resources.site.bind" },
		{
			file: "invalid-placeholder.json",
			path: "resources.api.env.BAD_REF",
		},
		{ file: "allow-not-strings.json", path: "resources.db.allow" },
	];

	it.each(invalidCases)("rejects invalid fixture %s at %s", ({
		file,
		path,
	}) => {
		const raw = readFixture("invalid", file);
		expect(() => parseManifest(raw)).toThrow(ManifestParseError);
		try {
			parseManifest(raw);
		} catch (error) {
			expect(error).toBeInstanceOf(ManifestParseError);
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as ManifestParseError).path).toBe(path);
		}
	});
});
