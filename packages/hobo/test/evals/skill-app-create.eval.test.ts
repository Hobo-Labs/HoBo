import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL = readFileSync(
	fileURLToPath(
		new URL("../../../../.claude/skills/hobo-deploy/SKILL.md", import.meta.url),
	),
	"utf8",
);
const APP = SKILL.slice(
	SKILL.indexOf("**Creating the GitHub App for the owner.**"),
	SKILL.indexOf("What the run already does, so don't do it yourself:"),
);

describe("hobo-deploy skill: GitHub App owner hand-off", () => {
	it("routes one-time codes through the secure owner channel", () => {
		expect(APP).toMatch(/HoBo MCP owner hand-off/u);
		expect(APP).toMatch(/hobo ci app create --hand-off/u);
		expect(APP).toMatch(/directly to the run/u);
		expect(APP).toMatch(
			/Never ask the owner to send a\s+code or an identifier/u,
		);
		expect(APP).toMatch(
			/never transfer one through chat,\s+command arguments, stdin, or a file/u,
		);
	});

	it("reports a missing secure hand-off instead of exposing the code", () => {
		expect(APP).toMatch(/report that capability gap/u);
		expect(APP).toMatch(
			/Never point the owner at the relay or\s+any shared service/u,
		);
		expect(APP).not.toMatch(/send it to me/u);
	});
});
