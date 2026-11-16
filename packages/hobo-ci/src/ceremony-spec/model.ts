import { z } from "zod";

import { readOwnerTurn } from "../owner-actions.js";
import { APP_HANDOFF_PAGE } from "../remote-app.js";
import { REMOTE_INFEASIBLE } from "../remote-reach.js";
import {
	always,
	and,
	atom,
	eventually,
	type Formula,
	implies,
	not,
	once,
	type Property,
} from "./ltl.js";

/**
 * The remote ceremony as a spec: what the owner's host sees, as events, and
 * the properties every run must satisfy, derived from one declaration of the
 * ceremony (`CEREMONY`) rather than written case by case.
 *
 * A trace is the JSON-RPC traffic between the host and the HoBo MCP server
 * (`eventsFromWire`), so the same properties check the real binary's runs
 * (runtime verification) and every run an explorer generates.
 */

/** One thing the owner's host saw or did, in order. */
export type CeremonyEvent =
	| {
			readonly kind: "call";
			readonly id: string;
			readonly tool: string;
			readonly capture?: string;
	  }
	| {
			readonly kind: "result";
			readonly id: string;
			readonly tool: string;
			readonly code: string | undefined;
			readonly lines: readonly string[];
			readonly text: string;
	  }
	| {
			readonly kind: "link";
			readonly requestId: string;
			readonly elicitationId: string;
			readonly url: string;
			/** The capture whose call asked for it, if one was in flight. */
			readonly capture: string | undefined;
	  }
	| {
			readonly kind: "form";
			readonly requestId: string;
			readonly capture: string | undefined;
			readonly message: string;
	  }
	| {
			readonly kind: "answer";
			readonly requestId: string;
			readonly action: "accept" | "decline" | "cancel" | "none";
	  }
	| { readonly kind: "completed"; readonly elicitationId: string }
	| { readonly kind: "withdrawn"; readonly requestId: string };

/** A line of the wire: who sent it, and the JSON-RPC message. */
export interface WireMessage {
	readonly to: "host" | "server";
	readonly message: string;
}

const Json = z.record(z.string(), z.json());
const ToolCall = z.object({
	name: z.string(),
	arguments: z.object({ name: z.string().optional() }).passthrough().optional(),
});
const Content = z.object({
	content: z.array(z.object({ text: z.string() })).optional(),
	structuredContent: z.record(z.string(), z.json()).optional(),
	isError: z.boolean().optional(),
});
const Envelope = z.object({
	code: z.string().optional(),
	message: z.string().optional(),
	remediation: z.array(z.string()).optional(),
	/** A capture's refusal: what the agent does next. */
	nextStep: z.string().optional(),
});
const UrlPrompt = z.object({
	mode: z.literal("url"),
	elicitationId: z.string(),
	url: z.string(),
});
const FormPrompt = z.object({ message: z.string() });

/** The events in a recorded host ↔ server exchange. */
export function eventsFromWire(wire: readonly WireMessage[]): CeremonyEvent[] {
	const events: CeremonyEvent[] = [];
	const calls = new Map<
		string,
		{ tool: string; capture: string | undefined }
	>();
	let inFlightCapture: string | undefined;
	for (const line of wire) {
		const parsed = Json.safeParse(JSON.parse(line.message));
		if (!parsed.success) continue;
		const message = parsed.data;
		const id =
			message.id === undefined || message.id === null
				? undefined
				: String(message.id);
		const named = z.string().safeParse(message.method);
		const method = named.success ? named.data : undefined;
		if (line.to === "server") {
			if (method === "tools/call" && id !== undefined) {
				const call = ToolCall.safeParse(message.params);
				if (!call.success) continue;
				const capture =
					call.data.name === "capture_secret"
						? call.data.arguments?.name
						: undefined;
				calls.set(id, { tool: call.data.name, capture });
				if (capture !== undefined) inFlightCapture = capture;
				events.push({
					kind: "call",
					id,
					tool: call.data.name,
					...(capture !== undefined ? { capture } : undefined),
				});
			} else if (method === undefined && id !== undefined) {
				const action = z
					.object({ action: z.enum(["accept", "decline", "cancel"]) })
					.safeParse(message.result);
				events.push({
					kind: "answer",
					requestId: id,
					action: action.success ? action.data.action : "none",
				});
			}
			continue;
		}
		if (method === "elicitation/create" && id !== undefined) {
			const url = UrlPrompt.safeParse(message.params);
			if (url.success)
				events.push({
					kind: "link",
					requestId: id,
					elicitationId: url.data.elicitationId,
					url: url.data.url,
					capture: inFlightCapture,
				});
			else {
				const form = FormPrompt.safeParse(message.params);
				if (form.success)
					events.push({
						kind: "form",
						requestId: id,
						capture: inFlightCapture,
						message: form.data.message,
					});
			}
			continue;
		}
		if (method === "notifications/elicitation/complete") {
			const done = z
				.object({ elicitationId: z.string() })
				.safeParse(message.params);
			if (done.success)
				events.push({
					kind: "completed",
					elicitationId: done.data.elicitationId,
				});
			continue;
		}
		if (method === "notifications/cancelled") {
			const gone = z
				.object({ requestId: z.union([z.string(), z.number()]) })
				.safeParse(message.params);
			if (gone.success)
				events.push({
					kind: "withdrawn",
					requestId: String(gone.data.requestId),
				});
			continue;
		}
		if (method === undefined && id !== undefined && calls.has(id)) {
			const call = calls.get(id);
			calls.delete(id);
			if (call?.capture !== undefined) inFlightCapture = undefined;
			const body = Content.safeParse(message.result ?? message.error);
			const text = body.success
				? (body.data.content ?? []).map((part) => part.text).join("\n")
				: JSON.stringify(message.error ?? message.result ?? null);
			const envelope = (() => {
				try {
					return Envelope.safeParse(JSON.parse(text));
				} catch {
					return Envelope.safeParse(
						body.success ? body.data.structuredContent : {},
					);
				}
			})();
			// A capture's refusal says its code in structuredContent.
			const structured = Envelope.safeParse(
				body.success ? (body.data.structuredContent ?? {}) : {},
			);
			const code =
				(envelope.success ? envelope.data.code : undefined) ??
				(structured.success ? structured.data.code : undefined);
			const said =
				envelope.success && envelope.data.code !== undefined
					? envelope.data
					: structured.success
						? structured.data
						: undefined;
			const lines =
				said === undefined
					? [text]
					: [
							said.code ?? "",
							said.message ?? "",
							...(said.remediation ?? []),
							...(said.nextStep !== undefined ? [said.nextStep] : []),
						];
			events.push({
				kind: "result",
				id,
				tool: call?.tool ?? "",
				code,
				lines,
				text,
			});
		}
	}
	return events;
}

/**
 * The ceremony, declared once. Every property below is derived from it.
 *
 * - `captures`: values a run waits for from the owner, and the link the
 *   owner must have opened first (nothing to paste before it).
 * - `awaiting`: refusals that mean "the owner is acting on a link now", and
 *   the link the host must have shown before them.
 * - `forbidden`: what no host-facing text may ever say.
 * - `frontier`: results after which nothing more is asked of the owner.
 */
export const CEREMONY = {
	captures: {
		INFISICAL_CLI_SESSION: (url: URL) => url.pathname === "/login",
		GITHUB_APP_CODE: (url: URL) => url.href.startsWith(APP_HANDOFF_PAGE),
	},
	awaiting: {
		HOBO_CD_VERCEL_AWAITING_APPROVAL: (url: URL) =>
			/(^|\.)vercel\.com$/u.test(url.hostname),
	},
	forbidden: [
		{ name: "remote-infeasible", pattern: REMOTE_INFEASIBLE },
		{ name: "silent-through-mcp", pattern: /HANDOFF_SILENT|omit --json/iu },
	],
	frontier: (event: CeremonyEvent) =>
		event.kind === "result" &&
		(event.tool === "cd" || event.tool === "ci") &&
		(event.code === undefined ||
			!/^HOBO_C[ID]_|^SECRET_CAPTURE_/u.test(event.code) ||
			/PLAN_REJECTED/u.test(event.code)),
} as const;

/** The URLs a form's message carries, each on its own line. */
function urlsIn(text: string): URL[] {
	return text.split(/\s+/u).flatMap((word) => {
		if (!/^https?:\/\//u.test(word)) return [];
		try {
			return [new URL(word)];
		} catch {
			return [];
		}
	});
}

/** The links the host showed the owner: a link prompt, or a form carrying it. */
function shownLinks(event: CeremonyEvent): URL[] {
	if (event.kind === "form") return urlsIn(event.message);
	if (event.kind !== "link") return [];
	try {
		return [new URL(event.url)];
	} catch {
		return [];
	}
}

const linkOpened =
	(matches: (url: URL) => boolean): Formula<CeremonyEvent> =>
	(trace, at) =>
		once(atom<CeremonyEvent>((event) => shownLinks(event).some(matches)))(
			trace,
			at,
		);

/** The properties every run of the ceremony must satisfy, derived from `CEREMONY`. */
export function ceremonyProperties(
	options: {
		/** Secret values the run handled: none may reach the host. */
		readonly secrets?: readonly string[];
	} = {},
): Property<CeremonyEvent>[] {
	const properties: Property<CeremonyEvent>[] = [];
	// Every capture's form comes after the owner was shown its link.
	for (const [capture, matches] of Object.entries(CEREMONY.captures))
		properties.push({
			name: `link before form: ${capture}`,
			kind: "invariant",
			invariant: implies(
				atom((event) => event.kind === "form" && event.capture === capture),
				linkOpened(matches),
			),
		});
	// A run waiting on the owner at a link showed that link first.
	for (const [code, matches] of Object.entries(CEREMONY.awaiting))
		properties.push({
			name: `link before waiting: ${code}`,
			kind: "invariant",
			invariant: implies(
				atom((event) => event.kind === "result" && event.code === code),
				linkOpened(matches),
			),
		});
	// Nothing the host sees says what a remote owner cannot do.
	for (const rule of CEREMONY.forbidden)
		properties.push({
			name: `never: ${rule.name}`,
			kind: "invariant",
			invariant: not(
				atom(
					(event) =>
						(event.kind === "result" && rule.pattern.test(event.text)) ||
						(event.kind === "form" && rule.pattern.test(event.message)),
				),
			),
		});
	// Every refusal the agent gets leaves the owner something to do.
	properties.push({
		name: "no dead end",
		kind: "invariant",
		invariant: implies(
			atom(
				(event) =>
					event.kind === "result" &&
					event.code !== undefined &&
					!CEREMONY.frontier(event),
			),
			atom(
				(event) =>
					event.kind === "result" &&
					readOwnerTurn(false, event.lines).kind !== "dead-end",
			),
		),
	});
	// Every link a result asks the owner to open was shown to them by the
	// host first (a form or a link prompt), never left for the agent to
	// relay as chat text.
	properties.push({
		name: "owner links reach the owner in the host",
		kind: "invariant",
		invariant: (trace, at) => {
			const event = trace[at];
			if (event?.kind !== "result") return true;
			const asked = event.lines.flatMap((line) =>
				/^HOBO_OWNER_(SIGN_IN|DEVICE)\b/u.test(line)
					? urlsIn(line.replace(/^\S+ (url=)?/u, ""))
					: [],
			);
			return asked.every((url) =>
				once(
					atom<CeremonyEvent>((prior) =>
						shownLinks(prior).some((shown) => shown.href === url.href),
					),
				)(trace, at),
			);
		},
	});
	// A completion names a link the host was shown.
	properties.push({
		name: "completion follows its link",
		kind: "invariant",
		invariant: (trace, at) => {
			const event = trace[at];
			if (event?.kind !== "completed") return true;
			return once(
				atom<CeremonyEvent>(
					(prior) =>
						prior.kind === "link" &&
						prior.elicitationId === event.elicitationId,
				),
			)(trace, at);
		},
	});
	// No secret the run handled ever reaches the host.
	const secrets = options.secrets ?? [];
	if (secrets.length > 0)
		properties.push({
			name: "no secret to the host",
			kind: "invariant",
			invariant: not(
				atom(
					(event) =>
						(event.kind === "result" &&
							secrets.some((secret) => event.text.includes(secret))) ||
						(event.kind === "form" &&
							secrets.some((secret) => event.message.includes(secret))) ||
						(event.kind === "link" &&
							secrets.some((secret) => event.url.includes(secret))),
				),
			),
		});
	return properties;
}

/** Liveness, for a run whose owner acts on everything: it reaches the frontier. */
export const REACHES_FRONTIER: Property<CeremonyEvent> = {
	name: "eventually: nothing more asked of the owner",
	kind: "trace",
	formula: eventually(atom((event) => CEREMONY.frontier(event))),
};

/** Re-exported for spec authors. */
export { always, and };
