import { expect, it } from "vitest";
import { synchronousResult } from "../src/synchronous-result.js";

it("refuses an exotic promise without reading its constructor accessor", () => {
	let reads = 0;
	const pending = new Promise(() => {});
	Object.defineProperty(pending, "constructor", {
		get() {
			reads++;
			throw new Error("unexpected constructor read");
		},
	});
	expect(synchronousResult(pending)).toBe(pending);
	expect(reads).toBe(0);
});
