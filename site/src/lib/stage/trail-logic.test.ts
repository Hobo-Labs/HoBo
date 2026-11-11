import { describe, expect, it } from "vitest";
import {
	canScroll,
	clampStop,
	fits,
	hashForStop,
	hashTarget,
	inStageZone,
	keyDirection,
	pageKeepsKey,
	readsDown,
	scrollAmount,
	stopFromHash,
	trailTakes,
} from "./trail-logic";

const stops = [
	{ id: "trailhead", inner: ["trailhead-title"] },
	{ id: "why", inner: ["why-title"] },
	{ id: "compare", inner: ["compare-title"] },
];

describe("stopFromHash", () => {
	it("finds a stop by its own id or an id inside it", () => {
		expect(stopFromHash("#why", stops)).toBe(1);
		expect(stopFromHash("#compare-title", stops)).toBe(2);
	});

	it("names no stop for an empty, unknown or malformed hash", () => {
		expect(stopFromHash("", stops)).toBe(-1);
		expect(stopFromHash("#", stops)).toBe(-1);
		expect(stopFromHash("#1x", stops)).toBe(-1);
		expect(stopFromHash("#%E0%A4%A", stops)).toBe(-1);
	});

	it("decodes an escaped id and keeps a malformed one as written", () => {
		expect(hashTarget("#caf%C3%A9")).toBe("café");
		expect(hashTarget("#%E0%A4%A")).toBe("%E0%A4%A");
	});
});

describe("hashForStop", () => {
	it("leaves the first stop as the bare page", () => {
		expect(hashForStop(0, "trailhead")).toBe("");
		expect(hashForStop(2, "compare")).toBe("#compare");
	});
});

describe("clampStop", () => {
	it("never steps before the first stop or past the last", () => {
		expect(clampStop(-1, 8)).toBe(0);
		expect(clampStop(3, 8)).toBe(3);
		expect(clampStop(8, 8)).toBe(7);
		expect(clampStop(4, 0)).toBe(0);
	});
});

describe("trailTakes", () => {
	it("takes a step inside the trail", () => {
		expect(trailTakes(true, 1, false, false)).toBe(true);
		expect(trailTakes(true, -1, false, false)).toBe(true);
	});

	it("lets the page scroll on past the last stop and before the first", () => {
		expect(trailTakes(true, 1, false, true)).toBe(false);
		expect(trailTakes(true, -1, true, false)).toBe(false);
	});

	it("leaves the footer to the page", () => {
		expect(trailTakes(false, 1, false, false)).toBe(false);
	});
});

describe("inStageZone", () => {
	it("treats a small scroll as still on the trail", () => {
		expect(inStageZone(0, 800)).toBe(true);
		expect(inStageZone(120, 800)).toBe(true);
		expect(inStageZone(500, 800)).toBe(false);
	});
});

describe("keys", () => {
	it("keeps typing and sideways scrolling for the page, and nothing else", () => {
		expect(pageKeepsKey("editable", "ArrowDown")).toBe(true);
		expect(pageKeepsKey("sideways", "ArrowRight")).toBe(true);
		expect(pageKeepsKey("sideways", "ArrowDown")).toBe(false);
		expect(pageKeepsKey("page", "ArrowRight")).toBe(false);
	});

	it("reads direction, with space only from the page body", () => {
		expect(keyDirection("ArrowRight", false, false)).toBe(1);
		expect(keyDirection("PageUp", false, false)).toBe(-1);
		expect(keyDirection(" ", false, true)).toBe(1);
		expect(keyDirection(" ", true, true)).toBe(-1);
		expect(keyDirection(" ", false, false)).toBe(0);
		expect(keyDirection("a", false, true)).toBe(0);
	});

	it("scrolls a tall stop with the vertical keys only", () => {
		expect(readsDown("ArrowDown")).toBe(true);
		expect(readsDown("ArrowRight")).toBe(false);
		expect(scrollAmount("ArrowDown", 400)).toBe(56);
		expect(scrollAmount("PageDown", 400)).toBe(340);
	});
});

describe("fit and scroll", () => {
	it("knows when a stop's content fits its area", () => {
		expect(fits(400, 400)).toBe(true);
		expect(fits(402, 400)).toBe(false);
	});

	it("knows when a scroll box can move further", () => {
		expect(canScroll(1, 0, 900, 400)).toBe(true);
		expect(canScroll(1, 500, 900, 400)).toBe(false);
		expect(canScroll(-1, 0, 900, 400)).toBe(false);
		expect(canScroll(-1, 30, 900, 400)).toBe(true);
	});
});
