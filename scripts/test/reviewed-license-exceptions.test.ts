import { expect, it } from "vitest";
import { reviewedLicense } from "../lib/reviewed-license-exceptions.js";

it("limits reviewed Rivet dependency licenses to the inspected releases", () => {
	expect(reviewedLicense("process", "0.10.1")).toContain("MIT");
	expect(reviewedLicense("vbare", "0.0.4")).toContain(
		"2425888196f6f7b9eb1b1b5f14550f6ee50f93cd",
	);
	expect(reviewedLicense("process", "0.10.2")).toBeUndefined();
	expect(reviewedLicense("vbare", "0.0.5")).toBeUndefined();
	expect(reviewedLicense("other", "0.0.4")).toBeUndefined();
});
