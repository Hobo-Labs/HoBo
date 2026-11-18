import { expect, it } from "vitest";
import { createTraceSink, type OptimizerTraceSpan } from "../src/index.js";

function makeSpan(id: string) {
	return {
		id,
		parentId: "",
		kind: "CHAIN" as const,
		name: `step-${id}`,
		inputDigest: `sha256:${id}`,
		score: 0.5,
		decision: "kept" as const,
		attributes: { source: `source-${id}` },
	};
}

it("captures a detached immutable span and attributes when recorded", () => {
	const sink = createTraceSink();
	const source = makeSpan("first");
	sink.record(source);
	source.name = "changed";
	source.attributes.source = "changed";
	const drained = sink.drain();
	expect(drained).toEqual([makeSpan("first")]);
	expect(drained[0]).not.toBe(source);
	expect(drained[0]?.attributes).not.toBe(source.attributes);
	expect(Object.isFrozen(drained)).toBe(true);
	expect(Object.isFrozen(drained[0])).toBe(true);
	expect(Object.isFrozen(drained[0]?.attributes)).toBe(true);
});

it("drains exactly once and keeps earlier results independent of later records", () => {
	const sink = createTraceSink();
	const first = makeSpan("first");
	sink.record(first);
	const drained = sink.drain();
	expect(sink.drain()).toEqual([]);
	first.attributes.source = "changed";
	const second = makeSpan("second");
	sink.record(second);
	expect(drained).toEqual([makeSpan("first")]);
	expect(sink.drain()).toEqual([makeSpan("second")]);
	expect(sink.drain()).toEqual([]);
});

it("preserves record and drain behavior across generated operation sequences", () => {
	let seed = 0x55a762d3;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed >>> 8;
	};
	for (let trial = 0; trial < 100; trial++) {
		const sink = createTraceSink();
		let expected: OptimizerTraceSpan[] = [];
		const previous: {
			result: readonly OptimizerTraceSpan[];
			expected: OptimizerTraceSpan[];
		}[] = [];
		for (let step = 0; step < 20; step++) {
			if (next() % 3 === 0) {
				const result = sink.drain();
				expect(result).toEqual(expected);
				previous.push({ result, expected });
				expected = [];
			} else {
				const id = `${trial}-${step}`;
				const source = makeSpan(id);
				sink.record(source);
				expected.push(makeSpan(id));
				source.name = "changed";
				source.attributes.source = "changed";
			}
			for (const old of previous) expect(old.result).toEqual(old.expected);
		}
		expect(sink.drain()).toEqual(expected);
		expect(sink.drain()).toEqual([]);
	}
});
