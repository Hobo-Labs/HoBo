import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";
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

// public-contract:
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
// public-contract:
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
// public-contract:
export const MCP_APPS_SPEC_VERSION = "2026-01-26";
// public-contract:
export const SECRET_CAPTURE_RESOURCE_URI = "ui://hobo/secret-capture";
// public-contract:
export const CAPTURE_SECRET_TOOL = "capture_secret";
// public-contract:
export const SUBMIT_SECRET_VALUE_TOOL = "submit_secret_value";
// public-contract:
export const SECRET_CAPTURE_STATUS_TOOL = "secret_capture_status";
// public-contract:
export const END_SECRET_CAPTURE_TOOL = "end_secret_capture";
// public-contract:
export const URL_ELICITATION_REQUIRED = -32042;
// public-contract:
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
	| "loopback-page";
type TicketState =
	| "awaiting-owner"
	| "stored"
	| "authorized"
	| "expired"
	| "uncertain"
	| "closed";

export type SecretCaptureHostSupport = Readonly<{
	apps: boolean;
	urlElicitation: boolean;
}>;

export const NO_HOST_SUPPORT: SecretCaptureHostSupport = Object.freeze({
	apps: false,
	urlElicitation: false,
});

function objectAt(
	value: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	return isJsonObject(value) ? value[key] : undefined;
}

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
	const urlElicitation = isJsonObject(
		objectAt(objectAt(capabilities, "elicitation"), "url"),
	);
	return Object.freeze({ apps, urlElicitation });
}

export type SecretStoreStatus =
	| Readonly<{ connected: false; reason: string; nextStep: string }>
	| Readonly<{
			connected: true;
			storeRef: string;
			writable: boolean;
			writerSpec: string;
	  }>;

export interface SecretStoreConnector {
	status(): Promise<SecretStoreStatus>;
	authorizeWriter(input: {
		readonly clientId: string;
		readonly secret: CapturedSecret;
	}): Promise<Readonly<{ ref: string; expiresAt: string }>>;
	store(
		target: Exclude<SecretCaptureTarget, "writer">,
		secret: CapturedSecret,
	): Promise<Readonly<{ ref: string }>>;
	endWriterSession(): Promise<"ended" | "none">;
}

export type SecretCaptureEventType =
	| "secret.CaptureOpened"
	| "secret.CaptureWriteStarted"
	| "secret.CaptureWriteUncertain"
	| "secret.CaptureWriterSessionEnded"
	| "secret.CaptureWriterSessionUncertain"
	| "secret.CaptureStored"
	| "secret.CaptureAuthorized"
	| "secret.CaptureRejected"
	| "secret.CaptureRefused"
	| "secret.CaptureExpired"
	| "secret.CaptureClosed";

export type SecretCaptureEvent = Readonly<{
	id: string;
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

export type SecretCaptureToolDefinition = Readonly<{
	name: string;
	title: string;
	description: string;
	inputSchema: JsonValue;
	_meta?: JsonValue;
}>;

export type SecretCaptureToolResult = Readonly<{
	content: readonly Readonly<{ type: "text"; text: string }>[];
	structuredContent: JsonValue;
	isError: boolean;
}>;

export type SecretCaptureOutcome =
	| Readonly<{ kind: "result"; result: SecretCaptureToolResult }>
	| Readonly<{
			kind: "error";
			error: Readonly<{ code: number; message: string; data: JsonValue }>;
	  }>;

export interface SecretCaptureApp {
	tools(
		support: SecretCaptureHostSupport,
	): readonly SecretCaptureToolDefinition[];
	resources(support: SecretCaptureHostSupport): readonly JsonValue[];
	readResource(uri: string): JsonValue | undefined;
	handles(tool: string): boolean;
	callTool(
		tool: string,
		args: JsonValue | undefined,
		support: SecretCaptureHostSupport,
	): Promise<SecretCaptureOutcome>;
	events(): readonly SecretCaptureEvent[];
	close(): Promise<void>;
}

export type CreateSecretCaptureAppOptions = Readonly<{
	specs: readonly ParsedSecretCaptureSpec[];
	connector: SecretStoreConnector;
	now?: () => number;
	ttlMs?: number;
	maxOpen?: number;
	maxAttempts?: number;
	onEvent?: (event: SecretCaptureEvent) => void | Promise<void>;
	notify?: (method: string, params: JsonValue) => void;
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
	writeStarted: boolean;
};

const TICKET_ID = /^cap_[A-Za-z0-9_-]{22}$/u;
const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const STORE_REF =
	/^(?:infisical|secref|hobo-writer-session):\/\/[A-Za-z0-9._~/:@-]{1,512}$/u;
const MAX_EVENTS = 1000;

function digest(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

type RefusalView = {
	code: string;
	message: string;
	nextStep?: string;
	name?: string;
};

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
	const pendingEvents: SecretCaptureEvent[] = [];
	const closingPages: Promise<void>[] = [];
	let seq = 0;
	let page: Promise<LoopbackCapturePage> | undefined;
	let queue: Promise<void> = Promise.resolve();
	let terminated = false;

	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const result = queue.then(work);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function auditUnavailable(): SecretCaptureError {
		return new SecretCaptureError(
			"SECRET_CAPTURE_AUDIT_UNAVAILABLE",
			"The capture audit record could not be saved.",
			"Restore the audit journal before continuing.",
		);
	}

	async function flushEvents(): Promise<void> {
		while (pendingEvents.length > 0) {
			const event = pendingEvents[0];
			if (event === undefined) break;
			try {
				await options.onEvent?.(event);
			} catch {
				throw auditUnavailable();
			}
			pendingEvents.shift();
			log.push(event);
			if (log.length > MAX_EVENTS) log.shift();
		}
	}

	function queueEvent(
		type: SecretCaptureEventType,
		fields: Omit<
			SecretCaptureEvent,
			"id" | "schemaVersion" | "type" | "seq" | "time"
		>,
		id = `sec_${randomBytes(16).toString("hex")}`,
	): void {
		seq += 1;
		const event: SecretCaptureEvent = Object.freeze({
			id,
			schemaVersion: SECRET_CAPTURE_EVENTS_SCHEMA_VERSION,
			type,
			seq,
			time: new Date().toISOString(),
			...fields,
		});
		pendingEvents.push(event);
	}

	async function emit(
		type: SecretCaptureEventType,
		fields: Omit<
			SecretCaptureEvent,
			"id" | "schemaVersion" | "type" | "seq" | "time"
		>,
		id?: string,
	): Promise<void> {
		queueEvent(type, fields, id);
		await flushEvents();
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

	async function sweep(): Promise<void> {
		const at = now();
		for (const ticket of tickets.values())
			if (ticket.state === "awaiting-owner" && at >= ticket.expiresAtMs) {
				shut(ticket, "expired");
				await emit("secret.CaptureExpired", ticketFields(ticket));
			}
	}

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

	async function openTicket(id: string): Promise<Ticket | undefined> {
		await sweep();
		const ticket = tickets.get(id);
		return ticket?.state === "awaiting-owner" ? ticket : undefined;
	}

	function loopback(): Promise<LoopbackCapturePage> {
		page ??= startLoopbackCapturePage({
			async page(id, nonce) {
				return exclusive(async () => {
					if (terminated) return undefined;
					await flushEvents();
					const ticket = await openTicket(id);
					if (ticket === undefined || ticket.channel === "mcp-app")
						return undefined;
					return renderSecretCaptureHtml({
						mode: "loopback",
						nonce,
						ticket: pageTicket(ticket),
					});
				});
			},
			async submit(id, token, sealed): Promise<LoopbackAnswer> {
				return exclusive(async () => {
					if (terminated)
						return {
							status: 410,
							body: {
								code: "SECRET_CAPTURE_CLOSED",
								message: "The capture session is closed.",
							},
						};
					await flushEvents();
					const ticket = await openTicket(id);
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
				});
			},
		});
		return page;
	}

	async function refuseIfNotWritable(
		spec: ParsedSecretCaptureSpec,
	): Promise<SecretCaptureError | undefined> {
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
		await sweep();
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
			await emit("secret.CaptureRefused", {
				name: spec.name,
				code: refusal.code,
			});
			throw refusal;
		}
		const replace = objectAt(args, "replace") === true;
		const previous = [...tickets.values()]
			.filter((ticket) => ticket.spec.name === spec.name)
			.at(-1);
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
			await emit("secret.CaptureClosed", ticketFields(previous));
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
			requested === "loopback-page"
				? "loopback-page"
				: support.apps
					? "mcp-app"
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
			writeStarted: false,
		};
		if (channel !== "mcp-app") {
			const token = randomBytes(32).toString("base64url");
			ticket.tokenDigest = digest(token);
			ticket.url = `${(await loopback()).origin}/capture/${ticket.id}#${token}`;
		}
		tickets.set(ticket.id, ticket);
		await emit("secret.CaptureOpened", ticketFields(ticket));
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
				? `The owner is entering ${ticket.spec.name} in the HoBo form shown with this result. It goes straight to the secret store; you will not see it and must not ask for it. When the owner says it is done, call ${SECRET_CAPTURE_STATUS_TOOL} with ticketId ${ticket.id}.`
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

	async function failed(
		ticket: Ticket,
		error: SecretCaptureError,
		event: SecretCaptureEventType,
		code: string,
	): Promise<SecretCaptureToolResult> {
		ticket.attempts += 1;
		const exhausted = ticket.attempts >= maxAttempts;
		if (exhausted) shut(ticket, "closed");
		let auditFailed = false;
		try {
			await emit(event, { ...ticketFields(ticket), code });
		} catch {
			auditFailed = true;
		}
		if (exhausted) {
			try {
				await emit("secret.CaptureClosed", ticketFields(ticket));
			} catch {
				auditFailed = true;
			}
		}
		if (auditFailed) throw auditUnavailable();
		if (exhausted) {
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
		let ref: string;
		let state: "stored" | "authorized";
		if (ticket.spec.target !== "writer") {
			const refusal = await refuseIfNotWritable(ticket.spec);
			if (refusal !== undefined)
				return failed(ticket, refusal, "secret.CaptureRefused", refusal.code);
		}
		const outcomeEventId = `sec_${randomBytes(16).toString("hex")}`;
		if (!ticket.writeStarted) {
			queueEvent("secret.CaptureWriteStarted", ticketFields(ticket));
			ticket.writeStarted = true;
			await flushEvents();
		}
		try {
			if (ticket.spec.target === "writer") {
				({ ref } = await options.connector.authorizeWriter({
					clientId: ticket.writerClientId ?? "",
					secret,
				}));
				state = "authorized";
			} else {
				({ ref } = await options.connector.store(ticket.spec.target, secret));
				state = "stored";
			}
			if (!STORE_REF.test(ref) || secret.isContainedIn(ref))
				throw new SecretStoreConnectorError("invalid-reference");
		} catch (error) {
			const connectorCode =
				error instanceof SecretStoreConnectorError ? error.code : "unavailable";
			const code = secret.isContainedIn(connectorCode)
				? "unavailable"
				: connectorCode;
			shut(ticket, "uncertain");
			await emit(
				"secret.CaptureWriteUncertain",
				{
					...ticketFields(ticket),
					code,
				},
				outcomeEventId,
			);
			const refusal =
				ticket.spec.target === "writer"
					? new SecretCaptureError(
							"SECRET_STORE_WRITER_DENIED",
							`The writer authorization outcome is uncertain (${code}).`,
							"Check the writer session before opening a new capture.",
						)
					: new SecretCaptureError(
							"SECRET_STORE_WRITE_FAILED",
							`The store outcome for ${ticket.spec.name} is uncertain (${code}).`,
							"Check the secret store before opening a new capture.",
						);
			return refusalResult(refusal, ticket.spec.name);
		}
		ticket.ref = ref;
		shut(ticket, state);
		await emit(
			state === "stored" ? "secret.CaptureStored" : "secret.CaptureAuthorized",
			{
				...ticketFields(ticket),
				ref,
			},
			outcomeEventId,
		);
		if (ticket.channel === "url-elicitation")
			try {
				options.notify?.("notifications/elicitation/complete", {
					elicitationId: ticket.id,
				});
			} catch {}
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
			const ticket = TICKET_ID.test(id) ? await openTicket(id) : undefined;
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
			await sweep();
			const id = stringArg(args, "ticketId") ?? "";
			const ticket = TICKET_ID.test(id) ? tickets.get(id) : undefined;
			if (ticket === undefined)
				throw new SecretCaptureError(
					"SECRET_CAPTURE_UNKNOWN_TICKET",
					"No capture has that ticket id.",
				);
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
		let auditFailed = false;
		for (const ticket of tickets.values())
			if (ticket.state === "awaiting-owner") {
				shut(ticket, "closed");
				captures += 1;
				try {
					await emit("secret.CaptureClosed", ticketFields(ticket));
				} catch {
					auditFailed = true;
				}
			}
		try {
			await flushEvents();
		} catch {
			auditFailed = true;
		}
		let writerSession: "ended" | "none" | "unavailable";
		try {
			writerSession = await options.connector.endWriterSession();
		} catch {
			writerSession = "unavailable";
		}
		if (writerSession !== "none") {
			try {
				await emit(
					writerSession === "ended"
						? "secret.CaptureWriterSessionEnded"
						: "secret.CaptureWriterSessionUncertain",
					{},
				);
			} catch {
				auditFailed = true;
			}
		}
		const running = page;
		page = undefined;
		if (running !== undefined) {
			const closing = running.then((current) => current.close());
			void closing.catch(() => undefined);
			closingPages.push(closing);
		}
		if (auditFailed) throw auditUnavailable();
		return { captures, writerSession };
	}

	async function drainPages(): Promise<void> {
		await Promise.all(closingPages.splice(0));
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
			let outcome: SecretCaptureOutcome;
			try {
				outcome = await exclusive(async () => {
					if (terminated)
						throw new SecretCaptureError(
							"SECRET_CAPTURE_CLOSED",
							"The capture session is closed.",
						);
					if (tool !== END_SECRET_CAPTURE_TOOL) await flushEvents();
					return call(tool, args, support);
				});
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
				outcome = {
					kind: "result",
					result: refusalResult(
						refusal,
						name !== undefined && isSecretCaptureName(name) ? name : undefined,
					),
				};
			}
			if (tool === END_SECRET_CAPTURE_TOOL) {
				try {
					await drainPages();
				} catch {
					return {
						kind: "result",
						result: refusalResult(
							new SecretCaptureError(
								"SECRET_CAPTURE_CLOSED",
								"The capture page could not be stopped.",
							),
						),
					};
				}
			}
			return outcome;
		},
		events() {
			return [...log];
		},
		async close() {
			try {
				await exclusive(async () => {
					if (terminated) return flushEvents();
					terminated = true;
					await closeAll();
				});
			} finally {
				await drainPages();
			}
		},
	};
}

export type { SecretCaptureCode };
