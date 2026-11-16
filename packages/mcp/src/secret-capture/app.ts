/**
 * The secret-capture MCP App (MCP Apps extension `io.modelcontextprotocol/ui`,
 * specification 2026-01-26; reference SDK `@modelcontextprotocol/ext-apps`
 * 2.0.4, read 2026-11-12). When a HoBo deployment needs a secret the store
 * does not hold yet, the agent calls `capture_secret`; the owner types the
 * value into a form; the value is sealed in that form, opened in this
 * process, written to the secret store through the injected connector, and
 * dropped. The agent gets a ticket, then a name, `stored: true` and a store
 * reference. Nothing the agent can read ever holds the value.
 *
 * Channels, chosen from what the host negotiated at `initialize`:
 * 1. `mcp-app`: the host supports MCP Apps (`capabilities.extensions
 *    ["io.modelcontextprotocol/ui"].mimeTypes` has `text/html;profile=mcp-app`).
 *    `capture_secret` carries `_meta.ui.resourceUri`; the host renders
 *    `ui://hobo/secret-capture`; the form calls `submit_secret_value`, whose
 *    `_meta.ui.visibility` is `["app"]`, so the host keeps it out of the
 *    model's tool list (spec: "Host MUST NOT include tools in the agent's tool
 *    list when their visibility does not include \"model\""). A host without
 *    MCP Apps is never offered that tool at all.
 * 2. `url-elicitation`: no MCP Apps, but the client declared
 *    `capabilities.elicitation.url` (MCP 2025-11-25). `capture_secret`
 *    answers with `URLElicitationRequiredError` (-32042) naming the loopback
 *    page; the client shows the address and opens it once the owner consents;
 *    `notifications/elicitation/complete` follows the write. Form-mode
 *    elicitation is never used: the spec forbids it for secrets.
 * 3. `loopback-page`: neither. The result names the loopback page and tells
 *    the agent to ask the owner to open it in their own browser. Never a
 *    request to paste the value into the chat.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import {
	type SecretCaptureCode,
	SecretCaptureError,
	SecretStoreConnectorError,
} from "./errors.js";
import {
	renderSecretCaptureHtml,
	type SecretCapturePageTicket,
} from "./html.js";
import {
	type LoopbackAnswer,
	type LoopbackCapturePage,
	startLoopbackCapturePage,
} from "./loopback.js";
import {
	type CaptureKeyPair,
	type CapturePublicKey,
	createCaptureKeyPair,
	parseSealedSecret,
} from "./seal.js";
import {
	isSecretCaptureName,
	type ParsedSecretCaptureSpec,
	type SecretCaptureTarget,
} from "./spec.js";
import { CapturedSecret } from "./value.js";

// public-contract: the MCP Apps extension id this server negotiates.
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
// public-contract: the MIME type of an MCP App HTML resource.
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
// public-contract: the MCP Apps spec revision the form speaks.
export const MCP_APPS_SPEC_VERSION = "2026-01-26";
// public-contract: the capture form's resource.
export const SECRET_CAPTURE_RESOURCE_URI = "ui://hobo/secret-capture";
// public-contract: the model-visible tool that opens a capture.
export const CAPTURE_SECRET_TOOL = "capture_secret";
// public-contract: the app-only tool the form submits through.
export const SUBMIT_SECRET_VALUE_TOOL = "submit_secret_value";
// public-contract: the model-visible tool that reads a capture's state.
export const SECRET_CAPTURE_STATUS_TOOL = "secret_capture_status";
// public-contract: the model-visible tool that ends captures and the writer session.
export const END_SECRET_CAPTURE_TOOL = "end_secret_capture";
// public-contract: the JSON-RPC error code of URLElicitationRequiredError (MCP 2025-11-25).
export const URL_ELICITATION_REQUIRED = -32042;
// public-contract: the schema version of secret-capture events.
export const SECRET_CAPTURE_EVENTS_SCHEMA_VERSION = "hobo.secret-capture/v1";

export const SECRET_CAPTURE_TOOL_NAMES: readonly string[] = Object.freeze([
	CAPTURE_SECRET_TOOL,
	SUBMIT_SECRET_VALUE_TOOL,
	SECRET_CAPTURE_STATUS_TOOL,
	END_SECRET_CAPTURE_TOOL,
]);

export type SecretCaptureChannel =
	| "mcp-app"
	| "url-elicitation"
	| "loopback-page"
	/** The host's own elicitation form (a remote box whose host has no MCP Apps). */
	| "form-elicitation";
type TicketState =
	| "awaiting-owner"
	| "stored"
	| "authorized"
	| "expired"
	| "closed";

/** What the host can do, read from its `initialize` capabilities. */
export type SecretCaptureHostSupport = Readonly<{
	apps: boolean;
	/** The host renders `elicitation/create` forms (MCP 2025-06-18 `{}`, or `{ form }`). */
	formElicitation: boolean;
	urlElicitation: boolean;
}>;

export const NO_HOST_SUPPORT: SecretCaptureHostSupport = Object.freeze({
	apps: false,
	formElicitation: false,
	urlElicitation: false,
});

function objectAt(
	value: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	return isJsonObject(value) ? value[key] : undefined;
}

/** Read the client's `initialize` capabilities. Anything malformed means "no". */
export function negotiateSecretCaptureSupport(
	capabilities: JsonValue | undefined,
): SecretCaptureHostSupport {
	const ui = objectAt(
		objectAt(capabilities, "extensions"),
		MCP_APPS_EXTENSION_ID,
	);
	const mimeTypes = objectAt(ui, "mimeTypes");
	const apps =
		Array.isArray(mimeTypes) && mimeTypes.some((m) => m === MCP_APP_MIME_TYPE);
	const elicitation = objectAt(capabilities, "elicitation");
	const urlElicitation = isJsonObject(objectAt(elicitation, "url"));
	// `{}` (2025-06-18) or `{ form: {} }` (2025-11-25) both mean form mode.
	const formElicitation =
		isJsonObject(elicitation) &&
		(Object.keys(elicitation).length === 0 ||
			isJsonObject(objectAt(elicitation, "form")));
	return Object.freeze({ apps, formElicitation, urlElicitation });
}

/** Whether a store is bound and whether this process may write to it now. */
export type SecretStoreStatus =
	| Readonly<{ connected: false; reason: string; nextStep: string }>
	| Readonly<{
			connected: true;
			/** e.g. `infisical://proj/prod/hobo-ci-relay` */
			storeRef: string;
			writable: boolean;
			/** The spec that authorizes writes, when they are not authorized yet. */
			writerSpec: string;
	  }>;

/**
 * Where captured values go. The composition supplies it (`@hobo/hobo` binds
 * the committed secret-store binding and Infisical); tests use a memory store.
 * Implementations throw `SecretStoreConnectorError` with a short code; any
 * other error is reported as `unavailable`, and its message is never read.
 */
export interface SecretStoreConnector {
	status(): Promise<SecretStoreStatus>;
	/**
	 * Use a writer credential once to authorize writes for this session (for
	 * Infisical: a Universal Auth login with a one-use client secret). The
	 * credential is not stored.
	 */
	authorizeWriter(input: {
		readonly clientId: string;
		readonly secret: CapturedSecret;
	}): Promise<Readonly<{ ref: string; expiresAt: string }>>;
	/** Write one value; resolve to the entry's reference. */
	store(
		target: Exclude<SecretCaptureTarget, "writer">,
		secret: CapturedSecret,
	): Promise<Readonly<{ ref: string }>>;
	/** End the writer session (revoke what it obtained). Idempotent. */
	endWriterSession(): Promise<"ended" | "none">;
}

export type SecretCaptureEventType =
	| "secret.CaptureOpened"
	| "secret.CaptureStored"
	| "secret.CaptureAuthorized"
	| "secret.CaptureRejected"
	| "secret.CaptureRefused"
	| "secret.CaptureExpired"
	| "secret.CaptureClosed";

/** The audited fact of one step (`#SecretCaptureEvent`): references only. */
export type SecretCaptureEvent = Readonly<{
	schemaVersion: typeof SECRET_CAPTURE_EVENTS_SCHEMA_VERSION;
	type: SecretCaptureEventType;
	seq: number;
	time: string;
	ticketId?: string;
	name?: string;
	target?: SecretCaptureTarget;
	channel?: SecretCaptureChannel;
	ref?: string;
	code?: string;
}>;

/** An MCP tool as `tools/list` lists it. */
export type SecretCaptureToolDefinition = Readonly<{
	name: string;
	title: string;
	description: string;
	inputSchema: JsonValue;
	_meta?: JsonValue;
}>;

/** An MCP `CallToolResult`. */
export type SecretCaptureToolResult = Readonly<{
	content: readonly Readonly<{ type: "text"; text: string }>[];
	structuredContent: JsonValue;
	isError: boolean;
}>;

/** A tool call either answers, or is a JSON-RPC error (URL elicitation). */
export type SecretCaptureOutcome =
	| Readonly<{ kind: "result"; result: SecretCaptureToolResult }>
	| Readonly<{
			kind: "error";
			error: Readonly<{ code: number; message: string; data: JsonValue }>;
	  }>;

export interface SecretCaptureApp {
	/** The tools for this host: the app-only submit tool only when it negotiated MCP Apps. */
	tools(
		support: SecretCaptureHostSupport,
	): readonly SecretCaptureToolDefinition[];
	/** The UI resource, listed only for an MCP Apps host. */
	resources(support: SecretCaptureHostSupport): readonly JsonValue[];
	readResource(uri: string): JsonValue | undefined;
	handles(tool: string): boolean;
	callTool(
		tool: string,
		args: JsonValue | undefined,
		support: SecretCaptureHostSupport,
	): Promise<SecretCaptureOutcome>;
	/** The facts so far (bounded), for audit and tests. */
	events(): readonly SecretCaptureEvent[];
	/** Close every open capture, end the writer session, stop the page. */
	close(): Promise<void>;
}

export type CreateSecretCaptureAppOptions = Readonly<{
	specs: readonly ParsedSecretCaptureSpec[];
	connector: SecretStoreConnector;
	now?: () => number;
	/** How long a capture stays open. Default 10 minutes. */
	ttlMs?: number;
	/** Open captures at once. Default 8. */
	maxOpen?: number;
	/** Failed submissions before a capture closes. Default 5. */
	maxAttempts?: number;
	onEvent?: (event: SecretCaptureEvent) => void;
	/** Server-to-client notifications (`notifications/elicitation/complete`). */
	notify?: (method: string, params: JsonValue) => void;
	/**
	 * Receives a `handoff` capture: the value goes to the ceremony running in
	 * this process, in memory, and to no store. Without it, a handoff spec is
	 * refused.
	 */
	handoff?: (secret: CapturedSecret) => Promise<void>;
	/**
	 * The owner is not at this machine (a remote dev box): a page on its
	 * 127.0.0.1 can never reach them. Without MCP Apps the host's own
	 * elicitation form asks instead; a host with neither is refused, never
	 * sent to a page the owner cannot see.
	 */
	remote?: boolean;
	/**
	 * What the waiting run asked the owner to do for a value (a link and its
	 * steps). Shown in the form itself: while a host's form is open, the
	 * owner sees only the form.
	 */
	guidanceFor?: (name: string) => string | undefined;
	/** Ask the host for a form (`elicitation/create`), answered by the owner. */
	elicit?: (params: JsonObject) => Promise<JsonValue | undefined>;
}>;

type Ticket = {
	readonly id: string;
	readonly spec: ParsedSecretCaptureSpec;
	readonly channel: SecretCaptureChannel;
	readonly openedAtMs: number;
	readonly expiresAtMs: number;
	readonly writerClientId: string | undefined;
	state: TicketState;
	keys: CaptureKeyPair | undefined;
	readonly publicKey: CapturePublicKey;
	tokenDigest: Buffer | undefined;
	url: string | undefined;
	ref: string | undefined;
	attempts: number;
};

const TICKET_ID = /^cap_[A-Za-z0-9_-]{22}$/u;

type FormAnswer =
	| Readonly<{ action: "accept"; value: string }>
	| Readonly<{ action: "decline" | "cancel" | "unanswered" }>;

/** The host's answer to `elicitation/create`, parsed where it enters. */
function parseFormAnswer(answer: JsonValue | undefined): FormAnswer {
	const action = objectAt(answer, "action");
	const value = objectAt(objectAt(answer, "content"), "value");
	if (action === "accept" && isJsonString(value))
		return { action: "accept", value };
	return action === "decline" || action === "cancel"
		? { action }
		: { action: "unanswered" };
}

const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_EVENTS = 1000;

function digest(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

/** A refusal as the agent sees it (`#SecretCaptureRefusal`). */
type RefusalView = {
	code: string;
	message: string;
	nextStep?: string;
	name?: string;
	hostSupport?: SecretCaptureHostSupport;
};

/** A ticket as the agent sees it (`#SecretCaptureTicket`). */
type TicketView = {
	ticketId: string;
	name: string;
	target: SecretCaptureTarget;
	channel: SecretCaptureChannel;
	state: TicketState;
	openedAt: string;
	expiresAt: string;
	label: string;
	purpose: string;
	charset: string;
	maxBytes: number;
	ref?: string;
	key?: CapturePublicKey;
	url?: string;
	/** What this host can show the owner, so the agent never guesses. */
	hostSupport?: SecretCaptureHostSupport;
};

function refusalResult(
	error: SecretCaptureError,
	name?: string,
): SecretCaptureToolResult {
	const refusal: RefusalView = { code: error.code, message: error.message };
	if (error.nextStep !== undefined) refusal.nextStep = error.nextStep;
	if (name !== undefined) refusal.name = name;
	return {
		content: [
			{
				type: "text",
				text: `${error.code}: ${error.message}${
					error.nextStep === undefined ? "" : ` Next: ${error.nextStep}`
				}`,
			},
		],
		structuredContent: refusal,
		isError: true,
	};
}

/** A capture's result says what the host can show the owner, so the agent never guesses. */
function withHostSupport(
	tool: string,
	outcome: SecretCaptureOutcome,
	support: SecretCaptureHostSupport,
): SecretCaptureOutcome {
	if (tool !== CAPTURE_SECRET_TOOL || outcome.kind !== "result") return outcome;
	const structured = outcome.result.structuredContent;
	return {
		kind: "result",
		result: {
			...outcome.result,
			structuredContent: isJsonObject(structured)
				? { ...structured, hostSupport: { ...support } }
				: structured,
		},
	};
}

function stringArg(
	args: JsonValue | undefined,
	key: string,
): string | undefined {
	const value = objectAt(args, key);
	return isJsonString(value) ? value : undefined;
}

export function createSecretCaptureApp(
	options: CreateSecretCaptureAppOptions,
): SecretCaptureApp {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 10 * 60_000;
	const maxOpen = options.maxOpen ?? 8;
	const maxAttempts = options.maxAttempts ?? 5;
	const specs = new Map(options.specs.map((spec) => [spec.name, spec]));
	const writerSpecs = options.specs.filter((spec) => spec.target === "writer");
	const tickets = new Map<string, Ticket>();
	const log: SecretCaptureEvent[] = [];
	let seq = 0;
	let page: Promise<LoopbackCapturePage> | undefined;

	function emit(
		type: SecretCaptureEventType,
		fields: Omit<SecretCaptureEvent, "schemaVersion" | "type" | "seq" | "time">,
	): void {
		seq += 1;
		const event: SecretCaptureEvent = Object.freeze({
			schemaVersion: SECRET_CAPTURE_EVENTS_SCHEMA_VERSION,
			type,
			seq,
			time: new Date(now()).toISOString(),
			...fields,
		});
		log.push(event);
		if (log.length > MAX_EVENTS) log.shift();
		try {
			options.onEvent?.(event);
		} catch {
			// An audit sink's failure does not change the capture.
		}
	}

	function ticketFields(ticket: Ticket) {
		return {
			ticketId: ticket.id,
			name: ticket.spec.name,
			target: ticket.spec.target,
			channel: ticket.channel,
		};
	}

	function shut(ticket: Ticket, state: TicketState): void {
		ticket.state = state;
		ticket.keys?.destroy();
		ticket.keys = undefined;
		ticket.tokenDigest = undefined;
	}

	function sweep(): void {
		const at = now();
		for (const ticket of tickets.values())
			if (ticket.state === "awaiting-owner" && at >= ticket.expiresAtMs) {
				shut(ticket, "expired");
				emit("secret.CaptureExpired", ticketFields(ticket));
			}
	}

	/**
	 * The ticket as the agent sees it (`#SecretCaptureTicket`). `offer` adds
	 * the sealing key and the page while the capture is open; the status tool
	 * never re-offers them.
	 */
	function view(ticket: Ticket, offer = true): TicketView {
		const open = offer && ticket.state === "awaiting-owner";
		const shown: TicketView = {
			ticketId: ticket.id,
			name: ticket.spec.name,
			target: ticket.spec.target,
			channel: ticket.channel,
			state: ticket.state,
			openedAt: new Date(ticket.openedAtMs).toISOString(),
			expiresAt: new Date(ticket.expiresAtMs).toISOString(),
			label: ticket.spec.label,
			purpose: ticket.spec.purpose,
			charset: ticket.spec.charset,
			maxBytes: ticket.spec.maxBytes,
		};
		if (ticket.ref !== undefined) shown.ref = ticket.ref;
		if (open) shown.key = { ...ticket.publicKey };
		if (open && ticket.url !== undefined) shown.url = ticket.url;
		return shown;
	}

	function pageTicket(ticket: Ticket): SecretCapturePageTicket {
		return {
			ticketId: ticket.id,
			name: ticket.spec.name,
			label: ticket.spec.label,
			purpose: ticket.spec.purpose,
			charset: ticket.spec.charset,
			maxBytes: ticket.spec.maxBytes,
			expiresAt: new Date(ticket.expiresAtMs).toISOString(),
			key: { ...ticket.publicKey },
		};
	}

	function openTicket(id: string): Ticket | undefined {
		sweep();
		const ticket = tickets.get(id);
		return ticket?.state === "awaiting-owner" ? ticket : undefined;
	}

	function loopback(): Promise<LoopbackCapturePage> {
		page ??= startLoopbackCapturePage({
			page(id, nonce) {
				const ticket = openTicket(id);
				if (ticket === undefined || ticket.channel === "mcp-app")
					return undefined;
				return renderSecretCaptureHtml({
					mode: "loopback",
					nonce,
					ticket: pageTicket(ticket),
				});
			},
			async submit(id, token, sealed): Promise<LoopbackAnswer> {
				const ticket = openTicket(id);
				const presented = digest(token);
				if (
					ticket === undefined ||
					ticket.channel === "mcp-app" ||
					ticket.tokenDigest === undefined ||
					!timingSafeEqual(presented, ticket.tokenDigest)
				)
					return {
						status: 404,
						body: {
							code: "SECRET_CAPTURE_UNKNOWN_TICKET",
							message:
								"This capture is closed or this page is not the one it opened.",
						},
					};
				const outcome = await submit(ticket, sealed);
				return {
					status: outcome.isError ? 422 : 200,
					body: outcome.structuredContent,
				};
			},
		});
		return page;
	}

	function refuseNoForm(spec: ParsedSecretCaptureSpec): never {
		throw new SecretCaptureError(
			"SECRET_CAPTURE_NO_OWNER_FORM",
			`The owner is not at this machine, and this host shows neither HoBo's form (MCP Apps) nor its own elicitation form, so nothing can take ${spec.name} from them safely.`,
			"Do not send the owner to a page, a preview or the chat for it. Tell them this host cannot collect it, and run the ceremony from a host that shows MCP Apps or elicitation forms (Claude Code, Claude Desktop, VS Code).",
		);
	}

	/**
	 * The host's own form: one field, for this value only. What the owner
	 * types goes from the host to this process in the elicitation answer,
	 * never through a tool result, the chat or the model. A value of the
	 * wrong shape is asked again with the reason (never the value).
	 */
	async function askInForm(ticket: Ticket): Promise<SecretCaptureToolResult> {
		const elicit = options.elicit;
		let problem: string | undefined;
		while (ticket.state === "awaiting-owner") {
			const answer = parseFormAnswer(
				await elicit?.({
					message: [
						`HoBo: ${ticket.spec.label}.`,
						options.guidanceFor?.(ticket.spec.name) ?? ticket.spec.purpose,
						problem === undefined
							? ""
							: `That was not accepted: ${problem} Enter it again.`,
						"It goes only to HoBo's waiting run, never to the agent or the chat.",
					]
						.filter((part) => part !== "")
						.join(" "),
					requestedSchema: {
						type: "object",
						properties: {
							value: {
								type: "string",
								title: ticket.spec.label,
								description: ticket.spec.purpose,
								minLength: ticket.spec.minBytes,
								maxLength: ticket.spec.maxBytes,
							},
						},
						required: ["value"],
					},
				}).catch(() => undefined),
			);
			if (answer.action !== "accept") {
				shut(ticket, "closed");
				emit("secret.CaptureClosed", ticketFields(ticket));
				throw new SecretCaptureError(
					"SECRET_CAPTURE_DECLINED",
					`The owner ${answer.action === "decline" ? "declined" : "closed"} the form; ${ticket.spec.name} was not captured.`,
					`Ask again with ${CAPTURE_SECRET_TOOL} when they are ready.`,
				);
			}
			let secret: CapturedSecret;
			try {
				secret = CapturedSecret.parse(ticket.spec, answer.value);
			} catch (error) {
				if (!(error instanceof SecretCaptureError)) throw error;
				const refused = failed(
					ticket,
					error,
					"secret.CaptureRejected",
					error.code,
				);
				if (ticket.state !== "awaiting-owner") return refused;
				problem = error.message;
				continue;
			}
			return deliver(ticket, secret);
		}
		throw new SecretCaptureError(
			"SECRET_CAPTURE_CLOSED",
			`${ticket.spec.name}'s capture is closed.`,
		);
	}

	async function refuseIfNotWritable(
		spec: ParsedSecretCaptureSpec,
	): Promise<SecretCaptureError | undefined> {
		if (spec.target === "handoff")
			return options.handoff === undefined
				? new SecretCaptureError(
						"SECRET_STORE_NOT_CONNECTED",
						`Nothing in this process is waiting for ${spec.name}.`,
						"Run the ceremony that asks for it through this MCP server first.",
					)
				: undefined;
		const status = await options.connector.status();
		if (status.connected === false)
			return new SecretCaptureError(
				"SECRET_STORE_NOT_CONNECTED",
				`No secret store is connected (${status.reason}), so ${spec.name} has nowhere to go.`,
				status.nextStep,
			);
		if (spec.target !== "writer" && !status.writable)
			return new SecretCaptureError(
				"SECRET_STORE_WRITER_REQUIRED",
				`The secret store ${status.storeRef} is connected, but this session may not write to it yet.`,
				`Call ${CAPTURE_SECRET_TOOL} with name ${status.writerSpec} and writerClientId (the writer identity's Client ID) first; the owner enters its one-use client secret in the same kind of form.`,
			);
		return undefined;
	}

	async function capture(
		args: JsonValue | undefined,
		support: SecretCaptureHostSupport,
	): Promise<SecretCaptureOutcome> {
		sweep();
		const name = stringArg(args, "name") ?? "";
		const spec = specs.get(name);
		if (spec === undefined)
			throw new SecretCaptureError(
				"SECRET_CAPTURE_UNKNOWN_NAME",
				"That is not a secret this deployment captures.",
				`Use one of: ${[...specs.keys()].join(", ")}.`,
			);
		const requested = stringArg(args, "channel") ?? "auto";
		if (requested !== "auto" && requested !== "loopback-page")
			throw new SecretCaptureError(
				"SECRET_CAPTURE_INVALID_INPUT",
				"channel is auto or loopback-page.",
			);
		const writerClientId = stringArg(args, "writerClientId");
		if (spec.target === "writer" && !CLIENT_ID.test(writerClientId ?? ""))
			throw new SecretCaptureError(
				"SECRET_CAPTURE_WRITER_CLIENT_ID_REQUIRED",
				`${spec.name} needs writerClientId: the Client ID of the writer identity's Universal Auth (an identifier, not a secret).`,
			);
		const refusal = await refuseIfNotWritable(spec);
		if (refusal !== undefined) {
			emit("secret.CaptureRefused", { name: spec.name, code: refusal.code });
			throw refusal;
		}
		const replace = objectAt(args, "replace") === true;
		const previous = [...tickets.values()]
			.filter((ticket) => ticket.spec.name === spec.name)
			.at(-1);
		// A retry after URL elicitation, or a repeated call while the owner is
		// still typing, gets the same capture back.
		if (
			previous !== undefined &&
			!replace &&
			(previous.state === "awaiting-owner" ||
				((previous.state === "stored" || previous.state === "authorized") &&
					now() < previous.expiresAtMs))
		)
			return answerFor(previous, support);
		if (previous?.state === "awaiting-owner") {
			shut(previous, "closed");
			emit("secret.CaptureClosed", ticketFields(previous));
		}
		const open = [...tickets.values()].filter(
			(ticket) => ticket.state === "awaiting-owner",
		).length;
		if (open >= maxOpen)
			throw new SecretCaptureError(
				"SECRET_CAPTURE_TOO_MANY_PENDING",
				`${open} captures are already open.`,
				`Finish them, or call ${END_SECRET_CAPTURE_TOOL}.`,
			);
		const channel: SecretCaptureChannel =
			support.apps && requested === "auto"
				? "mcp-app"
				: options.remote === true
					? // A page on this box's 127.0.0.1 never reaches a remote owner.
						support.formElicitation && options.elicit !== undefined
						? "form-elicitation"
						: refuseNoForm(spec)
					: requested === "loopback-page"
						? "loopback-page"
						: support.urlElicitation
							? "url-elicitation"
							: "loopback-page";
		const keys = createCaptureKeyPair();
		const opened = now();
		const ticket: Ticket = {
			id: `cap_${randomBytes(16).toString("base64url")}`,
			spec,
			channel,
			openedAtMs: opened,
			expiresAtMs: opened + ttlMs,
			writerClientId: spec.target === "writer" ? writerClientId : undefined,
			state: "awaiting-owner",
			keys,
			publicKey: keys.publicKey,
			tokenDigest: undefined,
			url: undefined,
			ref: undefined,
			attempts: 0,
		};
		if (channel === "form-elicitation") {
			tickets.set(ticket.id, ticket);
			emit("secret.CaptureOpened", ticketFields(ticket));
			return { kind: "result", result: await askInForm(ticket) };
		}
		if (channel !== "mcp-app") {
			const token = randomBytes(32).toString("base64url");
			ticket.tokenDigest = digest(token);
			ticket.url = `${(await loopback()).origin}/capture/${ticket.id}#${token}`;
		}
		tickets.set(ticket.id, ticket);
		emit("secret.CaptureOpened", ticketFields(ticket));
		return answerFor(ticket, support);
	}

	function answerFor(
		ticket: Ticket,
		support: SecretCaptureHostSupport,
	): SecretCaptureOutcome {
		const shown = view(ticket);
		if (ticket.state !== "awaiting-owner")
			return {
				kind: "result",
				result: {
					content: [
						{
							type: "text",
							text: `${ticket.spec.name} is ${ticket.state} (${ticket.ref ?? "no reference"}). The value was never shown to you.`,
						},
					],
					structuredContent: shown,
					isError: false,
				},
			};
		if (ticket.channel === "url-elicitation" && support.urlElicitation)
			return {
				kind: "error",
				error: {
					code: URL_ELICITATION_REQUIRED,
					message: `The owner enters ${ticket.spec.name} in a page this HoBo MCP server serves on this machine.`,
					data: {
						elicitations: [
							{
								mode: "url",
								elicitationId: ticket.id,
								url: ticket.url ?? "",
								message: `HoBo needs ${ticket.spec.label} (${ticket.spec.name}) for the secret store. Open this page on this machine and enter it there; it is encrypted in the page and the agent never sees it.`,
							},
						],
					},
				},
			};
		const text =
			ticket.channel === "mcp-app"
				? `The owner is entering ${ticket.spec.name} in the HoBo form shown with this result. It goes straight to ${ticket.spec.target === "handoff" ? "the run waiting for it, in memory" : "the secret store"}; you will not see it and must not ask for it. When the owner says it is done, call ${SECRET_CAPTURE_STATUS_TOOL} with ticketId ${ticket.id}.`
				: `Ask the owner to open ${ticket.url ?? ""} in their own browser on this machine and enter ${ticket.spec.name} there. Do not open, fetch or submit that page yourself, and never ask for the value in the chat. When the owner says it is done, call ${SECRET_CAPTURE_STATUS_TOOL} with ticketId ${ticket.id}.`;
		return {
			kind: "result",
			result: {
				content: [{ type: "text", text }],
				structuredContent: shown,
				isError: false,
			},
		};
	}

	function failed(
		ticket: Ticket,
		error: SecretCaptureError,
		event: SecretCaptureEventType,
		code: string,
	): SecretCaptureToolResult {
		ticket.attempts += 1;
		emit(event, { ...ticketFields(ticket), code });
		if (ticket.attempts >= maxAttempts) {
			shut(ticket, "closed");
			emit("secret.CaptureClosed", ticketFields(ticket));
			return refusalResult(
				new SecretCaptureError(
					"SECRET_CAPTURE_ATTEMPTS_EXHAUSTED",
					`${ticket.spec.name} was refused ${ticket.attempts} times; this capture is closed.`,
					`Open a new one with ${CAPTURE_SECRET_TOOL}.`,
				),
				ticket.spec.name,
			);
		}
		return refusalResult(error, ticket.spec.name);
	}

	async function submit(
		ticket: Ticket,
		sealedJson: JsonValue,
	): Promise<SecretCaptureToolResult> {
		let secret: CapturedSecret;
		try {
			const sealed = parseSealedSecret(sealedJson);
			if (sealed.ticketId !== ticket.id || ticket.keys === undefined)
				throw new SecretCaptureError(
					"SECRET_CAPTURE_SEAL_INVALID",
					"The form's sealed value belongs to another capture.",
				);
			const plain = ticket.keys.open(
				sealed,
				`${ticket.id}:${ticket.spec.name}`,
			);
			secret = CapturedSecret.parse(ticket.spec, plain);
		} catch (error) {
			const refusal =
				error instanceof SecretCaptureError
					? error
					: new SecretCaptureError(
							"SECRET_CAPTURE_SEAL_INVALID",
							"The form's sealed value could not be read.",
						);
			return failed(ticket, refusal, "secret.CaptureRejected", refusal.code);
		}
		return deliver(ticket, secret);
	}

	/** A captured value to where its spec sends it: the run, the store, or the writer session. */
	async function deliver(
		ticket: Ticket,
		secret: CapturedSecret,
	): Promise<SecretCaptureToolResult> {
		let ref: string;
		let state: "stored" | "authorized";
		try {
			if (ticket.spec.target === "writer") {
				({ ref } = await options.connector.authorizeWriter({
					clientId: ticket.writerClientId ?? "",
					secret,
				}));
				state = "authorized";
			} else {
				const refusal = await refuseIfNotWritable(ticket.spec);
				if (refusal !== undefined)
					return failed(ticket, refusal, "secret.CaptureRefused", refusal.code);
				if (ticket.spec.target === "handoff") {
					// To the waiting ceremony, in memory; no store, no file.
					await options.handoff?.(secret);
					ref = `handoff://${ticket.spec.name}`;
				} else
					({ ref } = await options.connector.store(ticket.spec.target, secret));
				state = "stored";
			}
		} catch (error) {
			const code =
				error instanceof SecretStoreConnectorError ? error.code : "unavailable";
			const refusal =
				ticket.spec.target === "writer"
					? new SecretCaptureError(
							"SECRET_STORE_WRITER_DENIED",
							`The secret store did not accept the writer credential (${code}).`,
							"Check the Client ID and create a new one-use client secret, then submit again.",
						)
					: new SecretCaptureError(
							"SECRET_STORE_WRITE_FAILED",
							`The secret store did not store ${ticket.spec.name} (${code}).`,
							"Check the writer identity's role on this folder, then submit again.",
						);
			return failed(ticket, refusal, "secret.CaptureRefused", code);
		}
		ticket.ref = ref;
		shut(ticket, state);
		emit(
			state === "stored" ? "secret.CaptureStored" : "secret.CaptureAuthorized",
			{
				...ticketFields(ticket),
				ref,
			},
		);
		if (ticket.channel === "url-elicitation")
			try {
				options.notify?.("notifications/elicitation/complete", {
					elicitationId: ticket.id,
				});
			} catch {
				// The notification is a courtesy; the status tool still answers.
			}
		const receipt = {
			ticketId: ticket.id,
			name: ticket.spec.name,
			stored: state === "stored",
			ref,
			status: state,
		};
		return {
			content: [
				{
					type: "text",
					text: `${ticket.spec.name} ${state === "stored" ? "stored" : "authorized writes"}: ${ref}.`,
				},
			],
			structuredContent: receipt,
			isError: false,
		};
	}

	async function call(
		tool: string,
		args: JsonValue | undefined,
		support: SecretCaptureHostSupport,
	): Promise<SecretCaptureOutcome> {
		if (tool === CAPTURE_SECRET_TOOL) return capture(args, support);
		if (tool === SUBMIT_SECRET_VALUE_TOOL) {
			if (!support.apps)
				throw new SecretCaptureError(
					"MCP_APPS_NOT_NEGOTIATED",
					`${SUBMIT_SECRET_VALUE_TOOL} is the capture form's own tool and this host did not negotiate MCP Apps.`,
					`Use ${CAPTURE_SECRET_TOOL}; it opens the local page instead.`,
				);
			const id = stringArg(args, "ticketId") ?? "";
			const ticket = TICKET_ID.test(id) ? openTicket(id) : undefined;
			if (ticket === undefined || ticket.channel !== "mcp-app")
				throw new SecretCaptureError(
					"SECRET_CAPTURE_UNKNOWN_TICKET",
					"This capture is closed, expired or was not opened in a form.",
					`Open a new one with ${CAPTURE_SECRET_TOOL}.`,
				);
			const sealed = objectAt(args, "sealed");
			return {
				kind: "result",
				result: await submit(ticket, sealed ?? null),
			};
		}
		if (tool === SECRET_CAPTURE_STATUS_TOOL) {
			sweep();
			const id = stringArg(args, "ticketId") ?? "";
			const ticket = TICKET_ID.test(id) ? tickets.get(id) : undefined;
			if (ticket === undefined)
				throw new SecretCaptureError(
					"SECRET_CAPTURE_UNKNOWN_TICKET",
					"No capture has that ticket id.",
				);
			// The status answer never re-offers the page or the key.
			const shown = view(ticket, false);
			return {
				kind: "result",
				result: {
					content: [
						{
							type: "text",
							text: `${ticket.spec.name}: ${ticket.state}${
								ticket.ref === undefined ? "" : ` (${ticket.ref})`
							}.`,
						},
					],
					structuredContent: shown,
					isError: false,
				},
			};
		}
		if (tool === END_SECRET_CAPTURE_TOOL) {
			const closed = await closeAll();
			return {
				kind: "result",
				result: {
					content: [
						{
							type: "text",
							text: `Closed ${closed.captures} open capture(s); writer session ${closed.writerSession}.`,
						},
					],
					structuredContent: {
						closedCaptures: closed.captures,
						writerSession: closed.writerSession,
					},
					isError: false,
				},
			};
		}
		throw new SecretCaptureError(
			"SECRET_CAPTURE_INVALID_INPUT",
			"Not a secret-capture tool.",
		);
	}

	async function closeAll(): Promise<{
		captures: number;
		writerSession: "ended" | "none" | "unavailable";
	}> {
		let captures = 0;
		for (const ticket of tickets.values())
			if (ticket.state === "awaiting-owner") {
				shut(ticket, "closed");
				emit("secret.CaptureClosed", ticketFields(ticket));
				captures += 1;
			}
		let writerSession: "ended" | "none" | "unavailable";
		try {
			writerSession = await options.connector.endWriterSession();
		} catch {
			writerSession = "unavailable";
		}
		const running = page;
		page = undefined;
		if (running !== undefined) await (await running).close();
		return { captures, writerSession };
	}

	const nameEnum: JsonValue = [...specs.keys()];
	const writerNames = writerSpecs.map((spec) => spec.name).join(", ");

	return {
		tools(support) {
			const capture: SecretCaptureToolDefinition = {
				name: CAPTURE_SECRET_TOOL,
				title: "Capture a deployment secret",
				description: `Ask the owner for a secret this HoBo deployment needs. The owner types it into a HoBo form; it is encrypted there and written straight to the connected secret store. You never see the value: the result is a ticket, then the entry's name, stored: true and its store reference. Never ask for a secret in the chat. ${writerNames === "" ? "" : `Writes need a writer session first: capture ${writerNames} with writerClientId.`}`,
				inputSchema: {
					type: "object",
					properties: {
						name: {
							type: "string",
							enum: nameEnum,
							description: "The store entry to capture.",
						},
						writerClientId: {
							type: "string",
							description:
								"For the writer credential only: the writer identity's Universal Auth Client ID (an identifier, not a secret).",
						},
						channel: {
							type: "string",
							enum: ["auto", "loopback-page"],
							description:
								"auto (default): the host's form when it supports MCP Apps, otherwise a page on this machine. loopback-page: always the page.",
						},
						replace: {
							type: "boolean",
							description:
								"Open a new capture even if this name was just stored.",
						},
					},
					required: ["name"],
					additionalProperties: false,
				},
				...(support.apps
					? {
							_meta: {
								ui: { resourceUri: SECRET_CAPTURE_RESOURCE_URI },
								"ui/resourceUri": SECRET_CAPTURE_RESOURCE_URI,
							},
						}
					: undefined),
			};
			const status: SecretCaptureToolDefinition = {
				name: SECRET_CAPTURE_STATUS_TOOL,
				title: "Secret capture status",
				description:
					"The state of a capture (awaiting-owner, stored, authorized, expired, closed) and its store reference. Never the value.",
				inputSchema: {
					type: "object",
					properties: { ticketId: { type: "string" } },
					required: ["ticketId"],
					additionalProperties: false,
				},
			};
			const end: SecretCaptureToolDefinition = {
				name: END_SECRET_CAPTURE_TOOL,
				title: "End secret capture",
				description:
					"Close every open capture and end the writer session (its access token is revoked). Call it when the deployment's secrets are in the store.",
				inputSchema: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			};
			if (!support.apps) return [capture, status, end];
			const submitTool: SecretCaptureToolDefinition = {
				name: SUBMIT_SECRET_VALUE_TOOL,
				title: "Submit a sealed secret (capture form only)",
				description: "Used by the HoBo capture form itself. Not for the agent.",
				inputSchema: {
					type: "object",
					properties: {
						ticketId: { type: "string" },
						sealed: { type: "object" },
					},
					required: ["ticketId", "sealed"],
					additionalProperties: false,
				},
				_meta: {
					ui: {
						resourceUri: SECRET_CAPTURE_RESOURCE_URI,
						visibility: ["app"],
					},
				},
			};
			return [capture, submitTool, status, end];
		},
		resources(support) {
			if (!support.apps) return [];
			return [
				{
					uri: SECRET_CAPTURE_RESOURCE_URI,
					name: "hobo-secret-capture",
					title: "HoBo secret capture form",
					description:
						"The form the owner types a deployment secret into; it seals the value for the HoBo MCP server.",
					mimeType: MCP_APP_MIME_TYPE,
				},
			];
		},
		readResource(uri) {
			if (uri !== SECRET_CAPTURE_RESOURCE_URI) return undefined;
			return {
				contents: [
					{
						uri,
						mimeType: MCP_APP_MIME_TYPE,
						text: renderSecretCaptureHtml({ mode: "mcp-app" }),
						_meta: {
							ui: {
								// No network: the form talks only to its host.
								csp: { connectDomains: [], resourceDomains: [] },
								prefersBorder: true,
							},
						},
					},
				],
			};
		},
		handles(tool) {
			return SECRET_CAPTURE_TOOL_NAMES.includes(tool);
		},
		async callTool(tool, args, support) {
			try {
				return withHostSupport(tool, await call(tool, args, support), support);
			} catch (error) {
				const refusal =
					error instanceof SecretCaptureError
						? error
						: new SecretCaptureError(
								"SECRET_STORE_WRITE_FAILED",
								`The capture could not continue (${
									error instanceof SecretStoreConnectorError
										? error.code
										: "unavailable"
								}).`,
							);
				const name = stringArg(args, "name");
				return withHostSupport(
					tool,
					{
						kind: "result",
						result: refusalResult(
							refusal,
							name !== undefined && isSecretCaptureName(name)
								? name
								: undefined,
						),
					},
					support,
				);
			}
		},
		events() {
			return [...log];
		},
		async close() {
			await closeAll();
		},
	};
}

/** For tests and compositions: the codes a refusal can carry. */
export type { SecretCaptureCode };
