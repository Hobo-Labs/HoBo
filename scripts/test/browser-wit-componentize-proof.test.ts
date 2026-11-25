import { describe, expect, it } from "vitest";

import { parseBrowserWitComponentizeProof } from "../lib/browser-wit-componentize-proof.mts";

const DIGEST =
	"sha256:0000000000000000000000000000000000000000000000000000000000000000" as const;

describe("parseBrowserWitComponentizeProof", () => {
	it("accepts a finished proof under the workspace cache", () => {
		const proof = parseBrowserWitComponentizeProof(
			JSON.stringify({
				workRoot: "/repo/.cache/browser-wit-componentize/work-abc",
				componentDigest: DIGEST,
				finishedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		expect(proof.componentDigest).toBe(DIGEST);
	});

	it("rejects proof without finished componentize", () => {
		expect(() =>
			parseBrowserWitComponentizeProof(
				JSON.stringify({
					workRoot: "/repo/.cache/browser-wit-componentize/work-abc",
					componentDigest: DIGEST,
				}),
			),
		).toThrow(/finishedAt/);
	});
});
