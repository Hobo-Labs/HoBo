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
	SKILL.indexOf("For a new GitHub App"),
);

describe("hobo-deploy skill: GitHub App owner hand-off", () => {
	it("routes one-time codes through the secure owner channel", () => {
		expect(APP).toMatch(/HoBo MCP owner hand-off/u);
		expect(APP).toMatch(/hobo ci up --hand-off/u);
		expect(APP).toMatch(
			/standalone app-creation command is\s+not a substitute/u,
		);
		expect(APP).toMatch(/directly to the run/u);
		expect(APP).toMatch(
			/Never ask the\s+owner to send a code or an identifier/u,
		);
		expect(APP).toMatch(
			/never transfer one\s+through chat, command arguments, stdin, or a file/u,
		);
	});

	it("reports a missing secure hand-off instead of exposing the code", () => {
		expect(APP).toMatch(/report that capability gap/u);
		expect(APP).toMatch(
			/Never point the owner at the\s+relay or any shared service/u,
		);
		expect(APP).not.toMatch(/send it to me/u);
	});
});
