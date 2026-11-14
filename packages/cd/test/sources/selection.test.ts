import { describe, expect, it } from "vitest";
import { SelectionStrategy } from "../../src/_generated/cd_pb.js";
import {
	compareVersions,
	parseSemver,
	parseSemverRange,
	selectNewest,
	versionAllowed,
} from "../../src/sources/selection.js";

describe("semver", () => {
	it("parses SemVer 2.0 with an optional leading v and orders prereleases below releases", () => {
		expect(parseSemver("v1.2.3")).toMatchObject({
			major: 1,
			minor: 2,
			patch: 3,
		});
		expect(parseSemver("1.2")).toBeUndefined();
		expect(parseSemver("01.2.3")).toBeUndefined();
		const order = [
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-beta.2",
			"1.0.0-beta.11",
			"1.0.0-rc.1",
			"1.0.0",
			"1.0.1",
		];
		const shuffled = [...order].reverse();
		shuffled.sort((a, b) => compareVersions(SelectionStrategy.SEMVER, a, b));
		expect(shuffled).toEqual(order);
	});

	it("evaluates caret, tilde, x, hyphen, comparator and OR ranges", () => {
		const range = (text: string) => {
			const parsed = parseSemverRange(text);
			if (!parsed.ok) throw new Error(text);
			return parsed.value;
		};
		expect(range("^1.2.3").test("1.9.0")).toBe(true);
		expect(range("^1.2.3").test("2.0.0")).toBe(false);
		expect(range("^0.2.3").test("0.3.0")).toBe(false);
		expect(range("~1.2.3").test("1.2.9")).toBe(true);
		expect(range("~1.2.3").test("1.3.0")).toBe(false);
		expect(range("1.x").test("1.4.2")).toBe(true);
		expect(range("1.2.3 - 1.4.0").test("1.4.0")).toBe(true);
		expect(range(">=1.0.0 <2.0.0").test("2.0.0")).toBe(false);
		expect(range("<1.0.0 || >=3.0.0").test("3.1.0")).toBe(true);
		expect(range("*").test("0.0.1")).toBe(true);
		// Prereleases match only a comparator on the same tuple.
		expect(range("^1.2.3").test("1.3.0-rc.1")).toBe(false);
		expect(range(">=1.3.0-rc.0").test("1.3.0-rc.1")).toBe(true);
		expect(parseSemverRange("^^1").ok).toBe(false);
	});
});

describe("selection", () => {
	it("filters by allow pattern, ignore patterns and semver range", () => {
		const subscription = {
			selection: SelectionStrategy.SEMVER,
			allowPattern: "^v?\\d+\\.\\d+\\.\\d+$",
			ignorePatterns: ["^1\\.2\\.4$"],
			semverRange: "^1.2.0",
		};
		expect(versionAllowed(subscription, "1.2.3").ok).toBe(true);
		expect(versionAllowed(subscription, "1.2.4").ok).toBe(false);
		expect(versionAllowed(subscription, "latest").ok).toBe(false);
		expect(versionAllowed(subscription, "2.0.0").ok).toBe(false);
	});

	it("selects the newest N in ascending order and never returns versions at or below the high-water mark", () => {
		const picked = selectNewest(
			SelectionStrategy.SEMVER,
			["1.0.0", "1.3.0", "1.1.0", "1.2.0", "0.9.0"],
			2,
			"1.0.0",
		);
		expect(picked).toEqual(["1.2.0", "1.3.0"]);
		expect(
			selectNewest(SelectionStrategy.LEXICAL, ["b", "c", "a"], 5, "b"),
		).toEqual(["c"]);
	});
});
