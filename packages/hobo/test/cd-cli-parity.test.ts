// The shell's typed `hobo deploy` option table (@hobo/cli subcommands.ts) and
// the CD subcommands (cd-deploy.ts) describe one surface: every subcommand is
// in both, and each usage line names exactly the flags the shell accepts for
// it (beside the common --format/--simulate/--yard).
import { DEPLOY_SUBCOMMANDS } from "@hobo/cli";
import { describe, expect, it } from "vitest";
import { CD_DEPLOY_SUBCOMMANDS } from "../src/cd-deploy.js";

const HOSTING = [
	"hosting-status",
	"hosting-resume",
	"hosting-cancel",
	"hosting-resume-mutation",
];

function usageFlags(usage: string): string[] {
	return [
		...new Set([...usage.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1] ?? "")),
	].sort();
}

describe("hobo deploy shell/CD parity", () => {
	it("declares the same subcommands in the shell and in cd-deploy", () => {
		expect([...DEPLOY_SUBCOMMANDS.subcommands.keys()].sort()).toEqual(
			[...Object.keys(CD_DEPLOY_SUBCOMMANDS), ...HOSTING].sort(),
		);
	});

	it("each usage line names exactly the flags the shell accepts for it", () => {
		const common = new Set(DEPLOY_SUBCOMMANDS.common);
		for (const [name, sub] of Object.entries(CD_DEPLOY_SUBCOMMANDS)) {
			const declared = [...(DEPLOY_SUBCOMMANDS.subcommands.get(name) ?? [])]
				.filter((flag) => !common.has(flag))
				.sort();
			expect(usageFlags(sub.usage), name).toEqual(declared);
		}
	});
});
