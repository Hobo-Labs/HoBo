import { z } from "zod";

const jsonValue = z.json();
const jsonString = z.string();
const jsonArray = z.array(jsonValue);
const jsonObject = z.record(z.string(), jsonValue);
type JsonValue = z.infer<typeof jsonValue>;

export type AskKind = "choice" | "capture";

export type TranscriptBlock =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool_use";
			readonly id: string;
			readonly name: string;
			/** A picker's questions: each one's text, header and options together. */
			readonly questions: readonly string[];
			readonly privateInput?: boolean;
	  }
	| {
			readonly kind: "tool_result";
			readonly toolUseId: string;
			readonly text: string;
			readonly isError: boolean;
			readonly structuredContent?: JsonValue | undefined;
	  };

export interface TranscriptEvent {
	readonly role: "assistant" | "user";
	readonly blocks: readonly TranscriptBlock[];
	/** Where it came from (a transcript line number), for findings. */
	readonly at: number;
}

export interface HandOffFinding {
	/**
	 * - `structured-ask`: a turn ended with an owner-facing line unasked.
	 * - `store-choice-alone`: the store choice shared its picker with other
	 *   questions (a store's follow-up asked before the owner chose it).
	 * - `chosen-store-only`: after the owner chose a store, a question named
	 *   another one.
	 * - `form-before-link`: the agent opened the capture form in the turn a
	 *   sign-in link arrived, before the owner had the link: a host's form
	 *   blocks the chat, so the owner could not see or click it.
	 * - `phantom-form`: the agent sent the owner to a form or page after a
	 *   capture whose form the host never showed (a page served on the box,
	 *   or a refusal for lack of any form).
	 */
	readonly rule:
		| "structured-ask"
		| "store-choice-alone"
		| "chosen-store-only"
		| "phantom-form"
		| "form-before-link"
		| "private-owner-line"
		| "private-owner-request"
		| "private-owner-exposure"
		| "agent-stored-credential";
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
	// A value the waiting run itself reads: only HoBo's capture reaches it
	// (the session's credential form feeds the network proxy, not the run).
	capture: /^mcp__[\w-]+__capture_secret$/u,
} satisfies Readonly<Record<AskKind, RegExp>>;

const AGENT_CREDENTIAL_STORE = /^(?:mcp__[\w-]+__)?request_credential$/u;

/** Owner-facing lines as the CLI prints them (not source code that names them). */
const OWNER_LINES: readonly { readonly ask: AskKind; readonly re: RegExp }[] = [
	{ ask: "choice", re: /^HOBO_C[ID]_STORE_CHOICE$/mu },
	{ ask: "choice", re: /^HOBO_C[ID]_BITWARDEN_ORGANIZATION$/mu },
	{ ask: "capture", re: /HOBO_OWNER_SIGN_IN url=\S+ capture=\S+/u },
	{ ask: "capture", re: /^HOBO_OWNER_CAPTURE name=\S+/mu },
];

const ASK_DETAIL = {
	choice:
		"The turn ended without a completed structured choice (choose_secret_store or AskUserQuestion); asking in prose, or not re-asking after an interrupted picker, leaves the owner without the widget.",
	capture:
		"The turn ended without HoBo's secret capture (capture_secret) for the value the run is waiting for; the run reads it only from there, never from chat or the session's credential form.",
} satisfies Readonly<Record<AskKind, string>>;

/** A capture result whose form the owner never saw: a box-served page, or none at all. */
const NO_HOST_FORM =
	/"channel":\s*"(preview-page|loopback-page|url-elicitation)"|SECRET_CAPTURE_NO_OWNER_FORM/u;
/** A capture result whose form the host showed, or that completed. */
const HOST_FORM =
	/"channel":\s*"(mcp-app|form-elicitation)"|"status":\s*"(stored|authorized)"|The owner is entering [^\n]{1,200} in the HoBo form shown with this result\./u;
/** Words that send the owner to a form or page. */
const SENDS_TO_A_FORM =
	/\b(open|use|type|paste|enter|fill)\b[^.]{0,80}\b(form|page|preview|pane)\b/i;
const REPORTS_NO_SECURE_HANDOFF =
	/\b(?:this|the)\s+host\b[^.\n]{0,100}\b(?:cannot|can't|does not|doesn't|has no|lacks)\b[^.\n]{0,100}\b(?:secure|private)\b[^.\n]{0,80}\b(?:form|hand-?off|channel)\b/i;
const PRIVATE_OWNER_REQUEST =
	/\b(?:paste|send|share|give|provide|enter|type|tell|what(?:'s|\s+is)|which|may\s+i\s+(?:have|know)|can\s+i\s+(?:have|know))\b[^.!?\n]{0,100}?\b(?:secret(?:\s+key)?(?!\s+(?:store|manager)\b)|password|token|credentials?|(?:project|vault|org(?:anization)?|identity|account|tenant|connection)\s+(?:id|identifier|reference)|(?:client|private|api)\s+(?:id|secret|key))\b/gi;
const OWNER_FORM_DESTINATION =
	/\b(?:in|into|through|using)\s+(?:the|a|your)\s+(?:(?:secure|private|owner|hobo|shown)\s+){0,4}form\b/i;
const UNSAFE_DESTINATION =
	/\b(?:here|to me|to the agent|(?:send|give|tell|share)\s+(?:it\s+)?(?:to\s+)?me|(?:in|through|via|over)\s+(?:the\s+)?(?:chat|conversation|command|terminal))\b/i;

function asksForPrivateOwnerData(
	text: string,
	ownerFormVisible: boolean,
): boolean {
	for (const match of text.matchAll(PRIVATE_OWNER_REQUEST)) {
		const before = text
			.slice(Math.max(0, (match.index ?? 0) - 80), match.index)
			.split(/[.!?;\n]|\b(?:but|however|yet|instead)\b/i)
			.at(-1);
		if (/\b(?:never|don't|do not|must not|should not)\b/i.test(before ?? ""))
			continue;
		const sentence = text.slice(match.index).split(/[.!?\n]/u)[0] ?? "";
		if (
			ownerFormVisible &&
			OWNER_FORM_DESTINATION.test(sentence) &&
			!UNSAFE_DESTINATION.test(sentence)
		)
			continue;
		return true;
	}
	return false;
}

/** A result that means the ask never reached the owner or was not answered. */
const NOT_COMPLETED =
	/Tool call not completed|interrupted|was denied|declined|cancell?ed|unanswered|"(?:state|status)":\s*"awaiting-owner"|The owner is entering [^\n]{1,200} in the HoBo form shown with this result\./i;

type PrivateOwnerPart = {
	readonly value: string;
	readonly line: string;
	readonly ask: AskKind;
};

function privateOwnerParts(output: string): PrivateOwnerPart[] {
	const parts: PrivateOwnerPart[] = [];
	const patterns: readonly {
		readonly re: RegExp;
		readonly line: string;
		readonly ask: AskKind;
	}[] = [
		{
			re: /HOBO_OWNER_SIGN_IN url=(\S+) capture=\S+/gu,
			line: "HOBO_OWNER_SIGN_IN",
			ask: "capture",
		},
		{
			re: /^HOBO_OWNER_CAPTURE name=\S+ guide=(\S+)/gmu,
			line: "HOBO_OWNER_CAPTURE",
			ask: "capture",
		},
		{
			re: /^HOBO_OWNER_DEVICE\s+(\S+)\s+code=(\S+)/gmu,
			line: "HOBO_OWNER_DEVICE",
			ask: "capture",
		},
		{
			re: /^HOBO_OWNER_BITWARDEN_APPROVE\s+server=(\S+)\s+phrase=(\S+)/gmu,
			line: "HOBO_OWNER_BITWARDEN_APPROVE",
			ask: "capture",
		},
		{
			re: /^HOBO_OWNER_BITWARDEN_APPROVE[^\n]*? collection "[^"]+" of (.+?), and waits/gmu,
			line: "HOBO_OWNER_BITWARDEN_APPROVE",
			ask: "choice",
		},
	];
	for (const pattern of patterns)
		for (const match of output.matchAll(pattern.re))
			for (const value of match.slice(1))
				if (value !== undefined && value.length >= 2)
					parts.push({ value, line: pattern.line, ask: pattern.ask });
	if (/HOBO_C[ID]_BITWARDEN_ORGANIZATION/u.test(output))
		for (const match of output.matchAll(
			/BWS_ORGANIZATION_ID=(\S+)\s+—\s+(.+?)\s+\(a non-secret setting\)/gu,
		))
			for (const value of match.slice(1))
				if (value !== undefined && value.length >= 2)
					parts.push({
						value,
						line: "HOBO_*_BITWARDEN_ORGANIZATION",
						ask: "choice",
					});
	return parts;
}

function containsOwnerPart(text: string, part: string): boolean {
	let offset = text.indexOf(part);
	while (offset !== -1) {
		if (!/^[a-zA-Z0-9_-]+$/u.test(part)) return true;
		const before = text[offset - 1] ?? "";
		const after = text[offset + part.length] ?? "";
		if (!/[a-zA-Z0-9_-]/u.test(before) && !/[a-zA-Z0-9_-]/u.test(after))
			return true;
		offset = text.indexOf(part, offset + 1);
	}
	return false;
}

function ownerOutputText(output: string): string {
	const strings: string[] = [];
	const visit = (value: JsonValue, depth: number): void => {
		if (depth > 12) return;
		const string = jsonString.safeParse(value);
		if (string.success) {
			try {
				const decoded = jsonValue.safeParse(JSON.parse(string.data));
				if (decoded.success && decoded.data !== string.data) {
					visit(decoded.data, depth + 1);
					return;
				}
			} catch {
				strings.push(string.data);
				return;
			}
			strings.push(string.data);
			return;
		}
		const array = jsonArray.safeParse(value);
		if (array.success) {
			for (const item of array.data) visit(item, depth + 1);
			strings.push(JSON.stringify(array.data));
			return;
		}
		const object = jsonObject.safeParse(value);
		if (object.success) {
			for (const item of Object.values(object.data)) visit(item, depth + 1);
			strings.push(JSON.stringify(object.data));
		}
	};
	visit(output, 0);
	return strings.join("\n");
}

function isPrivateField(key: string, capture: boolean): boolean {
	const field = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	return (
		/(?:project|vault|org|organization|identity|account|tenant|connection)(?:id|identifier|reference|ref)$/.test(
			field,
		) ||
		/(?:token|secret|password|credential)s?$/.test(field) ||
		/(?:api|private|access|secret|client|signing|encryption|ssh)keys?(?:id)?$/.test(
			field,
		) ||
		/^(?:authorization|authheader)$/.test(field) ||
		/^(?:host|guide|server|phrase|clientid)$/.test(field) ||
		/(?:serverurl|apiurl|connecthost)$/.test(field) ||
		(capture && /^(?:ref|reference|value|key)$/.test(field))
	);
}

function privateFieldsPresent(
	input: JsonValue | undefined,
	capture: boolean,
): boolean {
	const pending: JsonValue[] = input === undefined ? [] : [input];
	while (pending.length > 0) {
		const value = pending.pop();
		if (value === undefined) continue;
		const string = jsonString.safeParse(value);
		if (string.success) {
			const assignment = /^(?:--)?([a-zA-Z_][\w-]*)=(.+)$/u.exec(string.data);
			if (
				assignment?.[1] !== undefined &&
				isPrivateField(assignment[1], capture)
			)
				return true;
			try {
				const decoded = jsonValue.safeParse(JSON.parse(string.data));
				if (decoded.success && decoded.data !== string.data)
					pending.push(decoded.data);
			} catch {
				if (
					capture &&
					/^\S+ is \w+ \((?!no reference\))[^)]+\)/mu.test(string.data)
				)
					return true;
			}
			continue;
		}
		const array = jsonArray.safeParse(value);
		if (array.success) {
			for (let i = 0; i < array.data.length; i += 1) {
				const item = array.data[i];
				if (item === undefined) continue;
				const text = jsonString.safeParse(item);
				if (text.success) {
					const flag = /^--([a-zA-Z_][\w-]*)$/u.exec(text.data);
					const next = jsonString.safeParse(array.data[i + 1]);
					if (
						flag?.[1] !== undefined &&
						isPrivateField(flag[1], capture) &&
						next.success &&
						next.data !== "" &&
						!next.data.startsWith("--")
					)
						return true;
				}
				pending.push(item);
			}
			continue;
		}
		const object = jsonObject.safeParse(value);
		if (!object.success) continue;
		for (const [key, item] of Object.entries(object.data)) {
			const text = jsonString.safeParse(item);
			if (
				isPrivateField(key, capture) &&
				item !== null &&
				(!text.success || text.data.trim() !== "")
			)
				return true;
			pending.push(item);
		}
	}
	return false;
}

function isOwnerTool(name: string): boolean {
	return /^mcp__[\w-]+__(?:ci|cd|choose_secret_store|submit_store_choice|capture_secret|secret_capture_status)$/u.test(
		name,
	);
}

/** A tool result's text: a string, or the text parts of a content list. */
const resultText = z
	.union([
		z.string(),
		z
			.array(z.object({ text: z.string().optional() }).passthrough())
			.transform((parts) => parts.map((part) => part.text ?? "").join("\n")),
	])
	.catch("");

/** A picker's questions, as text the audit can search. */
const askedQuestions = z
	.object({
		questions: z.array(
			z.object({
				question: z.string(),
				header: z.string().optional(),
				options: z
					.array(
						z.object({
							label: z.string(),
							description: z.string().optional(),
						}),
					)
					.optional(),
			}),
		),
	})
	.transform((input) =>
		input.questions.map((q) =>
			[
				q.header ?? "",
				q.question,
				...(q.options ?? []).flatMap((o) => [o.label, o.description ?? ""]),
			].join("\n"),
		),
	)
	.catch([]);

const asynchronousQuestions = z
	.object({
		questions: z.array(
			z.object({ title: z.string(), options: z.array(z.string()).optional() }),
		),
	})
	.transform((input) =>
		input.questions.map((q) => [q.title, ...(q.options ?? [])].join("\n")),
	)
	.catch([]);

/** One content block, parsed straight into the audit's own type. */
const block = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("text"), text: z.string() })
		.transform((b): TranscriptBlock => ({ kind: "text", text: b.text })),
	z
		.object({
			type: z.literal("tool_use"),
			id: z.string(),
			name: z.string(),
			input: jsonValue.optional(),
		})
		.transform(
			(b): TranscriptBlock => ({
				kind: "tool_use",
				id: b.id,
				name: b.name,
				questions: [
					...askedQuestions.parse(b.input ?? {}),
					...asynchronousQuestions.parse(b.input ?? {}),
				],
				privateInput: privateFieldsPresent(
					b.input,
					/capture_secret/u.test(b.name),
				),
			}),
		),
	z
		.object({
			type: z.literal("tool_result"),
			tool_use_id: z.string(),
			content: resultText,
			is_error: z.boolean().optional(),
			structuredContent: jsonValue.optional(),
		})
		.transform(
			(b): TranscriptBlock => ({
				kind: "tool_result",
				toolUseId: b.tool_use_id,
				text: b.content,
				isError: b.is_error === true,
				structuredContent: b.structuredContent,
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

/** The three stores, as an owner-facing question names them. */
const STORES = [
	{ id: "infisical", re: /\binfisical\b/iu },
	{ id: "1password", re: /\b1password\b/iu },
	{ id: "bitwarden", re: /\b(bitwarden|vaultwarden)\b/iu },
] as const;
type StoreId = (typeof STORES)[number]["id"];

const storesNamed = (text: string): StoreId[] =>
	STORES.filter((store) => store.re.test(text)).map((store) => store.id);

/** The store a completed store-choice ask settled on, if its result names one. */
function chosenStore(result: string): StoreId | undefined {
	// AskUserQuestion: "<question>"="<answer>"; choose_secret_store: "chose <Store>".
	const answer =
		/"="([^"]*)"/u.exec(result)?.[1] ?? /\bchose (\w+)/u.exec(result)?.[1];
	const named = answer === undefined ? [] : storesNamed(answer);
	return named.length === 1 ? named[0] : undefined;
}

/** A user event with no tool result: a person, or the host, started a new turn. */
function startsTurn(event: TranscriptEvent): boolean {
	return (
		event.role === "user" && !event.blocks.some((b) => b.kind === "tool_result")
	);
}

/** Check every owner-facing line got a structured ask before its turn ended. */
type HandOffAuditDefaultOptions = Readonly<{
	ownerFormAvailable?: boolean;
	ownerFormPrivacyVerified?: boolean;
}>;
const handOffAuditDefaultOptions: HandOffAuditDefaultOptions = {};
export const DEFAULT_HAND_OFF_AUDIT_OPTIONS = Object.freeze(
	handOffAuditDefaultOptions,
);

export function auditHandOff(
	events: readonly TranscriptEvent[],
	options: Readonly<{
		ownerFormAvailable?: boolean;
		ownerFormPrivacyVerified?: boolean;
	}> = DEFAULT_HAND_OFF_AUDIT_OPTIONS,
): HandOffFinding[] {
	const findings: HandOffFinding[] = [];
	const owed = new Map<AskKind, string>();
	// Asks issued, awaiting their result: tool-use id → kind.
	const pending = new Map<string, AskKind[]>();
	const ownerForms = new Set<string>();
	const ownerToolUses = new Map<string, string>();
	const formEvidence = new Map<AskKind, "shown" | "unavailable">();
	const endTurn = (at: number) => {
		for (const [ask, opened] of owed) {
			if (
				reportedNoSecureHandoff &&
				((options.ownerFormAvailable === false &&
					formEvidence.get(ask) !== "shown") ||
					(ask === "capture" && noHostForm))
			) {
				owed.delete(ask);
				continue;
			}
			// A turn that issued the ask is not a failure, even if it did not
			// complete (interrupted, restarted); the next turn must ask again.
			if (
				askedThisTurn.has(ask) &&
				!(ask === "capture" && noHostForm) &&
				!(reportedNoSecureHandoff && formEvidence.get(ask) === "shown")
			)
				continue;
			if (ask === "capture" && signIn?.shownTurn === turn) continue;
			findings.push({
				rule: "structured-ask",
				ask,
				line: opened,
				at,
				detail: ASK_DETAIL[ask],
			});
		}
	};
	const askedThisTurn = new Set<AskKind>();
	// The store choice: its ask in flight, and the store the owner chose.
	const storeAsks = new Set<string>();
	let chosen: StoreId | undefined;
	let sawTurn = false;
	// Captures in flight, and whether the last one left the owner without a form.
	const captures = new Set<string>();
	const earlyCaptures = new Set<string>();
	let noHostForm = false;
	let ownerFormVisible = false;
	let reportedNoSecureHandoff = false;
	const privateParts: PrivateOwnerPart[] = [];
	// The last sign-in line: its link, the turn it arrived in, and the turn
	// the agent showed it to the owner.
	let signIn: { url: string; turn: number; shownTurn?: number } | undefined;
	let turn = 0;
	for (const event of events) {
		if (startsTurn(event)) {
			if (sawTurn) endTurn(event.at);
			turn += 1;
			askedThisTurn.clear();
			reportedNoSecureHandoff = false;
			sawTurn = true;
			continue;
		}
		sawTurn = true;
		for (const b of event.blocks) {
			if (
				b.kind === "text" &&
				event.role === "assistant" &&
				asksForPrivateOwnerData(
					b.text,
					ownerFormVisible && options.ownerFormPrivacyVerified === true,
				)
			)
				findings.push({
					rule: "private-owner-request",
					ask: owed.keys().next().value ?? "choice",
					line: owed.values().next().value ?? "HOBO_OWNER_HANDOFF",
					at: event.at,
					detail:
						"The agent asked for an owner identifier or secret in conversation. Use a privacy-verified owner form or report the missing secure hand-off.",
				});
			if (
				b.kind === "text" &&
				event.role === "assistant" &&
				REPORTS_NO_SECURE_HANDOFF.test(b.text)
			)
				reportedNoSecureHandoff = true;
			if (
				b.kind === "text" &&
				event.role === "assistant" &&
				noHostForm &&
				SENDS_TO_A_FORM.test(b.text)
			)
				findings.push({
					rule: "phantom-form",
					ask: "capture",
					line: "capture_secret",
					at: event.at,
					detail:
						"The agent sent the owner to a form or page after a capture whose form the host never showed. Say the host cannot collect it, never point at a form that is not there.",
				});
			if (b.kind === "text" && event.role === "assistant") {
				if (signIn !== undefined && b.text.includes(signIn.url))
					signIn.shownTurn = turn;
				const relayed = privateParts.find((part) =>
					containsOwnerPart(b.text, part.value),
				);
				if (relayed !== undefined)
					findings.push({
						rule: "private-owner-line",
						ask: relayed.ask,
						line: relayed.line,
						at: event.at,
						detail:
							"The agent relayed private owner information in chat. Use a privacy-verified owner form or report the missing secure hand-off.",
					});
			}
			if (b.kind === "tool_use") {
				if (
					b.questions.some((question) =>
						asksForPrivateOwnerData(question, false),
					)
				)
					findings.push({
						rule: "private-owner-request",
						ask: owed.keys().next().value ?? "choice",
						line: owed.values().next().value ?? "HOBO_OWNER_HANDOFF",
						at: event.at,
						detail:
							"The agent asked for an owner identifier or secret in a structured question. Use a privacy-verified owner form or report the missing secure hand-off.",
					});
				if (isOwnerTool(b.name)) {
					ownerToolUses.set(b.id, b.name);
					if (b.privateInput === true)
						findings.push({
							rule: "private-owner-exposure",
							ask: "choice",
							line: "HOBO_OWNER_HANDOFF",
							at: event.at,
							detail:
								"An owner identifier, setting, or secret appeared in an agent-visible tool input.",
						});
				}
				if (AGENT_CREDENTIAL_STORE.test(b.name))
					findings.push({
						rule: "agent-stored-credential",
						ask: "capture",
						line: b.name,
						at: event.at,
						detail:
							"request_credential stores a credential in the agent session's environment, outside the owner's secret store. Hand the value to the waiting run with HoBo's capture_secret instead.",
					});
				if (/^mcp__[\w-]+__capture_secret$/u.test(b.name)) {
					captures.add(b.id);
					if (signIn?.turn === turn && signIn.shownTurn === undefined)
						earlyCaptures.add(b.id);
				}
				const choiceAt = b.questions.findIndex(
					(q) => storesNamed(q).length >= 2,
				);
				if (choiceAt !== -1) {
					storeAsks.add(b.id);
					if (b.questions.length > 1)
						findings.push({
							rule: "store-choice-alone",
							ask: "choice",
							line: "HOBO_*_STORE_CHOICE",
							at: event.at,
							detail:
								"The store choice shared its picker with other questions. Ask it alone; ask the chosen store's follow-ups only after the owner answers.",
						});
				} else if (chosen !== undefined)
					for (const q of b.questions) {
						const other = storesNamed(q).filter((id) => id !== chosen);
						if (other.length > 0)
							findings.push({
								rule: "chosen-store-only",
								ask: "choice",
								line: "HOBO_*_STORE_CHOICE",
								at: event.at,
								detail: `The owner chose ${chosen}, but a later question asked about ${other.join(", ")}. Follow-ups are about the chosen store only.`,
							});
					}
				for (const ask of ["choice", "capture"] as const)
					if (STRUCTURED_ASK_TOOLS[ask].test(b.name)) {
						pending.set(b.id, [...(pending.get(b.id) ?? []), ask]);
						if (b.name !== "AskUserQuestion") {
							ownerForms.add(b.id);
							ownerFormVisible = false;
						}
						askedThisTurn.add(ask);
					}
			} else if (b.kind === "tool_result") {
				const output = [
					ownerOutputText(b.text),
					...(b.structuredContent === undefined
						? []
						: [ownerOutputText(JSON.stringify(b.structuredContent))]),
				].join("\n");
				const ownerTool = ownerToolUses.get(b.toolUseId);
				ownerToolUses.delete(b.toolUseId);
				if (
					ownerTool !== undefined &&
					(privateFieldsPresent(
						b.text,
						/capture_secret|secret_capture_status/u.test(ownerTool),
					) ||
						privateFieldsPresent(
							b.structuredContent,
							/capture_secret|secret_capture_status/u.test(ownerTool),
						))
				)
					findings.push({
						rule: "private-owner-exposure",
						ask: "choice",
						line: "HOBO_OWNER_HANDOFF",
						at: event.at,
						detail:
							"An owner identifier, setting, or secret appeared in an agent-visible tool result.",
					});
				// A form opened before the owner had the link, unless the host
				// itself showed the link first (or the server refused for it).
				if (
					earlyCaptures.delete(b.toolUseId) &&
					!(NO_HOST_FORM.test(output) && !HOST_FORM.test(output)) &&
					!/"linkShownBy":\s*"(?:host|form)"|SECRET_CAPTURE_LINK_FIRST/u.test(
						output,
					)
				)
					findings.push({
						rule: "form-before-link",
						ask: "capture",
						line: "HOBO_OWNER_SIGN_IN",
						at: event.at,
						detail:
							"The host did not show the sign-in link in the owner form. Use a privacy-verified form that includes it or report the missing secure hand-off.",
					});
				if (captures.delete(b.toolUseId)) {
					noHostForm = NO_HOST_FORM.test(output) && !HOST_FORM.test(output);
				}
				if (storeAsks.delete(b.toolUseId) && !NOT_COMPLETED.test(output))
					chosen = chosenStore(output) ?? chosen;
				const asks = pending.get(b.toolUseId);
				if (asks !== undefined) {
					pending.delete(b.toolUseId);
					if (ownerForms.delete(b.toolUseId)) {
						ownerFormVisible =
							HOST_FORM.test(output) &&
							!b.isError &&
							!/declined|cancell?ed|interrupted|"(?:status|state)":\s*"(?:stored|authorized)"/i.test(
								output,
							);
						const shown =
							HOST_FORM.test(output) ||
							(!(asks.includes("capture") && noHostForm) &&
								(NOT_COMPLETED.test(output) ||
									/unanswered|no answer came|asked the user a question/i.test(
										output,
									)));
						for (const ask of asks) {
							if (shown && owed.has(ask)) formEvidence.set(ask, "shown");
							else if (ask === "capture" && noHostForm)
								formEvidence.set(ask, "unavailable");
						}
					}
					// Only a completed ask settles what is owed.
					if (!b.isError && !NOT_COMPLETED.test(output))
						for (const ask of asks)
							if (!(ask === "capture" && noHostForm)) {
								owed.delete(ask);
								formEvidence.delete(ask);
							}
				}
				privateParts.push(...privateOwnerParts(output));
				// An ask's own result can open the next obligation (a capture
				// served for the host's preview names its port).
				for (const owner of OWNER_LINES) {
					const match = owner.re.exec(output);
					if (match === null) continue;
					owed.set(owner.ask, match[0].split(/\s/u, 1)[0] ?? "");
					const link = /HOBO_OWNER_SIGN_IN url=(\S+)/u.exec(match[0]);
					if (link?.[1] !== undefined) signIn = { url: link[1], turn };
					// A new store choice: the owner chooses again.
					if (/STORE_CHOICE/u.test(match[0])) chosen = undefined;
				}
			}
		}
	}
	// The transcript ends mid-turn: whatever is still owed was never asked.
	const last = events.at(-1);
	if (last !== undefined && last.role === "assistant") endTurn(last.at);
	return findings;
}
