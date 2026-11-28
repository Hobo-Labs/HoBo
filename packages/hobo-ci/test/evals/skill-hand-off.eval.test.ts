import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	OWNER_CAPTURE_LINE_PREFIX,
	OWNER_PAGE_LINE_PREFIX,
	OWNER_SIGN_IN_LINE_PREFIX,
	type OwnerStore,
	REMOTE_INFEASIBLE,
	takeHandOffSignIn,
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
	it("starts the relevant setup ceremony for missing or unverified identities", () => {
		const setup = SKILL.slice(
			SKILL.indexOf("## Set up missing identities through HoBo"),
			SKILL.indexOf("## Running `hobo ci up` / `hobo cd up` for the owner"),
		);
		expect(setup).toMatch(/missing or unverified identity/u);
		expect(setup).toContain("hobo ci up --hand-off");
		expect(setup).toContain("hobo cd up --hand-off");
		expect(setup).toMatch(/when a\s+deployment needs both, run both/u);
		expect(setup).toMatch(
			/do not claim setup completed until HoBo\s+reports completion/iu,
		);
	});

	it("checks server registration and startup before reporting an unavailable hand-off", () => {
		expect(HAND_OFF).toMatch(
			/check the project MCP registration\s+and its startup prerequisites/u,
		);
		expect(HAND_OFF).toContain(
			"pnpm exec turbo run build --filter=@hobo/hobo...",
		);
		expect(HAND_OFF).toMatch(/supported MCP discovery or reload mechanism/u);
		expect(HAND_OFF).toMatch(
			/does not establish that a private owner form is available or safe/u,
		);
	});

	it("requires a private owner session before invoking the store chooser", () => {
		expect(SKILL).toMatch(/Before any MCP call, verify/iu);
		expect(SKILL).toMatch(
			/Do not call any tool that can render an owner form\s+before that check/iu,
		);
		expect(SKILL).toMatch(
			/`choose_secret_store` must be the first MCP call in every\s+store workflow/iu,
		);
		expect(SKILL).toMatch(
			/report the missing\s+secure hand-off and do not collect store identifiers in chat/iu,
		);
		expect(SKILL).toMatch(
			/agent-visible tool calls,\s+results, traces, and diagnostics/u,
		);
		expect(SKILL).toMatch(/accepts no operator flags that weaken that audit/iu);
		expect(SKILL).not.toMatch(/--owner-form-(?:unavailable|privacy-verified)/u);
		expect(SKILL).toMatch(/a displayed form alone does not establish privacy/u);
		const choice = HAND_OFF.slice(
			HAND_OFF.indexOf("2. On `HOBO_*_STORE_CHOICE`"),
			HAND_OFF.indexOf("3. On `HOBO_*_STORE_NEEDS_SIGN_IN`"),
		);
		expect(choice).toMatch(
			/only when the connected implementation keeps the choice\s+in the temporary owner session/u,
		);
		expect(choice).toMatch(
			/excludes store coordinates from every\s+agent-visible response/u,
		);
		expect(choice).toMatch(/do not collect the choice's fields/u);
		const lifecycle = HAND_OFF.slice(
			HAND_OFF.indexOf("1. Run `hobo <ci|cd> up --hand-off`"),
			HAND_OFF.indexOf("2. On `HOBO_*_STORE_CHOICE`"),
		);
		expect(lifecycle).toMatch(
			/only when its\s+owner channel has passed the privacy check/u,
		);
		expect(lifecycle).toMatch(/channel is absent or unverified/u);
		expect(lifecycle).toMatch(
			/stop\s+at an owner step and report the\s+missing secure hand-off/iu,
		);
	});

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
		const signIn = HAND_OFF.indexOf("3. On `HOBO_*_STORE_NEEDS_SIGN_IN`");
		expect(choice).toBeLessThan(signIn);
		const step = HAND_OFF.slice(choice, signIn);
		expect(step).toMatch(/AskUserQuestion/u);
		for (const store of ["Infisical", "1Password", "Bitwarden"])
			expect(step).toContain(`**${store}**`);
		expect(step).toMatch(/never to the agent/u);
		expect(step).toMatch(/instead of collecting identifiers in\s+chat/u);
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
		expect(HAND_OFF).toMatch(/HOBO_OWNER_BITWARDEN_APPROVE/u);
		expect(HAND_OFF).not.toMatch(/suggested_type/u);
		expect(HAND_OFF).not.toMatch(/BW_CLIENTID|Vaultwarden/u);
		// The choice is the owner's: a present token never picks the store.
		expect(step).toMatch(
			/never\s+pick\s+a\s+store\s+for\s+them\s+because\s+its\s+token\s+is\s+present/u,
		);
	});

	it("routes a store sign-in through HoBo's capture, never an agent credential store", () => {
		const at = HAND_OFF.indexOf("3. On `HOBO_*_STORE_NEEDS_SIGN_IN`");
		expect(at).toBeGreaterThan(-1);
		const step = HAND_OFF.slice(
			at,
			HAND_OFF.indexOf("4. **Through a privacy-verified HoBo MCP server", at),
		);
		expect(step).toMatch(/through the HoBo MCP server's `ci` or\s+`cd` tool/u);
		expect(step).toMatch(/holds it in memory only/u);
		expect(step).toMatch(/Never use\s+`request_credential`/u);
		expect(step).toMatch(/report the missing\s+secure hand-off/u);
		expect(step).toMatch(/Do not relay a guide or raw steps/u);
	});

	it("routes the device line to the provider's own site from any device", () => {
		const at = HAND_OFF.indexOf(`On \`${DEVICE_PREFIX}`);
		expect(at).toBeGreaterThan(-1);
		expect(HAND_OFF.slice(at, at + 300)).toMatch(/any device/u);
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

	it("does not repeat private coordinates from a refusal", () => {
		expect(HAND_OFF).toMatch(
			/excluding any private coordinates or\s+references/u,
		);
	});

	it("describes the capture line the run really prints for a store sign-in", async () => {
		const unopened: OwnerStore = {
			id: "infisical",
			chosen: true,
			missing: [],
			handOffSignIn: {
				name: "INFISICAL_TOKEN",
				title: "Infisical access token",
				instructions: "Your Infisical identity's Token Auth access token.",
				guide: "https://infisical.com/docs/token-auth",
			},
			opened: undefined,
			infisicalFolder: undefined,
			unopened: undefined,
			stage: async () => {
				throw new Error("no page");
			},
		};
		const vault: TrustedVault = createTrustedVault();
		const taken = await takeHandOffSignIn({
			family: "ci",
			owner: unopened,
			open: async () => unopened,
			vault,
			channel: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
			},
		});
		if (taken.kind !== "refused") throw new Error("expected a capture ask");
		const [line] = taken.remediation;
		expect(HAND_OFF).toContain(`\`${OWNER_CAPTURE_LINE_PREFIX}\``);
		expect(HAND_OFF).toContain("`HOBO_*_STORE_NEEDS_SIGN_IN`");
		expect(taken.code).toBe("HOBO_CI_STORE_NEEDS_SIGN_IN");
		expect(line).toMatch(
			/^HOBO_OWNER_CAPTURE name=INFISICAL_TOKEN guide=https:\/\/\S+$/u,
		);
		expect(taken.remediation.join("\n")).not.toMatch(
			/127\.0\.0\.1|localhost|credential form|egress/u,
		);
		expect(vault.has("INFISICAL_TOKEN")).toBe(false);
	});

	it("requires a structured ask for every owner-facing line, re-issued after an interruption", () => {
		expect(HAND_OFF).toMatch(/never a question in\s+prose/u);
		expect(HAND_OFF).toMatch(/issue it again as the first thing you\s+do/u);
		expect(HAND_OFF).toMatch(/eval:hand-off-transcript/u);
	});

	it("runs through the HoBo MCP server, which asks the owner itself", () => {
		expect(HAND_OFF).toMatch(/through the \*\*HoBo MCP server\*\*/u);
		expect(HAND_OFF).toMatch(/the run asks the owner itself/u);
		expect(HAND_OFF).toMatch(/Never ask for a value in chat/u);
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

	it("keeps owner links in private forms and reports unavailable forms", () => {
		// Derived from the live runs: the paste form opened with no link; then
		// the links went as prompts the owner's app never showed, and the
		// agent relayed them in chat, which the owner rejected.
		const step = HAND_OFF.slice(
			HAND_OFF.indexOf("4. **Through a privacy-verified HoBo MCP server"),
			HAND_OFF.indexOf("5. On `HOBO_OWNER_BITWARDEN_APPROVE"),
		);
		expect(step).toMatch(/its link inside it/u);
		expect(step).toMatch(/never relay a\s+link/u);
		expect(step).toMatch(
			/never call `capture_secret` for\s+a value the run is waiting on/u,
		);
		expect(step).toMatch(/run the lifecycle again: the same form comes back/u);
		expect(step).not.toMatch(/linkShown|LINK_FIRST|link prompt/u);
		expect(step).toMatch(
			/withdrawn and the call ends the same way, so it never hangs/u,
		);
		expect(step).toMatch(
			/report that capability gap; do not\s+relay a dynamic link or value through chat/u,
		);
	});

	it("keeps device approval in the owner form or reports the missing form", () => {
		const step = HAND_OFF.slice(
			HAND_OFF.indexOf("6. On `HOBO_OWNER_DEVICE"),
			HAND_OFF.indexOf("7. When the run ends"),
		);
		expect(step).toMatch(/secure owner form must present the approval/u);
		expect(step).toMatch(/report the missing\s+secure hand-off/u);
		expect(step).toMatch(/instead of relaying dynamic fields/u);
	});
});
