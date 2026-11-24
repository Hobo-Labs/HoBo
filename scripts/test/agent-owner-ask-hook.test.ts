import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	answer,
	asksOwnerToRetest,
	decide,
	OWNER_RETEST_PHRASES,
	OWNER_RETEST_REFUSAL,
} from "../agent-owner-ask-hook.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = join(root, "scripts/agent-owner-ask-hook.mts");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const ASKS = [
	"The relay restarted. Please sign in again so I can continue.",
	"Could you log back in once more?",
	"You will need to re-sign-in to Infisical.",
	"Please resubmit the store form.",
	"Submit the store choice form again when you are ready.",
	"Can you test it and tell me what you see?",
	"Could you try again now?",
	"Please manually test the owner page.",
	"Check it yourself in the browser.",
	"Let me know if it works.",
	"Could you re-test the sign-in?",
	"You may need to re-authenticate with Infisical.",
	"Fill out the owner page form again with the new token.",
];

const STATEMENTS = [
	"I rendered the owner page, read the sealed result and the store session is established.",
	"All four tests pass; the hook refuses the command.",
	"I tested it myself: `pnpm run test:scripts` passes.",
	"```sh\nhobo login --relay # sign in again\n```",
	"The owner signed in and the status is established.",
];

type Block = Readonly<Record<string, string>>;
type StopInput = Readonly<{ last_assistant_message?: string }>;

function claudeLine(
	role: "user" | "assistant",
	content: string | readonly Block[],
): string {
	return JSON.stringify({ type: role, message: { role, content } });
}

function transcript(lines: readonly string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-owner-ask-"));
	scratch.push(dir);
	const path = join(dir, "transcript.jsonl");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

function signInNeeded(reason?: string): string {
	const status = {
		status: "sign-in-needed",
		store: "Infisical",
		code: "HOBO_OWNER_SIGN_IN",
	};
	const reported = reason === undefined ? status : { ...status, reason };
	return claudeLine("user", [
		{
			type: "tool_result",
			tool_use_id: "t1",
			content: JSON.stringify(reported),
		},
	]);
}

function run(format: string, event: StopInput) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", hook, `--format=${format}`],
		{ cwd: root, input: JSON.stringify(event), encoding: "utf8" },
	);
}

describe("the stop check against asking the owner to retest", () => {
	it("keeps every phrase in one exported list", () => {
		assert.ok(OWNER_RETEST_PHRASES.length >= 8);
		for (const phrase of OWNER_RETEST_PHRASES)
			assert.ok(
				ASKS.some((ask) => phrase.test(ask)),
				`${phrase} has a covering example`,
			);
	});

	it("recognizes asks to sign in again, resubmit, or test by hand", () => {
		for (const ask of ASKS) assert.ok(asksOwnerToRetest(ask), ask);
	});

	it("leaves reports of verified results and quoted commands alone", () => {
		for (const statement of STATEMENTS)
			assert.equal(asksOwnerToRetest(statement), false, statement);
	});

	it("blocks a final message that asks the owner to retest without a sign-in-needed status", () => {
		const path = transcript([
			claudeLine("user", "Connect the store."),
			claudeLine("assistant", [{ type: "text", text: "Working on it." }]),
			claudeLine("assistant", [
				{ type: "text", text: "Please sign in again and resubmit the form." },
			]),
		]);
		assert.equal(
			decide({ transcript_path: path }, (file) => readFileSync(file, "utf8")),
			OWNER_RETEST_REFUSAL,
		);
	});

	it("allows the ask when this turn reported sign-in-needed with a reason", () => {
		const path = transcript([
			claudeLine("user", "Connect the store."),
			signInNeeded("Infisical refused the session token"),
			claudeLine("assistant", [
				{
					type: "text",
					text: "Infisical refused the session token. Please sign in again.",
				},
			]),
		]);
		assert.equal(
			decide({ transcript_path: path }, (file) => readFileSync(file, "utf8")),
			undefined,
		);
	});

	it("still blocks when the status had no reason or came from an earlier turn", () => {
		for (const lines of [
			[
				claudeLine("user", "Connect the store."),
				signInNeeded(),
				claudeLine("assistant", [
					{ type: "text", text: "Please sign in again." },
				]),
			],
			[
				claudeLine("user", "Connect the store."),
				signInNeeded("Infisical refused the session token"),
				claudeLine("assistant", [{ type: "text", text: "Waiting." }]),
				claudeLine("user", "Status?"),
				claudeLine("assistant", [
					{ type: "text", text: "Could you try again?" },
				]),
			],
		])
			assert.equal(
				decide({ transcript_path: transcript(lines) }, (file) =>
					readFileSync(file, "utf8"),
				),
				OWNER_RETEST_REFUSAL,
			);
	});

	it("prefers the harness's last assistant message and survives a missing transcript", () => {
		assert.equal(
			decide(
				{
					transcript_path: join(
						dirname(transcript([])),
						"removed-transcript.jsonl",
					),
					last_assistant_message: "Let me know if it works.",
				},
				(file) => readFileSync(file, "utf8"),
			),
			OWNER_RETEST_REFUSAL,
		);
		assert.equal(
			decide({}, (file) => readFileSync(file, "utf8")),
			undefined,
		);
	});

	it("answers each harness's stop protocol and is wired into each", () => {
		const blocked = run("claude", {
			last_assistant_message: "Please re-test the owner page.",
		});
		assert.equal(blocked.status, 0);
		assert.deepEqual(JSON.parse(blocked.stdout), {
			decision: "block",
			reason: OWNER_RETEST_REFUSAL,
		});
		assert.deepEqual(JSON.parse(answer("cursor", OWNER_RETEST_REFUSAL)), {
			followup_message: OWNER_RETEST_REFUSAL,
		});
		const allowed = run("codex", {
			last_assistant_message: "Done; tests pass.",
		});
		assert.deepEqual(JSON.parse(allowed.stdout), {});
		for (const file of [
			".claude/settings.json",
			".codex/hooks.json",
			".cursor/hooks.json",
			".github/hooks/completion-review.json",
		])
			assert.match(
				readFileSync(join(root, file), "utf8"),
				/scripts\/agent-owner-ask-hook\.mts/u,
				file,
			);
	});
});
