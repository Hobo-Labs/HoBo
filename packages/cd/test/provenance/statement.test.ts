// The statement adapter over @hobo/registry parseProvenanceStatement: SLSA v1
// puts the builder at predicate.runDetails.builder.id.
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/artifacts/json.js";
import { parseStatement } from "../../src/provenance/statement.js";

const encode = (value: JsonValue) =>
	new TextEncoder().encode(JSON.stringify(value));
const encodeText = (text: string) => new TextEncoder().encode(text);
const subject = [{ name: "api.wasm", digest: { sha256: "a".repeat(64) } }];
const base = {
	_type: "https://in-toto.io/Statement/v1",
	subject,
	predicateType: "https://slsa.dev/provenance/v1",
};

describe("provenance statement parsing", () => {
	it("reads the SLSA v1 builder from runDetails.builder.id", () => {
		const parsed = parseStatement(
			encode({
				...base,
				predicate: {
					buildDefinition: {
						buildType: "https://actions.github.io/buildtypes/workflow/v1",
					},
					runDetails: {
						builder: { id: "https://github.com/actions/runner/github-hosted" },
					},
				},
			}),
		);
		expect(parsed.ok && parsed.statement.predicate.builderId).toBe(
			"https://github.com/actions/runner/github-hosted",
		);
	});

	it("still accepts the v0.2 builder location", () => {
		const parsed = parseStatement(
			encode({
				...base,
				predicate: { builder: { id: "https://builder.example/v1" } },
			}),
		);
		expect(parsed.ok && parsed.statement.predicate.builderId).toBe(
			"https://builder.example/v1",
		);
	});

	it("refuses two different builders, non-JSON, and sha512-only subjects", () => {
		expect(
			parseStatement(
				encode({
					...base,
					predicate: {
						builder: { id: "a" },
						runDetails: { builder: { id: "b" } },
					},
				}),
			).ok,
		).toBe(false);
		expect(parseStatement(encodeText("{not json")).ok).toBe(false);
		expect(parseStatement(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
		const sha512 = parseStatement(
			encode({
				...base,
				subject: [{ name: "pkg:npm/x@1", digest: { sha512: "b".repeat(128) } }],
				predicate: { runDetails: { builder: { id: "b" } } },
			}),
		);
		expect(sha512.ok).toBe(false);
		if (!sha512.ok) expect(sha512.detail).toContain("invalid-subject");
	});
});
