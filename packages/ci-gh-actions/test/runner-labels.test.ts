import { expect, it } from "vitest";
import { BOX_RUNNER_LABEL, servedRunnerLabel } from "../src/runner-labels.js";

it("serves exactly one hobo or hobo-trunk label, case-insensitively", () => {
	expect(servedRunnerLabel(["hobo"])).toBe("hobo");
	expect(servedRunnerLabel(["HoBo-Trunk"])).toBe("hobo-trunk");
	expect(servedRunnerLabel([BOX_RUNNER_LABEL])).toBe(BOX_RUNNER_LABEL);
	expect(servedRunnerLabel([])).toBeUndefined();
	expect(servedRunnerLabel(["hobo", "hobo-trunk"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo", "linux"])).toBeUndefined();
	expect(servedRunnerLabel(["ubuntu-latest"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo-trunk-2"])).toBeUndefined();
	expect(servedRunnerLabel(["ubuntu-24.04"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo-arc"])).toBeUndefined();
});
