/**
 * Atom metadata (`atoms/<id>/meta.json`) is read from disk and parsed into a
 * pattern manifest. These tests pin which values count: a field is a string
 * only when it is a primitive string, so a boxed `String` or an object that
 * spoofs its `Symbol.toStringTag` is treated as absent, as before.
 */
import { describe, expect, it } from "vitest";

import { parseAtomAsPattern } from "../src/atoms.js";
import { PatternParseError } from "../src/index.js";

const FILE = { path: "src/app.ts", from: "body/app.ts" };

function parse<T>(meta: T) {
	return parseAtomAsPattern(meta, "atoms/probe/meta.json");
}

function refusal<T>(meta: T): string {
	try {
		parse(meta);
	} catch (error) {
		if (error instanceof PatternParseError) return error.message;
		throw error;
	}
	throw new Error("expected a PatternParseError");
}

const spoofedString = { [Symbol.toStringTag]: "String" };

describe("parseAtomAsPattern", () => {
	it("parses a well-formed atom", () => {
		const manifest = parse({
			id: "probe.atom",
			kind: "http",
			tags: ["api", 7],
			queries: ["probe query"],
			files: [FILE],
			params: {
				required: ["name"],
				properties: { name: {}, label: { default: "hello" } },
			},
		});
		expect(manifest.id).toBe("probe.atom");
		expect(manifest.renderings.map((item) => item.renderingId)).toEqual([
			"src/app.ts",
		]);
		expect(manifest.aliases).toEqual(["probe.atom", "probe query"]);
		expect(manifest.parameters.map((item) => item.name)).toEqual([
			"name",
			"label",
		]);
	});

	it("does not resolve prototype keys as kind or tag features", () => {
		for (const meta of [
			{ id: "probe.atom", kind: "constructor", files: [FILE] },
			{ id: "probe.atom", kind: "__proto__", files: [FILE] },
			{
				id: "probe.atom",
				kind: "http",
				tags: ["toString", "constructor", "__proto__"],
				files: [FILE],
			},
		]) {
			const manifest = parse(meta);
			expect(manifest.features.map((item) => item.id)).toEqual([
				meta.kind === "http" ? "authoring-resource:api" : "artifact:starter",
			]);
		}
	});

	it("refuses metadata that is not an object", () => {
		for (const meta of [null, "probe", 7]) {
			expect(refusal(meta)).toBe("atom meta must be an object");
		}
	});

	it("refuses a top-level array as not an object", () => {
		expect(refusal([FILE])).toBe("atom meta must be an object");
	});

	it("does not take a boxed String or a spoofed tag as the id", () => {
		expect(refusal({ id: new String("probe.atom"), files: [FILE] })).toBe(
			"atom id is required",
		);
		expect(refusal({ id: spoofedString, files: [FILE] })).toBe(
			"atom id is required",
		);
	});

	it("needs at least one file", () => {
		expect(refusal({ id: "probe.atom", files: [] })).toBe(
			"probe.atom: atom needs at least one file",
		);
	});

	it("refuses a file entry that is not an object", () => {
		expect(refusal({ id: "probe.atom", files: ["src/app.ts"] })).toBe(
			"probe.atom: invalid file entry",
		);
	});

	it("refuses a file entry whose path or from is not a primitive string", () => {
		expect(
			refusal({
				id: "probe.atom",
				files: [{ path: new String("src/app.ts"), from: "body/app.ts" }],
			}),
		).toBe("probe.atom: file needs path and from");
	});

	it("refuses an array file entry as not an object", () => {
		expect(refusal({ id: "probe.atom", files: [["src/app.ts"]] })).toBe(
			"probe.atom: invalid file entry",
		);
	});

	it("falls back to the default label when a param default is not a primitive string", () => {
		const manifest = parse({
			id: "probe.atom",
			files: [FILE],
			params: { properties: { label: { default: new String("x") } } },
		});
		expect(manifest.parameters[0]?.defaultWire).toBe("");
	});
});
