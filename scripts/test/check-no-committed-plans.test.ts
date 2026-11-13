import { describe, expect, it } from "vitest";
import {
	committedPlans,
	frontmatterType,
	planReason,
} from "../check-no-committed-plans.mts";

const doc = (type: string) => `---\ntype: ${type}\ntitle: "x"\n---\n\n# x\n`;

describe("plans:guard", () => {
	it("reads the frontmatter type, quoted or not, in any case", () => {
		expect(frontmatterType(doc("Implementation Plan"))).toBe(
			"implementation plan",
		);
		expect(frontmatterType(doc('"Plan"'))).toBe("plan");
		expect(frontmatterType("# no frontmatter\ntype: Plan\n")).toBeUndefined();
		expect(frontmatterType("---\ntitle: x\n---\ntype: Plan\n")).toBeUndefined();
	});

	it.each([
		"Plan",
		"Implementation Plan",
		"Delivery Plan",
		"One-Shot Agent Instruction",
	])("refuses a document typed %s", (type) => {
		expect(planReason("docs/anything/x.md", () => doc(type))).toContain(
			type.toLowerCase(),
		);
	});

	it.each([
		"Design",
		"Architecture Decision Record",
		"Review Findings",
		"Delivery State",
		"Reference",
	])("allows a document typed %s", (type) => {
		expect(planReason("docs/design/x.md", () => doc(type))).toBeUndefined();
	});

	it("refuses anything under the root plans folder, whatever it holds", () => {
		expect(planReason("plans/001-anything.md", () => "")).toContain("plans/");
		expect(planReason("plans/notes.txt", () => "")).toContain("plans/");
	});

	it("does not read a file that cannot be a plan", () => {
		const read = () => {
			throw new Error("read");
		};
		expect(planReason("packages/ci/src/policy.ts", read)).toBeUndefined();
		// A package may have its own folder called plans; only the root one is local.
		expect(planReason("packages/x/plans/a.ts", read)).toBeUndefined();
	});

	it("finds no plan among the files this repository tracks", () => {
		expect(committedPlans(false)).toEqual([]);
	});
});
