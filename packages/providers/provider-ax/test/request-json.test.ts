import { parseOptimizeRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { requestJson } from "../src/engine.js";
import { optimizeRequest, trajectory } from "./helpers.js";

function message() {
	const document = optimizeRequest([
		trajectory("t1", "cannot log in", "access", 0.95),
	]);
	const [first] = document.trajectories;
	const [root] = first?.spans ?? [];
	if (first === undefined || root === undefined) {
		throw new Error("the helper request has a trajectory with a root span");
	}
	return parseOptimizeRequest({
		...document,
		rubric: {
			...document.rubric,
			thresholds: { $typeName: 0.5, accuracy: 0.9 },
		},
		trajectories: [
			{
				...first,
				spans: [
					{
						...root,
						attributes: { $typeName: "kept-by-user", "llm.model": "m" },
					},
				],
				payloads: {
					$typeName: { classification: "public", valueJson: "{}" },
					input: { classification: "public", valueJson: '{"a":1}' },
				},
			},
		],
	});
}

describe("requestJson", () => {
	it("keeps map entries keyed $typeName", () => {
		const again = parseOptimizeRequest(requestJson(message()));
		const [first] = again.trajectories;
		expect(first?.spans[0]?.attributes).toEqual({
			$typeName: "kept-by-user",
			"llm.model": "m",
		});
		expect(again.rubric.thresholds).toEqual({ $typeName: 0.5, accuracy: 0.9 });
		expect(Object.keys(first?.payloads ?? {}).sort()).toEqual([
			"$typeName",
			"input",
		]);
	});

	it("reads back as the same request", () => {
		const original = message();
		expect(parseOptimizeRequest(requestJson(original))).toEqual(original);
	});
});
