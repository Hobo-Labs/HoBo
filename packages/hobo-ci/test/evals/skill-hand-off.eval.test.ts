import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	awaitHandOffStore,
	OWNER_CAPTURE_LINE_PREFIX,
	OWNER_CREDENTIAL_LINE_PREFIX,
	OWNER_PAGE_LINE_PREFIX,
	OWNER_SIGN_IN_LINE_PREFIX,
	type OwnerStore,
	REMOTE_INFEASIBLE,
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
			/Never ask the owner to set\s+environment\s+variables,\s+never\s+send\s+them\s+to\s+a\s+terminal/u,
		);
		expect(step).toMatch(
			/never\s+ask\s+them\s+to\s+create\s+identities\s+or\s+tokens/u,
		);
		// The choice is a picker the host renders, never prose.
		expect(step).toMatch(/choose_secret_store/u);
		// The run sets up its own access; nothing is provisioned by hand.
		expect(step).toMatch(/installs the\s+store's CLI/u);
		expect(step).toMatch(
			/Never\s+relay\s+instructions\s+to\s+create\s+identities/u,
		);
		// The store alone; then only the chosen store's follow-ups.
		expect(step).toMatch(/the store \*\*alone\*\*, one question/u);
		expect(step).toMatch(/nothing\s+about\s+the\s+other\s+stores/u);
		expect(step).toMatch(/AskUserQuestion/u);
		// Bitwarden: the API key through the credential form, then one approval.
		expect(HAND_OFF).toMatch(/HOBO_OWNER_BITWARDEN_APPROVE/u);
		expect(HAND_OFF).toMatch(/suggested_type: "basic"/u);
		expect(HAND_OFF).toMatch(/BITWARDEN_SERVER_URL/u);
		expect(HAND_OFF).not.toMatch(/BW_CLIENTID|Vaultwarden/u);
		// The choice is the owner's: a present token never picks the store.
		expect(step).toMatch(
			/never\s+pick\s+a\s+store\s+for\s+them\s+because\s+its\s+token\s+is\s+present/u,
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
		// A port preview showed this owner nothing: never route a form there.
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

	it("requires a structured ask for every owner-facing line, re-issued after an interruption", () => {
		expect(HAND_OFF).toMatch(/never a question in\s+prose/u);
		expect(HAND_OFF).toMatch(/issue it again as the first thing you\s+do/u);
		expect(HAND_OFF).toMatch(/eval:hand-off-transcript/u);
	});

	it("runs through the HoBo MCP server and hands the remote sign-in over in the capture form", () => {
		expect(HAND_OFF).toMatch(/through the \*\*HoBo MCP server\*\*/u);
		expect(HAND_OFF).toMatch(/HOBO_OWNER_SIGN_IN url=<url> capture=<name>/u);
		expect(HAND_OFF).toMatch(/Copy to\s+clipboard/u);
		expect(HAND_OFF).toMatch(/capture_secret/u);
		expect(HAND_OFF).toMatch(/Never ask for the value\s+in chat/u);
	});

	it("never tells the agent to send a remote owner anywhere they cannot reach", () => {
		// The skill is followed on remote boxes: the same rule as the run's lines.
		const remote = HAND_OFF.slice(
			0,
			HAND_OFF.indexOf("**At the owner's own terminal**"),
		);
		const offending = remote.split("\n").filter(
			(line) =>
				REMOTE_INFEASIBLE.test(line) &&
				// Rules that forbid it name it; they are not instructions to do it.
				!/\bnever\b|\bnot\b|a bug to fix/iu.test(line),
		);
		expect(offending).toEqual([]);
	});

	it("routes every line a remote run hands the owner", () => {
		for (const prefix of [
			OWNER_SIGN_IN_LINE_PREFIX,
			OWNER_CAPTURE_LINE_PREFIX,
			OWNER_CREDENTIAL_LINE_PREFIX,
			DEVICE_PREFIX,
			"HOBO_OWNER_BITWARDEN_APPROVE",
		])
			expect(HAND_OFF).toContain(prefix);
		expect(HAND_OFF).toMatch(/GITHUB_APP_CODE/u);
		// The form is the host's: HoBo's MCP App or the host's elicitation form,
		// and a host with neither is said plainly, never papered over.
		expect(HAND_OFF).toMatch(/SECRET_CAPTURE_NO_OWNER_FORM/u);
		expect(HAND_OFF).toMatch(/elicitation form/u);
	});

	it("gives the sign-in link in chat first and opens the form only after the owner copied the value", () => {
		// Derived from the live run: the form opened at once, blocked the chat,
		// and the link was unclickable prose inside it.
		const step = HAND_OFF.slice(
			HAND_OFF.indexOf("4. On `HOBO_OWNER_SIGN_IN"),
			HAND_OFF.indexOf("On `HOBO_OWNER_CAPTURE"),
		);
		expect(step).toMatch(/link first, in chat, and end your turn/u);
		expect(step).toMatch(/\[Sign in to Infisical\]\(<url>\)/u);
		expect(step).toMatch(/Do not call `capture_secret`\s+in this turn/u);
		expect(step.indexOf("When the owner says they copied it")).toBeGreaterThan(
			step.indexOf("link first"),
		);
		expect(step).toMatch(/ten\s+minutes/u);
	});
});
