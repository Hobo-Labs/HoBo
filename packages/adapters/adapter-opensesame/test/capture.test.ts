import { describe, expect, it } from "vitest";

import { createCapture } from "../src/capture.js";

describe("createCapture", () => {
	it("keeps a short stream whole", () => {
		const capture = createCapture(100);
		capture.push("one\n");
		capture.push("two\n");
		expect(capture.text()).toBe("one\ntwo\n");
	});

	it("keeps the first and the last of a long stream and marks the gap", () => {
		const capture = createCapture(10);
		capture.push("HEAD-LINE\n");
		for (let i = 0; i < 1000; i += 1) capture.push("child noise\n");
		capture.push("TAIL-LINE\n");
		const text = capture.text();
		expect(text.startsWith("HEAD-LINE\n")).toBe(true);
		expect(text.endsWith("TAIL-LINE\n")).toBe(true);
		expect(text).toContain("omitted");
		expect(text.length).toBeLessThan(100);
	});

	it("never grows past twice its limit however much is written", () => {
		const capture = createCapture(1024);
		for (let i = 0; i < 5000; i += 1) capture.push("x".repeat(500));
		expect(capture.text().length).toBeLessThanOrEqual(2 * 1024 + 64);
	});
});
