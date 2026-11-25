/**
 * Parsing Kubernetes memory quantities, and refusing the ones that are not.
 *
 * `placement.test.ts` pins the two suffixes that matter most (`Mi` vs `M`) and
 * one malformed string. This covers the rest of the surface, which is mostly
 * refusals — and refusals are the interesting half here, because every one of
 * them is a value that would otherwise reach a cluster.
 *
 * **The two suffix families are genuinely different, and both are real.** `1M`
 * is 1,000,000 bytes; `1Mi` is 1,048,576. Kubernetes accepts both, so a parser
 * has to as well, and treating them alike under-provisions by 4.8% at gibibyte
 * scale — a workload that gets OOM-killed under load rather than failing to
 * schedule.
 *
 * **A byte count and a quantity string are both legitimate inputs.** The
 * numeric path exists because manifests and APIs disagree about which they
 * hand over. It has its own refusals: a fraction of a byte is not a memory
 * size, and zero or negative is not a request.
 *
 * **The bounds are a policy, not a sanity check.** They sit outside the parse
 * so a value that is a perfectly well-formed quantity — `1Ki`, `1Ti` — still
 * gets refused for being outside what this placement lane will schedule. That
 * refusal names the range, because the operator's next move is to pick a number
 * inside it.
 */
import { describe, expect, it } from "vitest";

import {
	isKubernetesProviderError,
	parseMemoryBytes,
	parseWorkloadPlacement,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
// The bounds are exported from the module rather than the package index. The
// tests below assert against them rather than against literals, so a policy
// change moves the expectations with it.
import { MAX_MEMORY_BYTES, MIN_MEMORY_BYTES } from "../src/placement.js";

/** The message of the refusal, or a marker when there was none. */
function refusal(value: JsonValue | undefined): string {
	try {
		parseMemoryBytes(value, "memory");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "no-refusal";
}

const MIB = 1024 * 1024;

describe("memory given as a byte count", () => {
	it("takes a whole positive number as bytes", () => {
		// Manifests and APIs disagree about whether memory arrives as a quantity
		// string or a plain count; both are legitimate inputs.
		expect(parseMemoryBytes(64 * MIB, "memory")).toBe(64 * MIB);
	});

	it("refuses a fraction of a byte", () => {
		// Not a memory size. Rounding it silently would make the parsed value
		// disagree with what the manifest said.
		// 64 MiB plus half a byte. `64.5 * MIB` is itself a whole number, so a
		// fixture written that way would prove nothing.
		expect(refusal(64 * MIB + 0.5)).toMatch(/positive whole number of bytes/u);
	});

	it("refuses zero and negative counts", () => {
		// Zero is not a request for memory, and a negative one compares below
		// every limit downstream.
		expect(refusal(0)).toMatch(/positive whole number of bytes/u);
		expect(refusal(-1)).toMatch(/positive whole number of bytes/u);
	});

	it("names the field it was parsing", () => {
		// These are read from several places in a manifest; "memory" alone does
		// not say which.
		expect(() => parseMemoryBytes(0, "limits.memory")).toThrow(
			/limits\.memory/u,
		);
	});
});

describe("the binary suffixes", () => {
	it("reads each power-of-1024 suffix", () => {
		expect(parseMemoryBytes("8192Ki", "memory")).toBe(8192 * 1024);
		expect(parseMemoryBytes("64Mi", "memory")).toBe(64 * MIB);
		expect(parseMemoryBytes("1Gi", "memory")).toBe(1024 * MIB);
		// `Ti` parses too, but every value it can express is above this lane's
		// ceiling, so it is asserted under the bounds below rather than here.
	});
});

describe("the decimal suffixes", () => {
	it("reads each power-of-1000 suffix", () => {
		expect(parseMemoryBytes("64M", "memory")).toBe(64_000_000);
		expect(parseMemoryBytes("1G", "memory")).toBe(1_000_000_000);
		// `T` likewise only expresses values above the ceiling.
	});

	it("accepts both spellings of the kilo suffix", () => {
		// Kubernetes writes `k`; `K` turns up in hand-written manifests. Refusing
		// one would reject a value a cluster accepts.
		expect(parseMemoryBytes("8000k", "memory")).toBe(8_000_000);
		expect(parseMemoryBytes("8000K", "memory")).toBe(8_000_000);
	});

	it("keeps the two families distinct", () => {
		// The whole reason this parser exists rather than a regex and a
		// multiplier: treating them alike under-provisions by 4.8% at gibibyte
		// scale, which shows up as an OOM kill under load.
		expect(parseMemoryBytes("1Gi", "memory")).not.toBe(
			parseMemoryBytes("1G", "memory"),
		);
		expect(parseMemoryBytes("1Gi", "memory")).toBeGreaterThan(
			parseMemoryBytes("1G", "memory"),
		);
	});
});

describe("quantities without a suffix", () => {
	it("reads a bare number of bytes", () => {
		expect(parseMemoryBytes(`${64 * MIB}`, "memory")).toBe(64 * MIB);
	});

	it("tolerates surrounding whitespace", () => {
		// Quantities arrive from YAML, where trailing space is invisible and
		// common.
		expect(parseMemoryBytes("  64Mi  ", "memory")).toBe(64 * MIB);
	});

	it("rounds a fractional quantity to whole bytes", () => {
		// Unlike the numeric path, a fractional *quantity* is well-formed --
		// `0.5Gi` is how people write it -- and it has an exact byte value.
		expect(parseMemoryBytes("0.5Gi", "memory")).toBe(512 * MIB);
	});
});

describe("values that are not quantities at all", () => {
	it("refuses a suffix Kubernetes does not use", () => {
		expect(refusal("64MB")).toMatch(/not a Kubernetes memory quantity/u);
		expect(refusal("64GB")).toMatch(/not a Kubernetes memory quantity/u);
	});

	it("refuses an empty or non-numeric string", () => {
		expect(refusal("")).toMatch(/not a Kubernetes memory quantity/u);
		expect(refusal("lots")).toMatch(/not a Kubernetes memory quantity/u);
	});

	it("refuses a negative quantity string", () => {
		// The pattern admits no sign, so this is malformed rather than
		// out-of-range -- worth pinning, because the two refusals send an
		// operator to different fixes.
		expect(refusal("-64Mi")).toMatch(/not a Kubernetes memory quantity/u);
	});

	it("refuses a value that is neither a string nor a number", () => {
		// The third arm: a manifest that put an object or a list where a quantity
		// belongs gets a refusal naming what was expected.
		for (const value of [null, undefined, true, {}, []]) {
			expect(refusal(value)).toMatch(
				/must be a memory quantity string or a byte count/u,
			);
		}
	});

	it("truncates a long bad value rather than echoing it whole", () => {
		// The refusal carries the offending value for diagnosis; an unbounded
		// echo would put an arbitrary manifest string into an error message.
		const message = refusal("x".repeat(500));
		expect(message.length).toBeLessThan(200);
	});
});

describe("the bounds this lane will schedule", () => {
	it("accepts a value exactly at each bound", () => {
		// Inclusive on both ends -- the published constants are usable values,
		// not exclusive limits.
		expect(parseMemoryBytes(MIN_MEMORY_BYTES, "memory")).toBe(MIN_MEMORY_BYTES);
		expect(parseMemoryBytes(MAX_MEMORY_BYTES, "memory")).toBe(MAX_MEMORY_BYTES);
	});

	it("refuses a well-formed quantity below the floor", () => {
		// `1Ki` parses cleanly and is still not something this lane schedules.
		// The refusal is about policy, not about the format.
		expect(refusal("1Ki")).toMatch(/must be between/u);
		expect(refusal(MIN_MEMORY_BYTES - 1)).toMatch(/must be between/u);
	});

	it("refuses a well-formed quantity above the ceiling", () => {
		// The tera suffixes parse cleanly and are both above this lane's ceiling,
		// so each exercises the parse and the bound in one value.
		expect(refusal("1Ti")).toMatch(/must be between/u);
		expect(refusal("1T")).toMatch(/must be between/u);
		expect(refusal(MAX_MEMORY_BYTES + 1)).toMatch(/must be between/u);
	});

	it("refuses an unknown suffix as malformed rather than out of range", () => {
		// Pi is in neither suffix table, so it never reaches the bound check. The
		// two refusals send an operator to different fixes, so they stay distinct.
		expect(refusal("1Pi")).toMatch(/not a Kubernetes memory quantity/u);
	});

	it("names the range so the operator can pick a value inside it", () => {
		const message = refusal("1Ki");
		expect(message).toContain(String(MIN_MEMORY_BYTES));
		expect(message).toContain(String(MAX_MEMORY_BYTES));
	});
});

describe("naming the kind of a value a placement refused", () => {
	/**
	 * A rejection carries the offending value so an operator can see what was
	 * wrong with it. For a string that means the text (truncated); for anything
	 * else it means the *kind*, because printing an object or an array into an
	 * error message is both unhelpful and a way to spill a whole manifest into a
	 * log line.
	 */
	const VALID = {
		name: "try-site",
		namespace: "hobo-try-site",
		image:
			"ghcr.io/hobo/try-site@sha256:221b467378d5ca6ae498f03408d3b19d3b762bb8b078a99a014b61c33d1f1240",
	};

	/** The `value` detail from the rejection for a placement with this image. */
	function kindOfRefusedImage(image: JsonValue | undefined): string {
		try {
			parseWorkloadPlacement({ ...VALID, image });
		} catch (error) {
			if (!isKubernetesProviderError(error)) throw error;
			return String(error.detail.value);
		}
		throw new Error("expected the placement to be rejected");
	}

	it("names each JSON kind rather than printing the value", () => {
		expect(kindOfRefusedImage(null)).toBe("null");
		expect(kindOfRefusedImage(undefined)).toBe("undefined");
		expect(kindOfRefusedImage([])).toBe("array");
		expect(kindOfRefusedImage(42)).toBe("number");
		expect(kindOfRefusedImage(true)).toBe("boolean");
		expect(kindOfRefusedImage(false)).toBe("boolean");
		expect(kindOfRefusedImage({})).toBe("object");
	});

	it("distinguishes an array from an object", () => {
		// `typeof []` is "object", so a kind function written with typeof alone
		// would report both the same way -- and an array where an image belongs is
		// a different mistake from a nested block.
		expect(kindOfRefusedImage([])).not.toBe(kindOfRefusedImage({}));
	});

	it("shows the text itself when the image is a string", () => {
		// A malformed string is the common case, and the text is what identifies
		// which image was wrong.
		expect(kindOfRefusedImage("nginx")).toBe("nginx");
	});

	it("truncates a very long string rather than echoing it whole", () => {
		expect(kindOfRefusedImage("x".repeat(500)).length).toBeLessThanOrEqual(128);
	});
});
