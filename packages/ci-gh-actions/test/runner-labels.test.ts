import { expect, it } from "vitest";
import {
	jitRunnerRegistrationLabels,
	servedRunnerLabel,
} from "../src/runner-labels.js";

it("serves exactly one hobo or hobo-trunk label, case-insensitively", () => {
	expect(servedRunnerLabel(["hobo"])).toBe("hobo");
	expect(servedRunnerLabel(["HoBo-Trunk"])).toBe("hobo-trunk");
	expect(servedRunnerLabel([])).toBeUndefined();
	expect(servedRunnerLabel(["hobo", "hobo-trunk"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo", "linux"])).toBeUndefined();
	expect(servedRunnerLabel(["ubuntu-latest"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo-trunk-2"])).toBeUndefined();
	expect(servedRunnerLabel(["ubuntu-24.04"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo-arc"])).toBeUndefined();
	expect(servedRunnerLabel(["hobo-box"])).toBe("hobo-box");
});

it("registers every fleet label the job asks for on shared mesh runners", () => {
	expect(jitRunnerRegistrationLabels(["hobo-box"], "hobo-box")).toEqual([
		"hobo-box",
		"hobo",
	]);
	expect(jitRunnerRegistrationLabels(["hobo"], "hobo")).toEqual(["hobo"]);
	expect(jitRunnerRegistrationLabels(["hobo-trunk"], "hobo-trunk")).toEqual([
		"hobo-trunk",
	]);
});
