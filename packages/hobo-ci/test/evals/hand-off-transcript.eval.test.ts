import { describe, expect, it } from "vitest";

import {
	auditHandOff,
	parseClaudeTranscript,
} from "../../src/hand-off-audit.js";

// EVAL: the owner gets the experience the hobo-deploy skill promises, judged
// from the agent's own transcript. A handed-off run printed an owner-facing
// line; the agent must answer it with a structured ask (the HoBo MCP App's
// choice elicitation or widget, or the host's picker; the credential form
// for a credential), never with a question in prose, and must ask again when
// an ask did not complete. The first case is the failure the owner hit: the
// picker was interrupted by a restart and every later turn asked in prose.

type Question = {
	question: string;
	header: string;
	options: { label: string; description: string }[];
};
const toolUse = (
	id: string,
	name: string,
	input: { questions?: Question[] } = {},
) => ({
	type: "tool_use" as const,
	id,
	name,
	input,
});
const question = (
	header: string,
	text: string,
	labels: readonly string[],
): Question => ({
	header,
	question: text,
	options: labels.map((label) => ({ label, description: "" })),
});
const STORE_QUESTION = question(
	"Store",
	"Which secret store should hobo cd up use?",
	["Infisical", "1Password", "Bitwarden"],
);
const toolResult = (id: string, text: string, isError = false) => ({
	type: "tool_result" as const,
	tool_use_id: id,
	content: text,
	is_error: isError,
});
const text = (t: string) => ({ type: "text" as const, text: t });
type Block =
	| ReturnType<typeof toolUse>
	| ReturnType<typeof toolResult>
	| ReturnType<typeof text>;
type Content = string | readonly Block[];
type Line = { message: { role: "user" | "assistant"; content: Content } };
const jsonl = (lines: readonly Line[]) =>
	`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
const user = (content: Content): Line => ({
	message: { role: "user", content },
});
const assistant = (content: Content): Line => ({
	message: { role: "assistant", content },
});

/** What `hobo cd up --hand-off` prints when the owner has not chosen a store. */
const STORE_CHOICE_OUTPUT = [
	"Command  Status",
	"cd       needs-connection",
	"",
	"Choose your secret store first: Infisical, 1Password or Bitwarden.",
	"",
	"HOBO_CD_STORE_CHOICE",
	"- HOBO_OWNER_STORE_CHOICE infisical|1password|bitwarden — run again with HOBO_SECRET_STORE set",
].join("\n");

const runAndRead = [
	user("Run the skill: hobo cd up."),
	assistant([toolUse("run", "Bash")]),
	user([toolResult("run", STORE_CHOICE_OUTPUT)]),
];

describe("EVAL hand-off transcript: every owner-facing line gets a structured ask", () => {
	it("flags the session that asked in prose after its picker was interrupted", () => {
		const transcript = jsonl([
			...runAndRead,
			assistant([
				text("The run stopped at the store choice."),
				toolUse("ask", "AskUserQuestion"),
			]),
			user([
				toolResult(
					"ask",
					"[Tool call not completed: an approval request was still unanswered when the message that follows arrived and was closed]",
				),
			]),
			user("[Request interrupted by user for tool use]"),
			assistant([text("No response requested.")]),
			user("Be careful of exposing values that should be kept secret."),
			assistant([
				text(
					"Fixed. Which store should the production relay use: Bitwarden, Infisical or 1Password?",
				),
			]),
			user("<task-notification>4 unread notifications</task-notification>"),
			assistant([
				text(
					"#2033 is in the merge queue. The run is still waiting on your choice of store.",
				),
			]),
			user("<task-notification>1 unread notification</task-notification>"),
			assistant([text("#2034 is ready. Which secret store should I use?")]),
		]);
		const findings = auditHandOff(parseClaudeTranscript(transcript));
		// Every turn after the interruption ended without re-asking.
		expect(findings.length).toBeGreaterThanOrEqual(3);
		for (const finding of findings) {
			expect(finding).toMatchObject({
				rule: "structured-ask",
				ask: "choice",
				line: "HOBO_CD_STORE_CHOICE",
			});
		}
	});

	it("passes when the interrupted picker is asked again at once", () => {
		const transcript = jsonl([
			...runAndRead,
			assistant([toolUse("ask", "AskUserQuestion")]),
			user([toolResult("ask", "[Tool call not completed: interrupted]")]),
			user("[Request interrupted by user for tool use]"),
			assistant([toolUse("ask2", "AskUserQuestion")]),
			user([
				toolResult(
					"ask2",
					'Your questions have been answered: "Which secret store"="Infisical"',
				),
			]),
			assistant([text("Infisical it is.")]),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toEqual([]);
	});

	it("accepts the HoBo MCP App's elicitation as the structured choice", () => {
		const transcript = jsonl([
			...runAndRead,
			assistant([toolUse("pick", "mcp__hobo__choose_secret_store")]),
			user([toolResult("pick", "The owner chose Infisical.")]),
			assistant([text("Running again with Infisical.")]),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toEqual([]);
	});

	it("flags a question in prose even when it lists the right options", () => {
		const transcript = jsonl([
			...runAndRead,
			assistant([text("Which store: Infisical, 1Password or Bitwarden?")]),
			user("Infisical"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toMatchObject([
			{ ask: "choice", line: "HOBO_CD_STORE_CHOICE" },
		]);
	});

	it("requires the credential form for a credential line; a picker is not enough", () => {
		const credential = jsonl([
			user("go"),
			assistant([toolUse("run", "Bash")]),
			user([
				toolResult(
					"run",
					"HOBO_OWNER_CREDENTIAL host=identity.bitwarden.com guide=https://vault.bitwarden.com/#/settings/security/security-keys — …",
				),
			]),
			assistant([toolUse("ask", "AskUserQuestion")]),
			user([toolResult("ask", "answered")]),
			assistant([text("Thanks.")]),
			user("next"),
		]);
		expect(auditHandOff(parseClaudeTranscript(credential))).toMatchObject([
			{
				ask: "credential",
				line: "HOBO_OWNER_CREDENTIAL host=identity.bitwarden.com",
			},
		]);
		const asked = jsonl([
			user("go"),
			assistant([toolUse("run", "Bash")]),
			user([
				toolResult(
					"run",
					"HOBO_OWNER_CREDENTIAL host=identity.bitwarden.com guide=x",
				),
			]),
			assistant([
				toolUse("cred", "mcp__claude-code-remote__request_credential"),
			]),
			user([toolResult("cred", "saved")]),
			assistant([text("Saved; the run continues.")]),
			user("next"),
		]);
		expect(auditHandOff(parseClaudeTranscript(asked))).toEqual([]);
	});

	it("ignores source code that merely names the codes", () => {
		const transcript = jsonl([
			user("read it"),
			assistant([toolUse("read", "Read")]),
			user([
				toolResult(
					"read",
					'return refused("HOBO_CD_STORE_CHOICE", "Choose your secret store first")',
				),
			]),
			assistant([text("That is where the refusal is made.")]),
			user("ok"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toEqual([]);
	});
});

describe("EVAL hand-off transcript: once a store is chosen, ask only about it", () => {
	it("flags a store choice that shares its picker with another store's follow-up", () => {
		// What the owner hit: store and Bitwarden server in one picker; they
		// chose Infisical and still had to answer a Bitwarden question.
		const transcript = jsonl([
			...runAndRead,
			assistant([
				toolUse("ask", "AskUserQuestion", {
					questions: [
						STORE_QUESTION,
						question(
							"Bitwarden",
							"If you choose Bitwarden: where does your vault live?",
							["bitwarden.com (US)", "bitwarden.eu", "Self-hosted"],
						),
					],
				}),
			]),
			user([
				toolResult(
					"ask",
					'Your questions have been answered: "Which secret store should hobo cd up use?"="Infisical", "If you choose Bitwarden: where does your vault live?"="bitwarden.com (US)".',
				),
			]),
			assistant([text("Infisical it is.")]),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toMatchObject([
			{ rule: "store-choice-alone" },
		]);
	});

	it("flags a follow-up that names another store after the owner chose one", () => {
		const transcript = jsonl([
			...runAndRead,
			assistant([
				toolUse("ask", "AskUserQuestion", { questions: [STORE_QUESTION] }),
			]),
			user([
				toolResult(
					"ask",
					'"Which secret store should hobo cd up use?"="Infisical"',
				),
			]),
			assistant([
				toolUse("next", "AskUserQuestion", {
					questions: [
						question("Server", "Is your Bitwarden vault self-hosted?", [
							"Yes",
							"No",
						]),
					],
				}),
			]),
			user([toolResult("next", '"Is your Bitwarden vault self-hosted?"="No"')]),
			assistant([text("ok")]),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toMatchObject([
			{ rule: "chosen-store-only" },
		]);
	});

	it("passes the store alone, then only the chosen store's follow-up", () => {
		const transcript = jsonl([
			...runAndRead,
			assistant([
				toolUse("ask", "AskUserQuestion", { questions: [STORE_QUESTION] }),
			]),
			user([
				toolResult(
					"ask",
					'"Which secret store should hobo cd up use?"="Infisical"',
				),
			]),
			assistant([
				toolUse("project", "AskUserQuestion", {
					questions: [
						question("Infisical", "Which Infisical project?", [
							"The relay's project",
							"Another project",
						]),
					],
				}),
			]),
			user([
				toolResult(
					"project",
					'"Which Infisical project?"="The relay\'s project"',
				),
			]),
			assistant([text("Running again with Infisical.")]),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toEqual([]);
	});
});

describe("EVAL hand-off transcript: a remote sign-in goes through the capture form", () => {
	const SIGN_IN =
		"HOBO_OWNER_SIGN_IN url=https://app.infisical.com/login?callback_port=41234 capture=INFISICAL_CLI_SESSION";
	it("flags a sign-in relayed only in prose", () => {
		const transcript = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([text("Sign in at the link and paste the token here.")]),
			user("ok"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toMatchObject([
			{ rule: "structured-ask", ask: "capture" },
		]);
	});

	it("flags the session's credential form for a value the run itself must read", () => {
		// request_credential feeds the network proxy; the waiting run never sees it.
		const transcript = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([
				toolUse("cred", "mcp__claude-code-remote__request_credential"),
			]),
			user([toolResult("cred", "saved")]),
			assistant([text("Saved.")]),
			user("next"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toMatchObject([
			{ rule: "structured-ask", ask: "capture" },
		]);
	});

	it("a HOBO_OWNER_CAPTURE line needs the HoBo capture form", () => {
		const line =
			"HOBO_OWNER_CAPTURE name=ONEPASSWORD_SECRET_KEY guide=https://my.1password.com/profile";
		const prose = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${line}`)]),
			assistant([text("Paste your Secret Key here.")]),
			user("ok"),
		]);
		expect(auditHandOff(parseClaudeTranscript(prose))).toMatchObject([
			{
				ask: "capture",
				line: "HOBO_OWNER_CAPTURE name=ONEPASSWORD_SECRET_KEY",
			},
		]);
		const asked = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${line}`)]),
			assistant([toolUse("cap", "mcp__hobo__capture_secret")]),
			user([
				toolResult(
					"cap",
					JSON.stringify({ channel: "form-elicitation", status: "stored" }),
				),
			]),
			assistant([text("Stored; running again.")]),
			user("done"),
		]);
		expect(auditHandOff(parseClaudeTranscript(asked))).toEqual([]);
	});

	it("flags opening the form in the turn the sign-in link arrived (the owner never had the link)", () => {
		// Derived from the live run: cd refused with the link, and the agent
		// called capture_secret at once. The host's form blocked the chat; the
		// owner had no link to sign in with, and the form timed out.
		const URL = SIGN_IN.split(" ")[1]?.replace("url=", "") ?? "";
		const transcript = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([toolUse("cap", "mcp__hobo__capture_secret")]),
			user([
				toolResult(
					"cap",
					"MCP server tool capture_secret timed out after 60s. The server asked the user a question, and no answer came.",
					true,
				),
			]),
			assistant([text(`Sign in at ${URL}`)]),
			user("I couldn't click it."),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toContainEqual(
			expect.objectContaining({ rule: "form-before-link" }),
		);
	});

	it("passes: a host with a link prompt shows the link itself before the form, in one call", () => {
		const transcript = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([toolUse("cap", "mcp__hobo__capture_secret")]),
			user([
				toolResult(
					"cap",
					JSON.stringify({ status: "stored", linkShownBy: "host" }),
				),
			]),
			assistant([text("Stored; running again.")]),
			user("ok"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toEqual([]);
	});

	it("passes: the link in chat first, the owner copies, then the host's form", () => {
		const URL = SIGN_IN.split(" ")[1]?.replace("url=", "") ?? "";
		const transcript = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([
				text(
					`**[Sign in to Infisical](${URL})**\n\nWhen it says *Unable to reach CLI*, click **Copy to clipboard** and tell me.`,
				),
			]),
			user("copied"),
			assistant([toolUse("cap", "mcp__hobo__capture_secret")]),
			user([
				toolResult(
					"cap",
					JSON.stringify({
						status: "stored",
						hostSupport: { formElicitation: true },
					}),
				),
			]),
			assistant([text("Stored; running again.")]),
			user("ok"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toEqual([]);
	});

	it("still flags a turn that shows the link but never opens the form after the owner says they copied it", () => {
		const URL = SIGN_IN.split(" ")[1]?.replace("url=", "") ?? "";
		const transcript = jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([text(`[Sign in to Infisical](${URL})`)]),
			user("copied"),
			assistant([text("Paste it here.")]),
			user("ok"),
		]);
		expect(auditHandOff(parseClaudeTranscript(transcript))).toMatchObject([
			{ rule: "structured-ask", ask: "capture" },
		]);
	});
});

describe("EVAL hand-off transcript: never send the owner to a form the host did not show", () => {
	// Derived from this conversation: the capture result said
	// channel "preview-page", and the agent wrote "Open the HoBo secret form in
	// this session's preview pane". The owner had no such form.
	const SIGN_IN =
		"HOBO_OWNER_SIGN_IN url=https://app.infisical.com/login?callback_port=39863 capture=INFISICAL_CLI_SESSION";
	/** What capture_secret's structuredContent says about its form. */
	type CaptureView = {
		readonly channel?: string;
		readonly state?: string;
		readonly status?: string;
		readonly code?: string;
	};
	const captured = (structured: CaptureView, reply: string) =>
		jsonl([
			user("go"),
			assistant([toolUse("run", "mcp__hobo__cd")]),
			user([toolResult("run", `refused\n${SIGN_IN}`)]),
			assistant([toolUse("cap", "mcp__hobo__capture_secret")]),
			user([toolResult("cap", JSON.stringify(structured))]),
			assistant([text(reply)]),
			user("There is no form for me to open."),
		]);

	it("flags telling the owner to open a form after a box-served or preview capture", () => {
		for (const channel of ["preview-page", "loopback-page", "url-elicitation"])
			expect(
				auditHandOff(
					parseClaudeTranscript(
						captured(
							{ channel, state: "awaiting-owner" },
							"Open the HoBo secret form in this session's preview pane, enter pairing code FX8J-PSRQ and paste what you copied.",
						),
					),
				),
			).toContainEqual(expect.objectContaining({ rule: "phantom-form" }));
	});

	it("flags telling the owner to open a form when the capture refused for lack of one", () => {
		expect(
			auditHandOff(
				parseClaudeTranscript(
					captured(
						{ code: "SECRET_CAPTURE_NO_OWNER_FORM" },
						"Paste it into the HoBo form.",
					),
				),
			),
		).toContainEqual(expect.objectContaining({ rule: "phantom-form" }));
	});

	it("passes when the host itself showed the form (MCP App, or its elicitation form)", () => {
		for (const structured of [
			{ channel: "mcp-app", state: "awaiting-owner" },
			{ channel: "form-elicitation", state: "stored" },
		])
			expect(
				auditHandOff(
					parseClaudeTranscript(
						captured(structured, "Paste it into the form shown above."),
					),
				).filter((f) => f.rule === "phantom-form"),
			).toEqual([]);
	});
});
