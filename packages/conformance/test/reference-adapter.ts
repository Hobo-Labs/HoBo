import type { JsonObject } from "../src/json.js";
import { createConformanceSuite } from "../src/suite.ts";

export const addInput = { left: 2, right: 3 };
export const addOutput = { sum: 5 };

export function addGoldenIr(input = addInput, output = addOutput) {
	return [
		{
			op: "wit.call",
			interface: "hobo:toy-math/add@0.1.0",
			input,
		},
		{
			op: "manifest.emit",
			resource: "toy.sum",
			value: output.sum,
		},
	];
}

export function addTrace(input = addInput, output = addOutput) {
	return [
		{
			function: "add",
			input,
			output,
		},
	];
}

export function toySuite(overrides: JsonObject = {}) {
	return createConformanceSuite({
		id: "toy-math-port",
		port: {
			wit: "hobo:toy-math@0.1.0",
			functions: ["add"],
		},
		coverage: {
			requiredFunctions: ["add"],
		},
		cases: [
			{
				id: "adds-two-numbers",
				exercises: ["add"],
				call: {
					function: "add",
					input: addInput,
				},
				expect: {
					output: addOutput,
					goldenIr: addGoldenIr(),
					replayTrace: addTrace(),
				},
			},
		],
		...overrides,
	});
}

export const passingToyAdapter = {
	id: "toy-adapter-good",
	async add(input: { left: number; right: number }) {
		const output = { sum: input.left + input.right };

		return {
			output,
			goldenIr: addGoldenIr(input, output),
			replayTrace: addTrace(input, output),
		};
	},
};
