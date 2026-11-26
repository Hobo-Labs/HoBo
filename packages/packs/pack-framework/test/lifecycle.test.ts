/**
 * Pack upgrade as a decision, not a download.
 *
 * Written before the implementation. Packs carry a `<major>.<minor>.<patch>`
 * version that nothing in the repo could order: `parsePackVersion` checks the
 * shape and stops. So "is this newer?" — the question every upgrade begins
 * with — was unanswerable, and there was no place to put the rules that decide
 * whether an upgrade may proceed.
 *
 * The rules these tests hold come from what the corpus shows going wrong:
 *
 *   - **A major is a wall, not a step.** OLM's channels exist because silently
 *     crossing a breaking-change boundary is how an upgrade eats a database.
 *     Crossing one requires it to be asked for by name.
 *   - **A dropped profile claim blocks.** A pack that stops implementing a
 *     profile its consumers selected it for is not an upgrade for them, and
 *     discovering that after the swap is discovering it too late.
 *   - **Unverified is blocked, never skipped.** The one thing worse than
 *     refusing an upgrade is quietly not doing it — that is how a pack sits
 *     three CVEs behind while the surface reports "up to date".
 *   - **Downgrades are never automatic.** Rolling back is an operator
 *     decision; a resolver that picks it on its own has invented one.
 */
import { describe, expect, it } from "vitest";

import {
	comparePackVersions,
	latestSatisfying,
	type PackUpgradeInput,
	planPackUpgrade,
	type UpgradeCandidate,
} from "../src/lifecycle.js";
import { parsePackVersion } from "../src/manifest.js";

const v = parsePackVersion;

function candidate(
	version: string,
	overrides: Partial<UpgradeCandidate> = {},
): UpgradeCandidate {
	return {
		packVersion: v(version),
		profileIds: ["data.postgres/v1"],
		verified: true,
		...overrides,
	};
}

function inputs(overrides: Partial<PackUpgradeInput> = {}): PackUpgradeInput {
	return {
		packId: "pack.postgres.oci/v1",
		installed: candidate("1.2.0"),
		available: [candidate("1.2.0")],
		...overrides,
	};
}

describe("comparePackVersions", () => {
	it("orders by major, then minor, then patch", () => {
		expect(comparePackVersions(v("1.0.0"), v("2.0.0"))).toBeLessThan(0);
		expect(comparePackVersions(v("1.2.0"), v("1.10.0"))).toBeLessThan(0);
		expect(comparePackVersions(v("1.2.3"), v("1.2.10"))).toBeLessThan(0);
	});

	it("compares numerically, not lexically", () => {
		// The bug this function exists to prevent: "1.10.0" < "1.9.0" as strings.
		expect(comparePackVersions(v("1.10.0"), v("1.9.0"))).toBeGreaterThan(0);
	});

	it("reports equality as zero", () => {
		expect(comparePackVersions(v("3.4.5"), v("3.4.5"))).toBe(0);
	});

	it("is antisymmetric", () => {
		const a = v("1.4.2");
		const b = v("1.4.9");
		expect(Math.sign(comparePackVersions(a, b))).toBe(
			-Math.sign(comparePackVersions(b, a)),
		);
	});

	it("sorts a list ascending when used directly", () => {
		const versions = ["2.0.0", "1.10.3", "1.2.0", "1.9.9"].map(v);
		expect([...versions].sort(comparePackVersions)).toEqual(
			["1.2.0", "1.9.9", "1.10.3", "2.0.0"].map(v),
		);
	});
});

describe("latestSatisfying", () => {
	it("picks the highest version inside the same major", () => {
		const found = latestSatisfying(
			["1.0.0", "1.4.0", "1.10.2", "2.0.0"].map(v),
			1,
		);
		expect(found).toBe("1.10.2");
	});

	it("returns undefined when no version is in that major", () => {
		expect(latestSatisfying(["2.0.0", "3.1.0"].map(v), 1)).toBeUndefined();
	});

	it("returns undefined for an empty list", () => {
		expect(latestSatisfying([], 1)).toBeUndefined();
	});
});

describe("nothing newer", () => {
	it("holds when the installed version is the only one available", () => {
		const verdict = planPackUpgrade(inputs());
		expect(verdict.action).toBe("hold");
		expect(verdict.target).toBeUndefined();
		expect(verdict.reasons).toEqual([]);
	});

	it("holds when every available version is older", () => {
		// A resolver that picks an older version has invented a rollback nobody
		// asked for.
		const verdict = planPackUpgrade(
			inputs({
				installed: candidate("1.5.0"),
				available: [candidate("1.4.0"), candidate("1.2.0")],
			}),
		);
		expect(verdict.action).toBe("hold");
		expect(verdict.target).toBeUndefined();
	});
});

describe("an in-major upgrade", () => {
	it("takes the highest compatible version", () => {
		const verdict = planPackUpgrade(
			inputs({
				available: [candidate("1.2.0"), candidate("1.3.0"), candidate("1.9.1")],
			}),
		);
		expect(verdict.action).toBe("upgrade");
		expect(verdict.target?.packVersion).toBe("1.9.1");
		expect(verdict.reasons).toContain("newer-in-major");
	});

	it("does not reach across a major boundary on its own", () => {
		const verdict = planPackUpgrade(
			inputs({ available: [candidate("1.3.0"), candidate("2.0.0")] }),
		);
		expect(verdict.action).toBe("upgrade");
		expect(verdict.target?.packVersion).toBe("1.3.0");
	});
});

describe("crossing a major", () => {
	it("holds and names the boundary when a new major exists", () => {
		// Silence here would be the worst answer: the operator would never learn
		// a new major shipped.
		const verdict = planPackUpgrade(
			inputs({ available: [candidate("1.2.0"), candidate("2.1.0")] }),
		);
		expect(verdict.action).toBe("hold");
		expect(verdict.reasons).toContain("major-boundary");
		expect(verdict.availableMajors).toEqual([2]);
	});

	it("crosses when the major is asked for by name", () => {
		const verdict = planPackUpgrade(
			inputs({
				available: [candidate("1.2.0"), candidate("2.1.0")],
				acceptMajor: 2,
			}),
		);
		expect(verdict.action).toBe("upgrade");
		expect(verdict.target?.packVersion).toBe("2.1.0");
		expect(verdict.reasons).toContain("major-accepted");
	});

	it("does not skip an intermediate major that was not accepted", () => {
		// Accepting v3 is not consent to whatever v2 did on the way past.
		const verdict = planPackUpgrade(
			inputs({
				available: [candidate("2.0.0"), candidate("3.0.0")],
				acceptMajor: 2,
			}),
		);
		expect(verdict.target?.packVersion).toBe("2.0.0");
	});

	it("reports every available major above the installed one", () => {
		const verdict = planPackUpgrade(
			inputs({
				available: [candidate("2.0.0"), candidate("3.1.0"), candidate("3.0.0")],
			}),
		);
		expect(verdict.availableMajors).toEqual([2, 3]);
	});

	it("ignores an accepted major that is older than what is installed", () => {
		const verdict = planPackUpgrade(
			inputs({
				installed: candidate("2.1.0"),
				available: [candidate("1.9.0"), candidate("2.1.0")],
				acceptMajor: 1,
			}),
		);
		expect(verdict.action).toBe("hold");
		expect(verdict.target).toBeUndefined();
	});
});

describe("verification", () => {
	it("blocks rather than silently choosing an older verified version", () => {
		// Skipping quietly is how a pack sits behind while the surface reports
		// it current. The unverified candidate is the answer, and it is refused
		// out loud.
		const verdict = planPackUpgrade(
			inputs({
				available: [
					candidate("1.2.0"),
					candidate("1.5.0", { verified: false }),
				],
			}),
		);
		expect(verdict.action).toBe("blocked");
		expect(verdict.reasons).toContain("unverified-target");
		expect(verdict.target?.packVersion).toBe("1.5.0");
	});

	it("blocks on an unverified major even when the major was accepted", () => {
		const verdict = planPackUpgrade(
			inputs({
				available: [candidate("2.0.0", { verified: false })],
				acceptMajor: 2,
			}),
		);
		expect(verdict.action).toBe("blocked");
		expect(verdict.reasons).toContain("unverified-target");
	});

	it("does not block on an unverified version nobody would pick", () => {
		// An unverified 1.1.0 below an installed 1.2.0 is not this decision's
		// problem, and reporting it would be noise.
		const verdict = planPackUpgrade(
			inputs({
				available: [
					candidate("1.1.0", { verified: false }),
					candidate("1.2.0"),
				],
			}),
		);
		expect(verdict.action).toBe("hold");
		expect(verdict.reasons).toEqual([]);
	});
});

describe("profile claims", () => {
	it("blocks an upgrade that drops a profile the installed pack implements", () => {
		// Consumers selected this pack for that profile. Finding out after the
		// swap is finding out too late.
		const verdict = planPackUpgrade(
			inputs({
				installed: candidate("1.2.0", {
					profileIds: ["data.postgres/v1", "data.backup/v1"],
				}),
				available: [candidate("1.5.0", { profileIds: ["data.postgres/v1"] })],
			}),
		);
		expect(verdict.action).toBe("blocked");
		expect(verdict.reasons).toContain("profile-dropped");
		expect(verdict.droppedProfiles).toEqual(["data.backup/v1"]);
	});

	it("permits an upgrade that adds a profile", () => {
		const verdict = planPackUpgrade(
			inputs({
				available: [
					candidate("1.5.0", {
						profileIds: ["data.postgres/v1", "data.backup/v1"],
					}),
				],
			}),
		);
		expect(verdict.action).toBe("upgrade");
		expect(verdict.droppedProfiles).toEqual([]);
	});

	it("still blocks a dropped profile across an accepted major", () => {
		// A major bump explains a breaking change; it does not excuse one that
		// was never named.
		const verdict = planPackUpgrade(
			inputs({
				installed: candidate("1.2.0", {
					profileIds: ["data.postgres/v1", "data.backup/v1"],
				}),
				available: [candidate("2.0.0", { profileIds: ["data.postgres/v1"] })],
				acceptMajor: 2,
			}),
		);
		expect(verdict.action).toBe("blocked");
		expect(verdict.reasons).toContain("profile-dropped");
	});

	it("reports dropped profiles sorted, so the verdict is stable", () => {
		const verdict = planPackUpgrade(
			inputs({
				installed: candidate("1.2.0", {
					profileIds: ["z.one/v1", "a.two/v1", "data.postgres/v1"],
				}),
				available: [candidate("1.5.0", { profileIds: ["data.postgres/v1"] })],
			}),
		);
		expect(verdict.droppedProfiles).toEqual(["a.two/v1", "z.one/v1"]);
	});
});

describe("verdict shape", () => {
	it("names every reason it acted on", () => {
		const verdict = planPackUpgrade(
			inputs({
				installed: candidate("1.2.0", {
					profileIds: ["data.postgres/v1", "data.backup/v1"],
				}),
				available: [
					candidate("2.0.0", {
						profileIds: ["data.postgres/v1"],
						verified: false,
					}),
				],
				acceptMajor: 2,
			}),
		);
		expect([...verdict.reasons].sort()).toEqual([
			"major-accepted",
			"profile-dropped",
			"unverified-target",
		]);
	});

	it("carries the pack id and the installed version forward", () => {
		const verdict = planPackUpgrade(inputs());
		expect(verdict.packId).toBe("pack.postgres.oci/v1");
		expect(verdict.installed.packVersion).toBe("1.2.0");
	});

	it("is a pure function of its input", () => {
		const input = inputs({
			available: [candidate("1.4.0"), candidate("2.0.0")],
		});
		expect(planPackUpgrade(input)).toEqual(planPackUpgrade(input));
	});

	it("does not mutate the input, including the available list order", () => {
		const input = inputs({
			available: [candidate("1.9.0"), candidate("1.3.0")],
		});
		const before = structuredClone(input);
		planPackUpgrade(input);
		expect(input).toEqual(before);
	});

	it("holds with no target when nothing is available at all", () => {
		const verdict = planPackUpgrade(inputs({ available: [] }));
		expect(verdict.action).toBe("hold");
		expect(verdict.target).toBeUndefined();
		expect(verdict.availableMajors).toEqual([]);
	});
});
