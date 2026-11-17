import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RECEIVER_THROUGH_PROXY, REDIRECT_RECEIVERS } from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";

import {
	OWNER_APP_LINE_PREFIX,
	OWNER_APP_REGISTER_LINE_PREFIX,
} from "../../src/ci-app-create.js";

// EVAL: the hobo-deploy skill must drive `hobo ci app create --hand-off` for
// an owner outside the agent's box through every path the CLI offers.

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

describe("EVAL hobo-deploy skill: GitHub App creation from a remote box", () => {
	it("runs the CLI with --hand-off and a stdin it can write to", () => {
		expect(APP).toMatch(/hobo ci app create --relay[\s\S]*--hand-off/u);
		expect(APP).toMatch(/mkfifo/u);
	});

	it("names every receiver the CLI accepts, and falls back when one fails", () => {
		for (const receiver of REDIRECT_RECEIVERS) expect(APP).toContain(receiver);
		expect(APP).toMatch(
			/HOBO_REDIRECT_RECEIVER_\*[\s\S]*falls\s+back by itself/u,
		);
	});

	it("leaves proxies to the run: detected up front, never a receiver that cannot use one", () => {
		expect(APP).toMatch(/Proxies are handled for you/u);
		for (const direct of REDIRECT_RECEIVERS.filter(
			(r) => RECEIVER_THROUGH_PROXY.get(r) !== true,
		))
			expect(APP).toMatch(
				new RegExp(`cannot use a required\\s+proxy \\([^)]*${direct}`, "u"),
			);
	});

	it("routes each line the CLI prints", () => {
		expect(APP).toContain(`\`${OWNER_APP_LINE_PREFIX} <https url>\``);
		expect(APP).toContain(`\`${OWNER_APP_LINE_PREFIX} <page>#<manifest>\``);
		expect(APP).toContain(
			`\`${OWNER_APP_REGISTER_LINE_PREFIX} <github url> — <steps>\``,
		);
	});

	it("hands the pasted code only to the waiting run, at once, and keeps it nowhere", () => {
		expect(APP).toMatch(/to the run's stdin at once/u);
		expect(APP).toMatch(/never repeat it, store it or\s+put it anywhere else/u);
	});

	it("never sends the owner to a shared service for the code", () => {
		expect(APP).toMatch(
			/Never point the owner at the relay or any shared service/u,
		);
		expect(APP).not.toMatch(/--via-workflow/u);
		expect(APP).not.toMatch(/127\.0\.0\.1|localhost/u);
	});
});
