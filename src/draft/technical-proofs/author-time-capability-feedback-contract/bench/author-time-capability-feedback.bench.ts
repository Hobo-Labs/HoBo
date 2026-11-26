/**
 * Vitest bench for the proof's measurable hot path: analyzing a full catalog of
 * capability requests against a provider snapshot (the per-keystroke author-time
 * loop `hobo doctor`/codegen diagnostics ride).
 */
import { bench, describe } from "vitest";

import { analyzeAuthorTimeCapabilityFeedback } from "../src/author-time-capability-feedback.ts";

const providers = Array.from({ length: 25 }, (_, p) => ({
	id: `provider-${p}`,
	capabilities: Array.from({ length: 40 }, (_, c) => ({
		port: `port-${c % 8}`,
		feature: `feature-${c}`,
		stability: c % 5 === 0 ? "preview" : "stable",
	})),
}));
const requests = Array.from({ length: 32 }, (_, r) => ({
	port: `port-${r % 8}`,
	feature: `feature-${r}`,
	strictness: r % 2 === 0 ? "require" : "prefer",
}));
const resource = { id: "sessions", type: "data.v1", selectedProviderId: "provider-3" };

describe("author-time capability feedback", () => {
	bench("analyze 32 requests against a 25-provider catalog", () => {
		analyzeAuthorTimeCapabilityFeedback({
			catalogContentHash: "cat-bench",
			resource,
			requests,
			providers,
		});
	});
});
