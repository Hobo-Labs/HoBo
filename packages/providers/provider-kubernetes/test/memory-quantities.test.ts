import { describe, expect, it } from "vitest";

import {
	isKubernetesProviderError,
	parseMemoryBytes,
	parseWorkloadPlacement,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import { MAX_MEMORY_BYTES, MIN_MEMORY_BYTES } from "../src/placement.js";

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
		expect(parseMemoryBytes(64 * MIB, "memory")).toBe(64 * MIB);
	});

	it("refuses a fraction of a byte", () => {
		expect(refusal(64 * MIB + 0.5)).toMatch(/positive whole number of bytes/u);
	});

	it("refuses zero and negative counts", () => {
		expect(refusal(0)).toMatch(/positive whole number of bytes/u);
		expect(refusal(-1)).toMatch(/positive whole number of bytes/u);
	});

	it("names the field it was parsing", () => {
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
	});
});

describe("the decimal suffixes", () => {
	it("reads each power-of-1000 suffix", () => {
		expect(parseMemoryBytes("64M", "memory")).toBe(64_000_000);
		expect(parseMemoryBytes("1G", "memory")).toBe(1_000_000_000);
	});

	it("accepts both spellings of the kilo suffix", () => {
		expect(parseMemoryBytes("8000k", "memory")).toBe(8_000_000);
		expect(parseMemoryBytes("8000K", "memory")).toBe(8_000_000);
	});

	it("keeps the two families distinct", () => {
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
		expect(parseMemoryBytes("  64Mi  ", "memory")).toBe(64 * MIB);
	});

	it("rounds a fractional quantity to whole bytes", () => {
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
		expect(refusal("-64Mi")).toMatch(/not a Kubernetes memory quantity/u);
	});

	it("refuses a value that is neither a string nor a number", () => {
		for (const value of [null, undefined, true, {}, []]) {
			expect(refusal(value)).toMatch(
				/must be a memory quantity string or a byte count/u,
			);
		}
	});

	it("truncates a long bad value rather than echoing it whole", () => {
		const message = refusal("x".repeat(500));
		expect(message.length).toBeLessThan(200);
	});
});

describe("the bounds this lane will schedule", () => {
	it("accepts a value exactly at each bound", () => {
		expect(parseMemoryBytes(MIN_MEMORY_BYTES, "memory")).toBe(MIN_MEMORY_BYTES);
		expect(parseMemoryBytes(MAX_MEMORY_BYTES, "memory")).toBe(MAX_MEMORY_BYTES);
	});

	it("refuses a well-formed quantity below the floor", () => {
		expect(refusal("1Ki")).toMatch(/must be between/u);
		expect(refusal(MIN_MEMORY_BYTES - 1)).toMatch(/must be between/u);
	});

	it("refuses a well-formed quantity above the ceiling", () => {
		expect(refusal("1Ti")).toMatch(/must be between/u);
		expect(refusal("1T")).toMatch(/must be between/u);
		expect(refusal(MAX_MEMORY_BYTES + 1)).toMatch(/must be between/u);
	});

	it("refuses an unknown suffix as malformed rather than out of range", () => {
		expect(refusal("1Pi")).toMatch(/not a Kubernetes memory quantity/u);
	});

	it("names the range so the operator can pick a value inside it", () => {
		const message = refusal("1Ki");
		expect(message).toContain(String(MIN_MEMORY_BYTES));
		expect(message).toContain(String(MAX_MEMORY_BYTES));
	});
});

describe("naming the kind of a value a placement refused", () => {
	const VALID = {
		name: "try-site",
		namespace: "hobo-try-site",
		image:
			"ghcr.io/hobo/try-site@sha256:221b467378d5ca6ae498f03408d3b19d3b762bb8b078a99a014b61c33d1f1240",
	};

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
		expect(kindOfRefusedImage([])).not.toBe(kindOfRefusedImage({}));
	});

	it("shows the text itself when the image is a string", () => {
		expect(kindOfRefusedImage("nginx")).toBe("nginx");
	});

	it("truncates a very long string rather than echoing it whole", () => {
		expect(kindOfRefusedImage("x".repeat(500)).length).toBeLessThanOrEqual(128);
	});
});
