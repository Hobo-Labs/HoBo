import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";

type YardWindow = {
	__TEST__?: {
		state: () => {
			bo: {
				animationId: string;
				facing: string;
				facingSource: string;
				projectedFacing: string | null;
			};
		};
	};
	__HOBO_YARD__?: { state: { animId: string } };
};

it("reports the direction of the rendered walk, not the target zone", () => {
	const element = { addEventListener() {} };
	const canvas = { ...element, getContext: () => ({}) };
	const windowStub: YardWindow = {};
	const context = createContext({
		window: windowStub,
		location: { search: "?test=1" },
		URLSearchParams,
		performance: { now: () => 0 },
		Math: Object.create(Math),
		document: {
			body: { dataset: {} },
			getElementById: (id: string) => (id === "yard" ? canvas : element),
			querySelectorAll: () => [],
		},
		// Stop at asset loading so the test reads the actual seam without I/O.
		fetch: () => new Promise(() => {}),
	});
	runInContext(
		readFileSync(
			resolve(import.meta.dirname, "../public/yard-game.js"),
			"utf8",
		),
		context,
	);
	const seam = windowStub.__TEST__;
	const yard = windowStub.__HOBO_YARD__;
	if (!seam || !yard) throw new Error("yard test seam did not initialize");

	runInContext('visual = { facing: "west" }', context);
	yard.state.animId = "bo.walk.east";
	expect(seam.state().bo).toMatchObject({
		animationId: "bo.walk.east",
		facing: "east",
		facingSource: "rendered-walk",
		projectedFacing: "west",
	});

	runInContext('visual = { facing: "east" }', context);
	yard.state.animId = "bo.walk.west";
	expect(seam.state().bo).toMatchObject({
		animationId: "bo.walk.west",
		facing: "west",
		facingSource: "rendered-walk",
		projectedFacing: "east",
	});

	yard.state.animId = "bo.idle";
	expect(seam.state().bo).toMatchObject({
		animationId: "bo.idle",
		facing: "east",
		facingSource: "projected",
		projectedFacing: "east",
	});
	runInContext('visual = { facing: "west" }', context);
	expect(seam.state().bo).toMatchObject({
		facing: "west",
		facingSource: "projected",
		projectedFacing: "west",
	});
	runInContext("visual = null", context);
	expect(seam.state().bo).toMatchObject({
		facing: "east",
		facingSource: "default",
		projectedFacing: null,
	});
});
