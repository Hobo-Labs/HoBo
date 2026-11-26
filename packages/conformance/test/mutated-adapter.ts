import {
	addGoldenIr,
	addInput,
	addOutput,
	addTrace,
} from "./reference-adapter.ts";

export const subtractOutputAdapter = {
	id: "toy-adapter-broken",
	async add(input: { left: number; right: number }) {
		const output = { sum: input.left - input.right };

		return {
			output,
			goldenIr: addGoldenIr(input, output),
			replayTrace: addTrace(input, output),
		};
	},
};

export const goldenAndTraceDriftAdapter = {
	id: "toy-adapter-golden-and-replay-drift",
	async add(input: { left: number; right: number }) {
		const output = { sum: input.left + input.right };

		return {
			output,
			goldenIr: [
				{
					op: "wit.call",
					interface: "hobo:toy-math/subtract@0.1.0",
					input,
				},
			],
			replayTrace: addTrace(input, { sum: 6 }),
		};
	},
};

export const goldenIrDriftAdapter = {
	id: "toy-adapter-golden-drift",
	async add(input: { left: number; right: number }) {
		const output = { sum: input.left + input.right };

		return {
			output,
			goldenIr: [
				{
					op: "wit.call",
					interface: "hobo:toy-math/subtract@0.1.0",
					input,
				},
			],
			replayTrace: addTrace(input, output),
		};
	},
};

export const traceDriftAdapter = {
	id: "toy-adapter-trace-drift",
	async add(input: { left: number; right: number }) {
		const output = { sum: input.left + input.right };

		return {
			output,
			goldenIr: addGoldenIr(input, output),
			replayTrace: addTrace(input, { sum: 6 }),
		};
	},
};

export function createNondeterministicAdapter() {
	let counter = 0;
	return {
		id: "toy-clock-nondeterministic",
		async read() {
			counter += 1;

			return {
				output: { tick: counter },
				goldenIr: [{ op: "wit.call", interface: "hobo:toy-clock/read@0.1.0" }],
				replayTrace: [{ function: "read" }],
			};
		},
	};
}

export const nondeterministicAdapter = createNondeterministicAdapter();

export const languageLeakAdapter = {
	id: "toy-adapter-language-leak",
	async add(input: { left: number; right: number }) {
		const output = { sum: input.left + input.right };

		return {
			output,
			goldenIr: [
				{
					op: "wit.call",
					interface: "hobo:toy-math/add@0.1.0",
					language: "typescript",
				},
			],
			replayTrace: addTrace(input, output),
		};
	},
};

export const throwingAdapter = {
	id: "toy-adapter-throws",
	async add() {
		throw new Error("adapter exploded");
	},
};

export const missingFunctionAdapter = {
	id: "toy-adapter-missing-fn",
};

export { addInput, addOutput };
