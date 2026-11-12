import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Consumer side of eventstore-boundary.pact.json. The consumer is the CD
 * reconciler transport (plan 0024 WP7), which classifies store failures by
 * `error.code` only: STALE_FENCE or *LEASE_CONFLICT means "lost the Camp",
 * OPTIMISTIC_SEQUENCE_CONFLICT means "re-read and retry", anything else is
 * "store unavailable". This test pins that every response the consumer
 * expects is one it can classify, and that successful responses carry
 * u64-safe decimal strings.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(join(here, "..", "eventstore-boundary.pact.json"), "utf8"),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: {
		description: string;
		providerState: string;
		request: { method: string };
		response: Record<string, unknown> & { error?: { code: string } };
	}[];
};

type Classification = "lost-lease" | "retry" | "regression" | "unavailable";

/** The reconciler's classification rule (mirrors the WP7 transport). */
function classify(code: string): Classification {
	if (
		code === "STALE_FENCE" ||
		code === "MISSING_FENCE" ||
		code.endsWith("LEASE_CONFLICT")
	) {
		return "lost-lease";
	}
	if (code === "OPTIMISTIC_SEQUENCE_CONFLICT") return "retry";
	if (code === "CHECKPOINT_REGRESSION") return "regression";
	return "unavailable";
}

describe("eventstore boundary — consumer expectations", () => {
	it("names the consumer and provider of this boundary", () => {
		expect(pact.consumer.name).toBe("hobo-cd-reconciler");
		expect(pact.provider.name).toBe("hobo-storage-postgres");
		expect(pact.interactions.length).toBeGreaterThanOrEqual(8);
	});

	it("expects only failure codes the reconciler classifies as something other than an outage", () => {
		for (const interaction of pact.interactions) {
			const code = interaction.response.error?.code;
			if (code === undefined) continue;
			expect(classify(code), interaction.description).not.toBe("unavailable");
		}
	});

	it("expects positions and fence tokens as decimal strings", () => {
		for (const interaction of pact.interactions) {
			for (const field of ["firstPosition", "lastPosition", "fenceToken"]) {
				const value = interaction.response[field];
				if (value !== undefined) expect(value).toMatch(/^(0|[1-9][0-9]*)$/u);
			}
		}
	});

	it("covers every method the reconciler calls with at least one interaction", () => {
		const methods = new Set(
			pact.interactions.map((interaction) => interaction.request.method),
		);
		expect([...methods].sort()).toEqual([
			"append",
			"claimSubscription",
			"commitCheckpoint",
		]);
	});
});
