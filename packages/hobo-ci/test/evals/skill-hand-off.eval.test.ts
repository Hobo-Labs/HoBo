import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	awaitHandOffStore,
	OWNER_CREDENTIAL_LINE_PREFIX,
	OWNER_PAGE_LINE_PREFIX,
	type OwnerStore,
} from "../../src/index.js";

// EVAL: the hobo-deploy skill is what an agent in a remote box follows when it
// runs `hobo ci up` / `hobo cd up` for the owner. It must route every line the
// run prints to something the owner can do from outside, in the right order,
// and let the run pick up the result (post-back) instead of restarting it.

const SKILL = readFileSync(
	fileURLToPath(
		new URL("../../../../.claude/skills/hobo-deploy/SKILL.md", import.meta.url),
	),
	"utf8",
);
const HAND_OFF = SKILL.slice(
	SKILL.indexOf("## Running `hobo ci up` / `hobo cd up` for the owner"),
	SKILL.indexOf("## Reporting"),
);
// The device line is @hobo/hobo-cd's; its own eval checks the CLI side.
const DEVICE_PREFIX = "HOBO_OWNER_DEVICE";

describe("EVAL hobo-deploy skill: remote hand-off", () => {
	it("has the hand-off section and its mirror is identical", () => {
		expect(HAND_OFF.length).toBeGreaterThan(0);
		const mirror = readFileSync(
			fileURLToPath(
				new URL(
					"../../../../.agents/skills/hobo-deploy/SKILL.md",
					import.meta.url,
				),
			),
			"utf8",
		);
		expect(mirror).toBe(SKILL);
	});

	it("routes the credential line: steps and guide first, then the credential form, then wait", () => {
		const at = HAND_OFF.indexOf(OWNER_CREDENTIAL_LINE_PREFIX);
		expect(at).toBeGreaterThan(-1);
		const step = HAND_OFF.slice(at, HAND_OFF.indexOf(DEVICE_PREFIX, at));
		const steps = step.indexOf("guide link");
		const form = step.indexOf("request_credential");
		expect(steps).toBeGreaterThan(-1);
		expect(form).toBeGreaterThan(steps);
		expect(step).toMatch(/continues by itself; do not rerun it/u);
		expect(step).toMatch(/decline/u);
	});

	it("routes the device line to the provider's own site from any device", () => {
		const at = HAND_OFF.indexOf(DEVICE_PREFIX);
		expect(at).toBeGreaterThan(-1);
		expect(HAND_OFF.slice(at, at + 300)).toMatch(/on any\s+device/u);
	});

	it("keeps the loopback page for the owner's own terminal and never routes a remote owner to it", () => {
		const page = HAND_OFF.indexOf(OWNER_PAGE_LINE_PREFIX);
		expect(page).toBeGreaterThan(
			HAND_OFF.indexOf("At the owner's own terminal"),
		);
		expect(HAND_OFF).not.toMatch(/report_preview_port/u);
		expect(HAND_OFF).toMatch(/Never give the owner a `127\.0\.0\.1`/u);
	});

	it("shows every remediation line of a refusal, unparaphrased", () => {
		expect(HAND_OFF).toMatch(/every\*\* remediation line/u);
	});

	it("describes the credential line the run really prints", async () => {
		const lines: string[] = [];
		const unopened: OwnerStore = {
			id: "infisical",
			missing: [],
			opened: undefined,
			stage: async () => {
				throw new Error("no page");
			},
		};
		await awaitHandOffStore({
			family: "ci",
			open: async () => unopened,
			emit: (line) => lines.push(line),
			sleep: async () => undefined,
			timeoutMs: 1,
		});
		const [line] = lines;
		// The format the skill names: `HOBO_OWNER_CREDENTIAL host=<host> guide=<url> — <steps>`.
		expect(HAND_OFF).toContain(
			"`HOBO_OWNER_CREDENTIAL host=<host> guide=<url> — <steps>`",
		);
		expect(line).toMatch(
			/^HOBO_OWNER_CREDENTIAL host=app\.infisical\.com guide=https:\/\/\S+ — .+/u,
		);
		expect(line).not.toMatch(/127\.0\.0\.1|localhost/u);
	});
});
