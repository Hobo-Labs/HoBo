import fc from "fast-check";
import { expect, it } from "vitest";
import { assertReplayEqualsLive } from "../../src/replay/equivalence.js";

const event = {
	id: "one",
	streamId: "stream",
	seq: 1,
	type: "value",
	data: null,
};

it("restores the clock if installing the random override fails", () => {
	const clock = Object.getOwnPropertyDescriptor(Date, "now");
	const random = Object.getOwnPropertyDescriptor(Math, "random");
	if (!clock || !random) throw new Error("missing standard intrinsic");
	try {
		Object.defineProperty(Math, "random", { ...random, writable: false });
		expect(() =>
			assertReplayEqualsLive({
				events: [],
				initialState: null,
				fold: () => null,
			}),
		).toThrow();
		expect(Object.getOwnPropertyDescriptor(Date, "now")).toEqual(clock);
	} finally {
		Object.defineProperty(Date, "now", clock);
		Object.defineProperty(Math, "random", random);
	}
});

it("restores intrinsic descriptors when a throwing fold changes their attributes", () => {
	const clock = Object.getOwnPropertyDescriptor(Date, "now");
	const random = Object.getOwnPropertyDescriptor(Math, "random");
	if (!clock || !random) throw new Error("missing standard intrinsic");
	try {
		expect(() =>
			assertReplayEqualsLive({
				events: [event],
				initialState: null,
				fold: () => {
					Object.defineProperty(Date, "now", {
						value: () => 1,
						writable: false,
						configurable: true,
					});
					Object.defineProperty(Math, "random", {
						value: () => 1,
						writable: false,
						configurable: true,
					});
					throw new Error("fold failed");
				},
			}),
		).toThrow("fold failed");
		expect(Object.getOwnPropertyDescriptor(Date, "now")).toEqual(clock);
		expect(Object.getOwnPropertyDescriptor(Math, "random")).toEqual(random);
	} finally {
		Object.defineProperty(Date, "now", clock);
		Object.defineProperty(Math, "random", random);
	}
});

it("restores both intrinsics across generated setup and callback failures", () => {
	fc.assert(
		fc.property(
			fc.boolean(),
			fc.boolean(),
			fc.boolean(),
			(setupFails, alterClock, alterRandom) => {
				const clock = Object.getOwnPropertyDescriptor(Date, "now");
				const random = Object.getOwnPropertyDescriptor(Math, "random");
				if (!clock || !random) throw new Error("missing standard intrinsic");
				try {
					if (setupFails)
						Object.defineProperty(Math, "random", {
							...random,
							writable: false,
						});
					const expectedRandom = Object.getOwnPropertyDescriptor(
						Math,
						"random",
					);
					expect(() =>
						assertReplayEqualsLive({
							events: [event],
							initialState: null,
							fold: () => {
								if (alterClock)
									Object.defineProperty(Date, "now", {
										value: () => 1,
										writable: false,
										configurable: true,
									});
								if (alterRandom)
									Object.defineProperty(Math, "random", {
										value: () => 1,
										writable: false,
										configurable: true,
									});
								throw new Error("generated fold failure");
							},
						}),
					).toThrow();
					expect(Object.getOwnPropertyDescriptor(Date, "now")).toEqual(clock);
					expect(Object.getOwnPropertyDescriptor(Math, "random")).toEqual(
						expectedRandom,
					);
				} finally {
					Object.defineProperty(Date, "now", clock);
					Object.defineProperty(Math, "random", random);
				}
			},
		),
		{ seed: 614609, numRuns: 80 },
	);
});
