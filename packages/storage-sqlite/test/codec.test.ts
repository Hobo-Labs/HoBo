import { describe, expect, it } from "vitest";

import {
	decodePayload,
	encodePayload,
	UnsupportedCodecError,
} from "../src/index.js";

describe("payload codecs", () => {
	it("round-trips json-v1", () => {
		const bytes = encodePayload("json-v1", { a: 1, b: "x" });
		expect(decodePayload("json-v1", bytes)).toEqual({ a: 1, b: "x" });
	});

	it("rejects unknown codec", () => {
		expect(() => decodePayload("xml-v9", new Uint8Array())).toThrow(
			UnsupportedCodecError,
		);
	});
});
