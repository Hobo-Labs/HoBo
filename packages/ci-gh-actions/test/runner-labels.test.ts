import { expect, it } from "vitest";
import { servedRunnerLabel } from "../src/runner-labels.js";

it("serves exactly one hobo or hobo-trunk label, case-insensitively", () => {
	expect(servedRunnerLabel(["hobo"])).toBe("hobo");
	expect(servedRunnerLabel(["HoBo-Trunk"])).toBe("hobo-trunk");
	expect(servedRunnerLabel([])).toBeUndefined();
	expect(servedRunnerLabel(["hobo", "hobo-trunk"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo", "linux"])).toBeUndefined();
	expect(servedRunnerLabel(["ubuntu-latest"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo-trunk-2"])).toBeUndefined();
});
