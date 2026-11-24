import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as z from "zod";

export const OWNER_RETEST_PHRASES: readonly RegExp[] = [
	/\b(?:sign|log)\s*(?:back\s+)?in\s+(?:again|once more)\b/iu,
	/\bre-?(?:sign|log)[\s-]?in\b/iu,
	/\bre-?authenticate\b/iu,
	/\bre-?submit\b/iu,
	/\bsubmit\s+(?:the|your|that)\s+(?:\w+\s+){0,3}form\s+again\b/iu,
	/\b(?:fill|complete)\s+(?:in|out)?\s*(?:the|your|that)\s+(?:\w+\s+){0,3}form\s+again\b/iu,
	/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:re-?test|test\s+(?:it|this|that|again)|try\s+(?:it\s+|this\s+|that\s+)?again|(?:manually\s+)?(?:verify|check|confirm)\s+(?:it|this|that)\s+(?:manually|yourself|by\s+hand)?)/iu,
	/\bplease\s+(?:re-?test|test\s+(?:it|this|that|again)|try\s+(?:it\s+|this\s+|that\s+)?again|manually\s+(?:test|verify|check))\b/iu,
	/\b(?:test|verify|check)\s+(?:it|this|that)\s+(?:manually|yourself|by\s+hand)\b/iu,
	/\blet\s+me\s+know\s+(?:if|whether|once|when)\s+(?:it|this|that|the\s+\w+)\s+(?:works|worked|succeeds|renders|shows)\b/iu,
];

export const OWNER_RETEST_REFUSAL =
	"Your final message asks the owner to sign in again, re-submit a form or test by hand. Verify it yourself instead: render the owner page through the channel that displays it, read the result or the sealed submission, run the check, and report the evidence. Ask the owner to act again only when this turn's owner-session status is sign-in-needed with a reason, and quote that reason. See the hobo-setup skill.";

const SIGN_IN_NEEDED = /\\*"status\\*"\s*:\s*\\*"sign-in-needed\\*"/u;
const WITH_REASON = /\\*"reason\\*"\s*:\s*\\*"[^"\\\s]/u;

export function asksOwnerToRetest(message: string): boolean {
	const prose = message
		.replaceAll(/```[\s\S]*?```/gu, " ")
		.replaceAll(/`[^`\n]*`/gu, " ")
		.replaceAll(/^\s*>.*$/gmu, " ");
	return OWNER_RETEST_PHRASES.some((phrase) => phrase.test(prose));
}

type Entry = Readonly<{ role: string; text: string; raw: string }>;

const Block = z
	.object({ type: z.string(), text: z.string().optional() })
	.loose();
const Content = z.union([
	z.string(),
	z.array(Block.catch({ type: "unreadable" })).transform((blocks) =>
		blocks
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n"),
	),
]);
const Line = z
	.object({
		type: z.string().optional(),
		role: z.string().optional(),
		content: Content.optional(),
		message: z
			.object({ role: z.string().optional(), content: Content.optional() })
			.loose()
			.optional(),
	})
	.loose();

export function readTranscript(text: string): Entry[] {
	return text.split("\n").flatMap((raw) => {
		if (raw.trim() === "") return [];
		let parsed: z.ZodSafeParseResult<z.infer<typeof Line>>;
		try {
			parsed = Line.safeParse(JSON.parse(raw));
		} catch {
			return [];
		}
		if (!parsed.success) return [];
		const line = parsed.data;
		const role = line.message?.role ?? line.role ?? line.type ?? "";
		return [{ role, text: line.message?.content ?? line.content ?? "", raw }];
	});
}

function isHumanTurn(entry: Entry): boolean {
	return (
		entry.role === "user" &&
		entry.text.trim() !== "" &&
		!entry.raw.includes('"tool_result"') &&
		!entry.text.startsWith("HoBo completion review (automatic")
	);
}

export function currentTurn(entries: readonly Entry[]): readonly Entry[] {
	const fromEnd = [...entries].reverse().findIndex(isHumanTurn);
	return fromEnd < 0 ? entries : entries.slice(entries.length - fromEnd);
}

export function reportedSignInNeeded(turn: readonly Entry[]): boolean {
	return turn.some(
		(entry) => SIGN_IN_NEEDED.test(entry.raw) && WITH_REASON.test(entry.raw),
	);
}

export function ownerRetestRefusal(
	finalMessage: string,
	turn: readonly Entry[],
): string | undefined {
	if (!asksOwnerToRetest(finalMessage)) return undefined;
	if (reportedSignInNeeded(turn)) return undefined;
	return OWNER_RETEST_REFUSAL;
}

const StopEvent = z
	.object({
		transcript_path: z.string().optional(),
		last_assistant_message: z.string().optional(),
	})
	.loose();

export type HookFormat = "claude" | "codex" | "cursor" | "copilot";

export function decide(
	event: z.infer<typeof StopEvent>,
	read: (path: string) => string,
): string | undefined {
	let entries: Entry[] = [];
	if (event.transcript_path !== undefined)
		try {
			entries = readTranscript(read(event.transcript_path));
		} catch {
			entries = [];
		}
	const turn = currentTurn(entries);
	const final =
		event.last_assistant_message ??
		[...turn]
			.reverse()
			.find((entry) => entry.role === "assistant" && entry.text !== "")?.text ??
		"";
	return ownerRetestRefusal(final, turn);
}

export function answer(format: HookFormat, refusal: string | undefined) {
	if (refusal === undefined) return "{}";
	if (format === "cursor") return JSON.stringify({ followup_message: refusal });
	return JSON.stringify({ decision: "block", reason: refusal });
}

function main(args: readonly string[]): number {
	const format = z
		.enum(["claude", "codex", "cursor", "copilot"])
		.catch("claude")
		.parse(
			args
				.find((arg) => arg.startsWith("--format="))
				?.slice("--format=".length),
		);
	let event: z.infer<typeof StopEvent> = {};
	try {
		const parsed = StopEvent.safeParse(JSON.parse(readFileSync(0, "utf8")));
		if (parsed.success) event = parsed.data;
	} catch {
		event = {};
	}
	process.stdout.write(
		`${answer(
			format,
			decide(event, (path) => readFileSync(path, "utf8")),
		)}\n`,
	);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main(process.argv.slice(2));
