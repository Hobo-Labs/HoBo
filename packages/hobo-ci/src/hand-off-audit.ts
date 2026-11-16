import { z } from "zod";

/**
 * Audit an agent's transcript of a handed-off ceremony: did the owner get
 * the experience the hobo-deploy skill requires?
 *
 * A handed-off run prints owner-facing lines. Each one needs a **structured
 * ask** before the agent's turn ends, never a question in prose:
 *
 * - a choice (`HOBO_CI_STORE_CHOICE` / `HOBO_CD_STORE_CHOICE`, an
 *   organization to pick): the HoBo MCP App's `choose_secret_store`
 *   (elicitation or widget), else the host's own picker (`AskUserQuestion`);
 * - a credential (`HOBO_OWNER_CREDENTIAL host=…`): the session's credential
 *   form (`request_credential`).
 *
 * An ask that did not complete (interrupted, refused, errored) does not
 * count: the agent must issue it again before ending a turn. Each turn that
 * ends with the ask still owed is one finding.
 */

export type AskKind = "choice" | "credential";

export type TranscriptBlock =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool_use";
			readonly id: string;
			readonly name: string;
	  }
	| {
			readonly kind: "tool_result";
			readonly toolUseId: string;
			readonly text: string;
			readonly isError: boolean;
	  };

export interface TranscriptEvent {
	readonly role: "assistant" | "user";
	readonly blocks: readonly TranscriptBlock[];
	/** Where it came from (a transcript line number), for findings. */
	readonly at: number;
}

export interface HandOffFinding {
	readonly rule: "structured-ask";
	readonly ask: AskKind;
	/** The owner-facing line that opened the obligation. */
	readonly line: string;
	/** Where the turn ended without the ask. */
	readonly at: number;
	readonly detail: string;
}

// public-contract: the tools that count as a structured ask, by kind.
export const STRUCTURED_ASK_TOOLS = {
	choice: /^(AskUserQuestion|mcp__[\w-]+__choose_secret_store)$/u,
	credential: /^(mcp__[\w-]+__)?request_credential$/u,
} satisfies Readonly<Record<AskKind, RegExp>>;

/** Owner-facing lines as the CLI prints them (not source code that names them). */
const OWNER_LINES: readonly { readonly ask: AskKind; readonly re: RegExp }[] = [
	{ ask: "choice", re: /^HOBO_C[ID]_STORE_CHOICE$/mu },
	{ ask: "choice", re: /^HOBO_C[ID]_BITWARDEN_ORGANIZATION$/mu },
	{ ask: "credential", re: /^HOBO_OWNER_CREDENTIAL host=\S+/mu },
];

/** A result that means the ask never reached the owner or was not answered. */
const NOT_COMPLETED =
	/Tool call not completed|interrupted|was denied|declined|cancell?ed/iu;

/** A tool result's text: a string, or the text parts of a content list. */
const resultText = z
	.union([
		z.string(),
		z
			.array(z.object({ text: z.string().optional() }).passthrough())
			.transform((parts) => parts.map((part) => part.text ?? "").join("\n")),
	])
	.catch("");

/** One content block, parsed straight into the audit's own type. */
const block = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("text"), text: z.string() })
		.transform((b): TranscriptBlock => ({ kind: "text", text: b.text })),
	z
		.object({ type: z.literal("tool_use"), id: z.string(), name: z.string() })
		.transform(
			(b): TranscriptBlock => ({ kind: "tool_use", id: b.id, name: b.name }),
		),
	z
		.object({
			type: z.literal("tool_result"),
			tool_use_id: z.string(),
			content: resultText,
			is_error: z.boolean().optional(),
		})
		.transform(
			(b): TranscriptBlock => ({
				kind: "tool_result",
				toolUseId: b.tool_use_id,
				text: b.content,
				isError: b.is_error === true,
			}),
		),
]);

const line = z.object({
	message: z.object({
		role: z.enum(["assistant", "user"]),
		content: z.union([
			z
				.string()
				.transform((text): TranscriptBlock[] => [{ kind: "text", text }]),
			// Blocks the audit does not read (images, thinking) are skipped.
			z.array(z.unknown()).transform((items) =>
				items.flatMap((item) => {
					const parsed = block.safeParse(item);
					return parsed.success ? [parsed.data] : [];
				}),
			),
		]),
	}),
});

/** Parse a Claude Code transcript (one JSON object per line). */
export function parseClaudeTranscript(jsonl: string): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	jsonl.split("\n").forEach((raw, index) => {
		if (raw.trim() === "") return;
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return;
		}
		const parsed = line.safeParse(json);
		if (!parsed.success) return;
		events.push({
			role: parsed.data.message.role,
			blocks: parsed.data.message.content,
			at: index + 1,
		});
	});
	return events;
}

/** A user event with no tool result: a person, or the host, started a new turn. */
function startsTurn(event: TranscriptEvent): boolean {
	return (
		event.role === "user" && !event.blocks.some((b) => b.kind === "tool_result")
	);
}

/** Check every owner-facing line got a structured ask before its turn ended. */
export function auditHandOff(
	events: readonly TranscriptEvent[],
): HandOffFinding[] {
	const findings: HandOffFinding[] = [];
	const owed = new Map<AskKind, string>();
	// Asks issued, awaiting their result: tool-use id → kind.
	const pending = new Map<string, AskKind>();
	const endTurn = (at: number) => {
		for (const [ask, opened] of owed) {
			// A turn that issued the ask is not a failure, even if it did not
			// complete (interrupted, restarted); the next turn must ask again.
			if (askedThisTurn.has(ask)) continue;
			findings.push({
				rule: "structured-ask",
				ask,
				line: opened,
				at,
				detail:
					ask === "choice"
						? "The turn ended without a completed structured choice (choose_secret_store or AskUserQuestion); asking in prose, or not re-asking after an interrupted picker, leaves the owner without the widget."
						: "The turn ended without the session's credential form (request_credential) for the line's host.",
			});
		}
	};
	const askedThisTurn = new Set<AskKind>();
	let sawTurn = false;
	for (const event of events) {
		if (startsTurn(event)) {
			if (sawTurn) endTurn(event.at);
			askedThisTurn.clear();
			sawTurn = true;
			continue;
		}
		sawTurn = true;
		for (const b of event.blocks) {
			if (b.kind === "tool_use") {
				for (const ask of ["choice", "credential"] as const)
					if (STRUCTURED_ASK_TOOLS[ask].test(b.name)) {
						pending.set(b.id, ask);
						askedThisTurn.add(ask);
					}
			} else if (b.kind === "tool_result") {
				const ask = pending.get(b.toolUseId);
				if (ask !== undefined) {
					pending.delete(b.toolUseId);
					// Only a completed ask settles what is owed.
					if (!b.isError && !NOT_COMPLETED.test(b.text)) owed.delete(ask);
					continue;
				}
				for (const owner of OWNER_LINES) {
					const match = owner.re.exec(b.text);
					if (match !== null) owed.set(owner.ask, match[0]);
				}
			}
		}
	}
	// The transcript ends mid-turn: whatever is still owed was never asked.
	const last = events.at(-1);
	if (last !== undefined && last.role === "assistant") endTurn(last.at);
	return findings;
}
