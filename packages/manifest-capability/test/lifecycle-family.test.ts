import { describe, expect, it } from "vitest";
import { parseProfileId } from "../src/index.js";

describe("the lifecycle profile family", () => {
	it("reads lifecycle as a queue: a lease driver delivers delayed steps", () => {
		expect(parseProfileId("lifecycle.lease-driver/v1")).toMatchObject({
			primitive: "queue",
			path: ["lifecycle", "lease-driver"],
			major: 1,
		});
	});
});
