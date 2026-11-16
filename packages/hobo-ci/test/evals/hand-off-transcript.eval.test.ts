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

const toolUse = (id: string, name: string) => ({
	type: "tool_use" as const,
	id,
	name,
	input: {},
});
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
