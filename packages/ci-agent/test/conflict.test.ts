import { describe, expect, it } from "vitest";
import {
	ConflictParseError,
	composeMerged,
	fitRegionResolution,
	markerSizeFor,
	parseMergeSegments,
	regionContext,
	regionTexts,
} from "../src/conflict.js";

const merged = [
	"one\n",
	"<<<<<<< ours\n",
	"TWO ours\n",
	"||||||| base\n",
	"two\n",
	"=======\n",
	"TWO theirs\n",
	">>>>>>> theirs\n",
	"three\n",
	"four\n",
].join("");

describe("conflict regions", () => {
	it("splits merge output into settled text and regions, and rebuilds it", () => {
		const segments = parseMergeSegments(merged, 7);
		expect(segments).toEqual([
			{ kind: "text", text: "one\n" },
			{
				kind: "conflict",
				id: 0,
				ours: "TWO ours\n",
				base: "two\n",
				theirs: "TWO theirs\n",
			},
			{ kind: "text", text: "three\nfour\n" },
		]);
		expect(composeMerged(segments, new Map([[0, "TWO both\n"]]))).toBe(
			"one\nTWO both\nthree\nfour\n",
		);
		expect(() => composeMerged(segments, new Map())).toThrow(/unresolved/);
	});

	it("gives an engine only the nearest settled lines as context", () => {
		const segments = parseMergeSegments(merged, 7);
		expect(regionContext(segments, 1, 1)).toEqual({
			before: "one\n",
			after: "three\n",
		});
		expect(regionContext(segments, 1, 0)).toEqual({ before: "", after: "" });
	});

	it("picks a marker length no line of the file can imitate", () => {
		const setext = "Title\n=======\n";
		const quoted = "<<<<<<< not a marker\n>>>>>>>>> nine\n";
		expect(markerSizeFor(["plain\n"])).toBe(7);
		expect(markerSizeFor([setext, quoted])).toBe(10);
		// With the longer marker, the file's own seven-character lines are content.
		const size = 10;
		const output = `${quoted}${"<".repeat(size)} ours\na\n${"|".repeat(size)} base\n${"=".repeat(size)}\nb\n${">".repeat(size)} theirs\n${setext}`;
		const segments = parseMergeSegments(output, size);
		expect(segments.map((segment) => segment.kind)).toEqual([
			"text",
			"conflict",
			"text",
		]);
		expect(segments[0]).toEqual({ kind: "text", text: quoted });
	});

	it("refuses markers that are out of order or left open", () => {
		expect(() => parseMergeSegments("=======\n", 7)).toThrow(
			ConflictParseError,
		);
		expect(() => parseMergeSegments("<<<<<<< ours\na\n", 7)).toThrow(
			ConflictParseError,
		);
		expect(() =>
			parseMergeSegments("<<<<<<< ours\na\n>>>>>>> theirs\n", 7),
		).toThrow(ConflictParseError);
	});

	it("keeps CRLF files CRLF and restores a final newline", () => {
		const [region] = parseMergeSegments(
			"<<<<<<< ours\r\na\r\n||||||| base\r\n=======\r\nb\r\n>>>>>>> theirs\r\n",
			7,
		);
		if (region?.kind !== "conflict") throw new Error("expected a region");
		expect(fitRegionResolution(region, "a\nb")).toEqual({ text: "a\r\nb\r\n" });
	});

	it("refuses a replacement that carries markers or is far larger than the region", () => {
		const [region] = parseMergeSegments(
			"<<<<<<< ours\na\n||||||| base\n=======\nb\n>>>>>>> theirs\n",
			7,
		);
		if (region?.kind !== "conflict") throw new Error("expected a region");
		expect(fitRegionResolution(region, "a\n<<<<<<< ours\nb\n")).toEqual({
			refusal: "conflict-marker",
		});
		expect(fitRegionResolution(region, "x".repeat(5000))).toEqual({
			refusal: "oversized-resolution",
		});
		// A setext underline is ordinary content, not a marker.
		expect(fitRegionResolution(region, "Title\n=======\n")).toEqual({
			text: "Title\n=======\n",
		});
	});

	it("refuses a replacement that repeats the settled line next to its region", () => {
		// zdiff3 moved the line both sides share out of the region.
		const segments = parseMergeSegments(
			"type P = {\n\tamount: number;\n<<<<<<< ours\n\tcurrency: string;\n||||||| base\n=======\n\tdiscount?: number;\n>>>>>>> theirs\n};\n",
			7,
		);
		const region = segments[1];
		if (region?.kind !== "conflict") throw new Error("expected a region");
		const context = {
			before: "type P = {\n\tamount: number;\n",
			after: "};\n",
		};
		const fit = (text: string) => fitRegionResolution(region, text, context);
		expect(
			fit("\tamount: number;\n\tcurrency: string;\n\tdiscount?: number;\n"),
		).toEqual({ refusal: "repeated-context" });
		expect(fit("\tcurrency: string;\n\tdiscount?: number;\n};\n")).toEqual({
			refusal: "repeated-context",
		});
		expect(fit("\tcurrency: string;\n\tdiscount?: number;\n")).toEqual({
			text: "\tcurrency: string;\n\tdiscount?: number;\n",
		});
		// A line one side itself starts with is that side's, not a repeat.
		const [own] = parseMergeSegments(
			"<<<<<<< ours\n}\nx\n||||||| base\n=======\ny\n>>>>>>> theirs\n",
			7,
		);
		if (own?.kind !== "conflict") throw new Error("expected a region");
		expect(
			fitRegionResolution(own, "}\nx\ny\n", { before: "}\n", after: "" }),
		).toEqual({ text: "}\nx\ny\n" });
	});

	it("recovers the text a committed file put in each region", () => {
		const segments = parseMergeSegments(merged, 7);
		expect(regionTexts(segments, "one\nTWO both\nthree\nfour\n")).toEqual(
			new Map([[0, "TWO both\n"]]),
		);
		// An empty resolution, and a file whose settled text changed since.
		expect(regionTexts(segments, "one\nthree\nfour\n")).toEqual(
			new Map([[0, ""]]),
		);
		expect(regionTexts(segments, "ONE\nTWO\nthree\nfour\n")).toBeUndefined();
		expect(
			regionTexts(segments, "one\nTWO\nthree\nfour\nextra\n"),
		).toBeUndefined();
	});
});
