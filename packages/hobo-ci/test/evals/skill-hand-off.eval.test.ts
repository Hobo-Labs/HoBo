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

	it("asks the owner to choose among all three stores with a picker before anything else", () => {
		const choice = HAND_OFF.indexOf("STORE_CHOICE");
		expect(choice).toBeGreaterThan(-1);
		expect(choice).toBeLessThan(HAND_OFF.indexOf(OWNER_CREDENTIAL_LINE_PREFIX));
		const step = HAND_OFF.slice(
			choice,
			HAND_OFF.indexOf(OWNER_CREDENTIAL_LINE_PREFIX),
		);
		expect(step).toMatch(/AskUserQuestion/u);
		for (const store of ["Infisical", "1Password", "Bitwarden"])
			expect(step).toContain(`**${store}**`);
		expect(step).toMatch(/OP_CONNECT_HOST/u);
		// Never env, never the owner's terminal, never hand-made identities.
		expect(step).toMatch(
			/Never ask the owner to set\s+environment variables, never send them to a terminal/u,
		);
		expect(step).toMatch(/never ask\s+them to create identities or tokens/u);
		// Bitwarden: the API key through the credential form, then one approval.
		expect(HAND_OFF).toMatch(/HOBO_OWNER_BITWARDEN_APPROVE/u);
		expect(HAND_OFF).toMatch(/suggested_type: "basic"/u);
		expect(HAND_OFF).toMatch(/BITWARDEN_SERVER_URL/u);
		expect(HAND_OFF).not.toMatch(/BW_CLIENTID|Vaultwarden/u);
		// The choice is the owner's: a present token never picks the store.
		expect(step).toMatch(
			/never pick a store for\s+them because its token is present/u,
		);
	});

	it("routes the credential line: steps and guide first, then the credential form, then wait", () => {
		const at = HAND_OFF.indexOf(OWNER_CREDENTIAL_LINE_PREFIX);
		expect(at).toBeGreaterThan(-1);
		const step = HAND_OFF.slice(
			at,
			HAND_OFF.indexOf(`On \`${DEVICE_PREFIX}`, at),
		);
		const steps = step.indexOf("guide link");
		const form = step.indexOf("request_credential");
		expect(steps).toBeGreaterThan(-1);
		expect(form).toBeGreaterThan(steps);
		expect(step).toMatch(/continues by itself; do\s+not rerun it/u);
		expect(step).toMatch(/decline/u);
	});

	it("routes the device line to the provider's own site from any device", () => {
		const at = HAND_OFF.indexOf(`On \`${DEVICE_PREFIX}`);
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
			canAwaitEgressCredential: true,
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
