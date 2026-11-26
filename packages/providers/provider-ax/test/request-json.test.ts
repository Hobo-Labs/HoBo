/**
 * How the engine views an already-typed request as the JSON its parser reads.
 *
 * The port hands `optimize` a generated message, which carries a `$typeName`
 * brand on itself and on every nested message. Stripping every key spelled
 * `$typeName` on the way across also stripped map entries a caller had keyed
 * that way: a span attribute or a rubric threshold vanished without an error.
 * `toJson` writes the message's proto3 JSON, where the brand is not a field
 * and a map key is just a key.
 */
import { parseOptimizeRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { requestJson } from "../src/engine.js";
import { optimizeRequest, trajectory } from "./helpers.js";

/** A generated request whose maps hold entries keyed `$typeName`, one of them a map of messages. */
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
