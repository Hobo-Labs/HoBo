import { parseOptimizeRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createAxTrainingEngine } from "../src/index.js";
import { mockModel, optimizeRequest, trajectory } from "./helpers.js";

const engine = () =>
	createAxTrainingEngine({ ai: mockModel("access"), maxMetricCalls: 4 });

describe("a trajectory whose spans have no root", () => {
	function cyclicSpans() {
		const base = trajectory("t1", "cannot log in", "access", 0.95);
		const [root] = base.spans;
		if (root === undefined) throw new Error("trajectory() records a root span");
		return {
			...base,
			spans: [
				{ ...root, id: "span-a", parentId: "span-b" },
				{ ...root, id: "span-b", parentId: "span-a" },
			],
		};
	}

	it("passes the parse boundary", async () => {
		expect(() =>
			parseOptimizeRequest(optimizeRequest([cyclicSpans()])),
		).not.toThrow();
	});

	it("is refused as unusable rather than read for whichever span came first", async () => {
		await expect(
			engine().optimize(parseOptimizeRequest(optimizeRequest([cyclicSpans()]))),
		).rejects.toThrow(/no trajectory with recorded root-span/u);
	});

	it("does not poison a request that also carries a usable trajectory", async () => {
		const candidate = await engine().optimize(
			parseOptimizeRequest(
				optimizeRequest([
					cyclicSpans(),
					trajectory("t2", "cannot log in again", "access", 0.95),
				]),
			),
		);
		expect(candidate.body.case).toBe("artifact");
	});
});
