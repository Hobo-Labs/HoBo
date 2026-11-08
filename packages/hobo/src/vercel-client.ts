// @hobo/hobo — the REAL Vercel Create Deployment client (composition/app layer).
//
// This forms the request for Vercel's Create Deployment endpoint and parses the
// deployment URL back out. It is the ONE cloud actually reachable from HoBo's own
// pipeline: when `VERCEL_TOKEN` is present, `hobo up` drives this against the live
// API; when absent, compose falls back to the in-memory Pulumi-backed provider.
//
// Grounded in Vercel's REST API — Create a new deployment:
//   POST https://api.vercel.com/v13/deployments
//   Authorization: Bearer <token>
//   Content-Type: application/json
//   body: { name, project?, files:[{file,data,encoding}], target?, projectSettings? }
//   (docs: vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment)
//
// Create Deployment answers 404 `{"error":{"code":"not_found","message":"Project
// not found"}}` when the project it names does not exist. For that case,
// `createProject` calls Create a new project:
//   POST https://api.vercel.com/v9/projects   body: { name }
//   (409 `{"error":{"code":"conflict",...}}` when the name is taken)
//   (docs: vercel.com/docs/rest-api/reference/endpoints/projects/create-a-new-project,
//   whose current version is /v11). /v9 is the version @hobo/provider-vercel's
//   project resolver speaks, and `/v9/projects` is the prefix a credential
//   binding's scope already names.
//
// `fetch` is INJECTED so tests exercise the exact request formation against a
// mocked transport with no network. HONEST SCOPE: the live call is credential-
// gated and NOT exercised in this sandbox — only the request formation + response
// parsing are tested (against a mocked fetch).

// A single file in the deployment payload. `data` is the file content; when
// `encoding` is "base64" the content is base64-encoded (Vercel's inline-files
// contract). `file` is the POSIX path within the deployment.
import { at } from "@hobo/core/total-access";
import { redactProviderText } from "@hobo/provider-vercel";

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

interface VercelFetchInit {
	readonly method?: string;
	readonly headers?: { readonly [header: string]: string };
	readonly body?: string;
}

export interface VercelDeploymentFile {
	readonly file: string;
	readonly data: string;
	readonly encoding?: "base64" | "utf-8";
}

export interface CreateDeploymentInput {
	// The deployment name (Vercel `name`, required).
	readonly name: string;
	// The inline file tree to deploy (Vercel `files`).
	readonly files: readonly VercelDeploymentFile[];
	// The deployment target — "production" or "preview" (Vercel `target`).
	readonly target?: string;
	// The project name/id (Vercel `project`); defaults to `name` when omitted.
	readonly project?: string;
	// Optional project build settings (Vercel `projectSettings`). Defaults to a
	// zero-config static + Node-functions deploy (framework: null), matching the
	// committed hello-bindle artifact which needs no build step.
	readonly projectSettings?: JsonObject;
}

export interface VercelProjectResult {
	// The project id (Vercel `id`); empty when the create was answered 409.
	readonly id: string;
	// The project name (Vercel `name`).
	readonly name: string;
	// True when this call created the project; false when it already existed.
	readonly created: boolean;
	// When `created` is false: Vercel's `error.message` on the 409 `conflict`,
	// as refusal text (`refusalText`), if the body carried one.
	readonly conflictMessage?: string;
}

export interface VercelDeploymentResult {
	// The deployment URL, normalized to include the https:// scheme (Vercel returns
	// the bare host in `url`).
	readonly url: string;
	// The deployment id (Vercel `id`).
	readonly id: string;
	// The deployment readiness state when present (Vercel `readyState`).
	readonly readyState?: string;
	// The full parsed response body, for callers that need more than url/id.
	readonly raw: JsonValue;
}

// The minimal fetch surface this client depends on — a subset of the WHATWG
// `fetch`. Injecting this (rather than the global) keeps the client testable with
// a mock transport and free of a DOM/undici lib dependency.
export interface VercelFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	json(): Promise<JsonValue>;
}

// A request with nothing to send carries no `body`, as `fetch` requires of a GET.
export type VercelFetch = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body?: string;
	},
) => Promise<VercelFetchResponse>;

// A refusal from the Vercel API: a non-2xx status. `code` and `apiMessage` are
// Vercel's `error.code` and `error.message` when the body carried them; `message`
// names the call, the status and the body. `message` and `apiMessage` are
// refusal text (`refusalText`): redacted, and cut at 500 characters. `code` is
// kept only when it is a short identifier (`refusalCode`), and is otherwise
// undefined.
export class VercelApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	readonly apiMessage: string | undefined;

	constructor(
		message: string,
		status: number,
		code?: string,
		apiMessage?: string,
	) {
		super(message);
		this.name = "VercelApiError";
		this.status = status;
		this.code = code;
		this.apiMessage = apiMessage;
	}
}

// A request that got no answer to read: the transport threw or rejected (a
// refused connection, a header the runtime would not send), or a 2xx body could
// not be read. `message` names the call and says what was thrown, read down its
// `cause` chain and into an AggregateError's `errors` (`thrownText`), as refusal
// text: redacted, and cut at 500 characters. What was thrown is not kept, so it
// has no `cause`, and nothing unredacted is left to print.
export class VercelTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VercelTransportError";
	}
}

// Create Deployment's answer when the project it names does not exist: 404,
// `{"error":{"code":"not_found","message":"Project not found"}}`.
export function isProjectNotFound(error: Error): boolean {
	return (
		error instanceof VercelApiError &&
		error.status === 404 &&
		error.code === "not_found" &&
		/project not found/iu.test(error.apiMessage ?? "")
	);
}

export interface VercelClientOptions {
	// The Vercel access token, sent as `Authorization: Bearer <token>`.
	readonly token: string;
	// The transport. Defaults to the global `fetch`; injected in tests.
	readonly fetch?: VercelFetch;
	// The team id, sent as the `teamId` query parameter when the token is a team
	// token (Vercel `teamId`). Trimmed, and blank taken as none
	// (`normalizeVercelTeamId`).
	readonly teamId?: string;
	// The API base URL. Defaults to https://api.vercel.com (override for tests).
	readonly baseUrl?: string;
}

export interface VercelClient {
	getDeployment(
		deploymentId: string,
	): Promise<VercelDeploymentResult | undefined>;
	deleteDeployment(deploymentId: string): Promise<void>;
	createDeployment(
		input: CreateDeploymentInput,
	): Promise<VercelDeploymentResult>;
	// Create the project `name`. A 409 whose `error.code` is `conflict` (the
	// name is taken: someone made it meanwhile) answers `created: false`, with
	// its reason, rather than failing. Any other refusal, another 409 included,
	// is a VercelApiError.
	createProject(name: string): Promise<VercelProjectResult>;
}

const DEFAULT_BASE_URL = "https://api.vercel.com";

// The global `fetch` presented through the injectable `VercelFetch` shape. Node
// 18+ and modern runtimes expose a global `fetch`; we adapt it without importing
// DOM lib types.
const globalFetch: VercelFetch = (url, init) => {
	const fetchImpl =
		// SAFETY: assertion required at this I/O or test boundary.
		(
			globalThis as {
				fetch?: (
					input: string,
					init: VercelFetchInit,
				) => Promise<VercelFetchResponse>;
			}
		).fetch;
	if (!(fetchImpl instanceof Function)) {
		throw new Error(
			"vercel-client: no global fetch available; inject one via createVercelClient({ fetch })",
		);
	}
	return fetchImpl(url, init);
};

function normalizeUrl(raw: JsonValue | undefined): string {
	if (!isJsonString(raw) || raw.length === 0) {
		return "";
	}
	return raw.startsWith("http://") || raw.startsWith("https://")
		? raw
		: `https://${raw}`;
}

// The most of a refusal's text an error carries: `message` and `apiMessage` are
// each cut at this many characters, and a `…` marks the cut.
const REFUSAL_TEXT_LIMIT = 500;

// The part of `bytes`' base64 that depends on `bytes` alone, wherever in a
// longer value they sit: at each of the three alignments, the whole groups of
// four that hold only their bits (which covers `Bearer token` too).
function alignedBase64(bytes: Buffer): string[] {
	return [0, 1, 2].map((offset) =>
		Buffer.concat([Buffer.alloc(offset), bytes])
			.toString("base64")
			.slice(offset === 0 ? 0 : 4, 4 * Math.floor((offset + bytes.length) / 3)),
	);
}

// The client's own token as the strings a response body can echo it as: the
// token, and its base64 (whole, as a Basic header's `:token`, and the part of
// a longer base64 that depends on the token alone), the base64 of that base64,
// and the base64 of its percent-encoding (`%XX`, either case). How each of
// their characters can be written (escaped, percent-encoded, an HTML
// reference) is `charPattern`'s, not a form of its own. Longest first, so a
// whole form goes before a part of it; a derived piece shorter than four
// characters is left out.
function tokenForms(token: string): readonly string[] {
	const bytes = Buffer.from(token, "utf8");
	const percent = [...bytes]
		.map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
		.join("");
	const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
	const derived = [
		bytes.toString("base64"),
		base64(`:${token}`),
		...alignedBase64(bytes),
		base64(bytes.toString("base64")),
		base64(percent),
		base64(percent.toUpperCase()),
	];
	const forms = new Set([token, ...derived.filter((form) => form.length >= 4)]);
	return [...forms].sort((a, b) => b.length - a.length);
}

// A regular-expression source matching `char` itself.
function literal(char: string): string {
	return /[\\^$.*+?()[\]{}|/]/u.test(char) ? `\\${char}` : char;
}

// What can sit unseen between two characters of a token: whitespace (a
// newline, `\r\n`, spaces, tabs), a control character (NUL, ESC, DEL, NEL),
// or a format character (a soft hyphen, a zero-width space or joiner, a word
// joiner). A message shows a control character as a space, and a format
// character not at all, so either leaves the token readable.
const BREAK_CHAR = "[\\s\\p{Cc}\\p{Cf}]";

// Patterns for the hex digits of `value`, at least `width` of them, one per
// digit, each in either case.
function hexDigits(value: number, width: number): string[] {
	return Array.from(value.toString(16).padStart(width, "0"), (digit) => {
		const upper = digit.toUpperCase();
		return upper === digit ? digit : `[${digit}${upper}]`;
	});
}

// One character of a form as a pattern, after OpenSesame's per-character
// scrub (crates/invoke-through/src/scrub.rs): the character itself (a `/` also
// as JSON's `\/`); a JSON escape `\uXXXX`, either case, after one backslash
// or more (JSON inside a JSON string doubles them); each of its UTF-8 bytes
// percent-encoded, `%XX` or, encoded twice, `%25XX`, either case; or an HTML
// numeric reference, `&#xNN;` or `&#NN;`, either case, with leading zeros, the
// `;` optional. A run of backslashes is entered only at its start (the
// lookbehinds), and a run of zeros only after `&#`, so no run is scanned once
// per character of it.
function charPattern(char: string): string {
	const point = char.codePointAt(0) ?? 0;
	const units =
		point > 0xffff
			? [
					0xd800 + ((point - 0x10000) >> 10),
					0xdc00 + ((point - 0x10000) & 0x3ff),
				]
			: [point];
	const json = units
		.map((unit) => `(?<!\\\\)\\\\+u${hexDigits(unit, 4).join("")}`)
		.join("");
	const percent = [...Buffer.from(char, "utf8")]
		.map((byte) => `%(?:25)?${hexDigits(byte, 2).join("")}`)
		.join("");
	const hexRef = `&#[xX]0*${hexDigits(point, 1).join("")};?`;
	const decRef = `&#0*${point};?`;
	const itself = char === "/" ? "(?<!\\\\)\\\\*\\/" : literal(char);
	return `(?:${itself}|${json}|${percent}|${hexRef}|${decRef})`;
}

// Each form of the client's own token (`tokenForms`) as a pattern: each of its
// characters written any way `charPattern` names. Built from the forms'
// characters, never from the token as a pattern. They are matched against a
// text with its breaks (BREAK_CHAR) taken out (`withoutToken`), so they have
// none of their own, and an attempt runs no further than one form written out:
// a search is linear in the text for a token of bounded length. One pattern
// for each form, not one for them all: a single alternation of every form is
// some hundred times slower to search.
function tokenPatterns(token: string): readonly RegExp[] {
	return tokenForms(token).map(
		(form) => new RegExp(Array.from(form, charPattern).join(""), "gu"),
	);
}

// One character that can sit unseen between two characters of a token.
const ONE_BREAK = new RegExp(`^${BREAK_CHAR}$`, "u");

// Whether `point` (the code point `char` holds) is a break: in ASCII, the
// controls and the space (`\s` there is a subset of them); above it, whatever
// BREAK_CHAR matches, astral format characters (the tag characters) included.
function isBreak(point: number, char: string): boolean {
	return point < 0x80 ? point <= 0x20 || point === 0x7f : ONE_BREAK.test(char);
}

// `text` with its breaks taken out, as `kept`, and where each piece of it
// between two runs of breaks starts: `at[i]` in `text`, `from[i]` in `kept`.
interface Unbroken {
	readonly kept: string;
	readonly at: readonly number[];
	readonly from: readonly number[];
}

function unbroken(text: string): Unbroken {
	const parts: string[] = [];
	const at: number[] = [];
	const from: number[] = [];
	let length = 0;
	let start = -1;
	for (let index = 0; index < text.length; ) {
		const point = text.codePointAt(index) ?? 0;
		const width = point > 0xffff ? 2 : 1;
		if (isBreak(point, text.slice(index, index + width))) {
			if (start >= 0) {
				parts.push(text.slice(start, index));
				length += index - start;
				start = -1;
			}
		} else if (start < 0) {
			start = index;
			at.push(index);
			from.push(length);
		}
		index += width;
	}
	if (start >= 0) parts.push(text.slice(start));
	return { kept: parts.join(""), at, from };
}

// A stretch of a text: its first character, and the one after its last.
interface Span {
	readonly start: number;
	readonly end: number;
}

// `text` with every form of the token (`tokenPatterns`) as `[redacted]`, found
// written any way `charPattern` names and broken up anywhere, inside an
// encoding too, by runs of breaks (BREAK_CHAR). The patterns are matched
// against `text` with its breaks taken out; the stretches they match are
// joined where they meet or overlap, and each is redacted in `text` from its
// first character to its last, breaks inside it and all.
function withoutToken(text: string, secrets: readonly RegExp[]): string {
	const { kept, at: pieceAt, from: pieceFrom } = unbroken(text);
	const found: Span[] = [];
	for (const secret of secrets) {
		for (const match of kept.matchAll(secret)) {
			found.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	if (found.length === 0) return text;
	found.sort((a, b) => a.start - b.start || b.end - a.end);
	// Where in `text` the character at `index` of `kept` is. The stretches come
	// in order, so the pieces are walked once.
	let piece = 0;
	const inText = (index: number): number => {
		while (piece + 1 < pieceFrom.length && at(pieceFrom, piece + 1) <= index)
			piece++;
		return at(pieceAt, piece) + index - at(pieceFrom, piece);
	};
	let out = "";
	let copied = 0;
	let open: Span | undefined;
	const redact = (span: Span) => {
		const start = inText(span.start);
		const end = inText(span.end - 1) + 1;
		out += `${text.slice(copied, start)}[redacted]`;
		copied = end;
	};
	for (const span of found) {
		if (open !== undefined && span.start <= open.end) {
			open = { start: open.start, end: Math.max(open.end, span.end) };
			continue;
		}
		if (open !== undefined) redact(open);
		open = span;
	}
	if (open !== undefined) redact(open);
	return `${out}${text.slice(copied)}`;
}

// A response body can echo the request, Authorization header included, and the
// executor persists an error's message (`exec.Failed.reason`). So every form of
// the client's own token (`tokenPatterns`), and anything bearer- or
// credential-shaped, becomes `[redacted]` (`redactProviderText` is the
// redaction @hobo/provider-vercel's resolvers use), and the text is cut at
// REFUSAL_TEXT_LIMIT characters. The token is looked for again once
// `redactProviderText` has changed the text (it turns control characters into
// spaces, trims, and cuts), so nothing it does can bring the token back.
function refusalText(text: string, secrets: readonly RegExp[]): string {
	return tokenFreeRefusalText(withoutToken(text, secrets), secrets);
}

// `refusalText` of a text the token has already been taken out of: the
// credential shapes, the cut, and the token looked for once more.
function tokenFreeRefusalText(
	text: string,
	secrets: readonly RegExp[],
): string {
	return withoutToken(redactProviderText(text, REFUSAL_TEXT_LIMIT), secrets);
}

// A container of a JSON value being copied, and the copy it is filled into.
type JsonCopy =
	| { readonly from: readonly JsonValue[]; readonly to: JsonValue[] }
	| { readonly from: JsonObject; readonly to: Record<string, JsonValue> };

// `value` with the token taken out if it is a string, an empty copy of it
// (queued on `pending`, to be filled) if it is an array or an object, else
// `value` itself.
function copyStep(
	value: JsonValue,
	secrets: readonly RegExp[],
	pending: JsonCopy[],
): JsonValue {
	if (isJsonString(value)) return withoutToken(value, secrets);
	if (isJsonArray(value)) {
		const to: JsonValue[] = [];
		pending.push({ from: value, to });
		return to;
	}
	if (isJsonObject(value)) {
		const to: Record<string, JsonValue> = {};
		pending.push({ from: value, to });
		return to;
	}
	return value;
}

// A JSON value with the token taken out of every string in it, keys included.
// Walked with a queue of containers rather than by recursion, so a body nested
// any depth cannot run the call stack out. Keys are defined, never assigned,
// so a `__proto__` key stays a key.
function withoutTokenInJson(
	value: JsonValue,
	secrets: readonly RegExp[],
): JsonValue {
	const pending: JsonCopy[] = [];
	const copy = copyStep(value, secrets, pending);
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (isJsonArray(next.to)) {
			for (const item of Object.values(next.from)) {
				next.to.push(copyStep(item, secrets, pending));
			}
			continue;
		}
		for (const [key, item] of Object.entries(next.from)) {
			Object.defineProperty(next.to, withoutToken(key, secrets), {
				value: copyStep(item, secrets, pending),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return copy;
}

// A body as `message` shows it, the token taken out: a JSON body as `json`,
// that body parsed (which undoes its escapes) with the token taken out of its
// strings, written back out with `JSON.stringify`; any other body as sent,
// searched as text. Writing a body back out only escapes what its strings
// hold, so it brings back no token the walk took out. A body too deep to write
// back out (`JSON.stringify` throws RangeError some thousands of levels down)
// is searched as text too.
function bodyText(
	detail: string,
	json: JsonValue | undefined,
	secrets: readonly RegExp[],
): string {
	if (json !== undefined) {
		try {
			return JSON.stringify(json);
		} catch {
			// Too deep to write back out: searched as text below.
		}
	}
	return withoutToken(detail, secrets);
}

// The most parts of what a transport threw `thrownText` reads.
const THROWN_PARTS = 8;

// What a transport threw, part by part: an Error's name, its `code` when it is
// a string, and its message, then what it holds (an AggregateError's `errors`,
// then its `cause`), each once; a thrown string as it is; anything else by its
// type alone. At most THROWN_PARTS parts, so a chain that loops or runs long
// ends. The caller makes it refusal text.
function thrownText(cause: unknown): string {
	const parts: string[] = [];
	const queue: unknown[] = [cause];
	const seen = new Set<unknown>();
	while (queue.length > 0 && parts.length < THROWN_PARTS) {
		const next = queue.shift();
		if (seen.has(next)) continue;
		seen.add(next);
		if (next instanceof Error) {
			const code =
				"code" in next && isJsonString(next.code) ? ` [${next.code}]` : "";
			parts.push(`${next.name}${code}: ${next.message}`);
			if (next instanceof AggregateError && Array.isArray(next.errors)) {
				queue.push(...next.errors.slice(0, THROWN_PARTS));
			}
			if (next.cause !== undefined) queue.push(next.cause);
		} else if (isJsonString(next)) {
			parts.push(next);
		} else {
			// `[object Null]` and the like: the type, never the value.
			const tag = Object.prototype.toString.call(next).slice(8, -1);
			parts.push(`a thrown ${tag.toLowerCase()}`);
		}
	}
	return parts.join("; ");
}

// `what` and what a transport threw, as a VercelTransportError. A thrown value
// whose own getters throw is not read at all.
function transportError(
	what: string,
	cause: unknown,
	secrets: readonly RegExp[],
): VercelTransportError {
	let said: string;
	try {
		said = thrownText(cause);
	} catch {
		said = "a thrown value that could not be read";
	}
	return new VercelTransportError(
		refusalText(`vercel-client: ${what}: ${said}`, secrets),
	);
}

// `step`'s result, or, when it throws or rejects, a VercelTransportError for
// `what`.
async function untilAnswered<T>(
	what: string,
	secrets: readonly RegExp[],
	step: () => Promise<T>,
): Promise<T> {
	try {
		return await step();
	} catch (thrown) {
		throw transportError(what, thrown, secrets);
	}
}

// Whitespace, a control character or a format character: what a token cannot
// hold. RFC 6750's b64token has none of them, a runtime refuses CR, LF and NUL
// in a header, and the redaction takes these out of a text before it looks for
// the token (`withoutToken`), so a token that held one could never be found.
const TOKEN_BREAK = new RegExp(BREAK_CHAR, "u");

// Vercel's `error.code` is an identifier (`not_found`, `forbidden`). One that
// is not (longer than 64 characters, any other character, or text the
// redaction would change, such as the token itself) is not kept anywhere on the
// error; the body in `message` is refusal text either way.
const REFUSAL_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

function refusalCode(
	code: string,
	secrets: readonly RegExp[],
): string | undefined {
	return REFUSAL_CODE.test(code) && refusalText(code, secrets) === code
		? code
		: undefined;
}

async function failure(
	what: string,
	response: VercelFetchResponse,
	secrets: readonly RegExp[],
): Promise<VercelApiError> {
	const detail = await response.text().catch(() => "");
	// Parsed once, and the token taken out of it once: `code`, `apiMessage` and
	// `message` are each read from that.
	const parsed = parseJsonValue(detail);
	const json =
		parsed === null ? undefined : withoutTokenInJson(parsed, secrets);
	const error = isJsonObject(json) ? json.error : undefined;
	const code =
		isJsonObject(error) && isJsonString(error.code)
			? refusalCode(error.code, secrets)
			: undefined;
	const apiMessage =
		isJsonObject(error) && isJsonString(error.message)
			? tokenFreeRefusalText(error.message, secrets)
			: undefined;
	return new VercelApiError(
		tokenFreeRefusalText(
			`vercel-client: ${what} failed (HTTP ${response.status})${detail ? `: ${bodyText(detail, json, secrets)}` : ""}`,
			secrets,
		),
		response.status,
		code,
		apiMessage,
	);
}

// `text` cut at `limit` characters, a `…` marking the cut, as
// `redactProviderText` cuts.
function cutText(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// The most of the 409's reason the note carries. With it the note is at most
// 256 characters, so the deployment refusal always keeps 243 of its own.
const CONFLICT_REASON_LIMIT = 200;

// The refusal of a deployment sent again after its project's create was
// answered 409 `conflict`: the same refusal, its message followed by a note
// naming that 409 and its reason (cut at CONFLICT_REASON_LIMIT). The note is
// kept whole and the refusal's own message is cut to the room left, so the
// message stays within REFUSAL_TEXT_LIMIT plus a `…`. Both parts are refusal
// text already.
export function afterConflict(
	error: VercelApiError,
	conflict: VercelProjectResult,
): VercelApiError {
	const reason =
		conflict.conflictMessage === undefined
			? ""
			: `: ${cutText(conflict.conflictMessage, CONFLICT_REASON_LIMIT)}`;
	const note = `(after create project was answered HTTP 409 conflict${reason})`;
	const room = REFUSAL_TEXT_LIMIT - note.length - 1;
	return new VercelApiError(
		`${cutText(error.message, room)} ${note}`,
		error.status,
		error.code,
		error.apiMessage,
	);
}

// The JSON object a 2xx answer carries, or `{}` when it carries something else.
async function payloadOf(response: VercelFetchResponse): Promise<JsonObject> {
	const parsed = await response.json();
	return isJsonObject(parsed) ? parsed : {};
}

// A team id as every entry point takes it (`createVercelClient`'s and
// `createVercelDeployProvider`'s `teamId`, and `selectIacProvider`'s
// environment): trimmed, and empty or blank as none.
export function normalizeVercelTeamId(
	teamId: string | undefined,
): string | undefined {
	const trimmed = teamId?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

// Create the REAL Vercel deployment client. No network call happens at
// construction; a request is formed and sent only by a method call.
export function createVercelClient(options: VercelClientOptions): VercelClient {
	const { token } = options;
	if (!token) {
		throw new TypeError("createVercelClient: token is required");
	}
	if (TOKEN_BREAK.test(token)) {
		throw new TypeError(
			"createVercelClient: the token holds whitespace, or a control or format character (CR, LF and NUL among them), which no Vercel token holds and an Authorization header cannot carry: nothing was sent. Set the token again without them",
		);
	}
	const secrets = tokenPatterns(token);
	const fetchImpl = options.fetch ?? globalFetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const teamId = normalizeVercelTeamId(options.teamId);
	const query =
		teamId !== undefined ? `?teamId=${encodeURIComponent(teamId)}` : "";
	// One JSON POST to `path` under the base URL, team-scoped like every other;
	// a transport that throws is a VercelTransportError naming `what`.
	const post = (
		what: string,
		path: string,
		body: string,
	): Promise<VercelFetchResponse> =>
		untilAnswered(`${what} got no answer`, secrets, () =>
			fetchImpl(`${baseUrl}${path}${query}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body,
			}),
		);
	// The JSON object a 2xx answer to `what` carries; a body that cannot be read
	// is a VercelTransportError.
	const payloadFrom = (
		what: string,
		response: VercelFetchResponse,
	): Promise<JsonObject> =>
		untilAnswered(
			`${what} answered HTTP ${response.status}, and its body could not be read`,
			secrets,
			() => payloadOf(response),
		);

	// A request with nothing to send: no body, as `fetch` requires of a GET;
	// a transport that throws is a VercelTransportError naming `what`.
	const send = (
		what: string,
		method: "GET" | "DELETE",
		url: string,
	): Promise<VercelFetchResponse> =>
		untilAnswered(`${what} got no answer`, secrets, () =>
			fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}` } }),
		);

	// A deployment's own URL, team-scoped like every other request.
	function deploymentPath(deploymentId: string) {
		if (!deploymentId || !/^[A-Za-z0-9_-]+$/.test(deploymentId))
			throw new Error("invalid deployment receipt identity");
		return `${baseUrl}/v13/deployments/${encodeURIComponent(deploymentId)}${query}`;
	}
	async function readDeployment(deploymentId: string) {
		const response = await send(
			"get deployment",
			"GET",
			deploymentPath(deploymentId),
		);
		if (response.status === 404) return undefined;
		if (!response.ok)
			throw new Error(
				`vercel-client: get deployment failed (HTTP ${response.status})`,
			);
		const payload = await payloadFrom("get deployment", response);
		if (payload.id !== deploymentId)
			throw new Error(
				"vercel-client: deployment read returned a different identity",
			);
		return {
			id: deploymentId,
			url: normalizeUrl(payload.url),
			...(isJsonString(payload.readyState)
				? { readyState: payload.readyState }
				: undefined),
			raw: payload,
		};
	}
	return {
		getDeployment: readDeployment,
		async deleteDeployment(deploymentId: string) {
			const response = await send(
				"delete deployment",
				"DELETE",
				deploymentPath(deploymentId),
			);
			if (!response.ok && response.status !== 404)
				throw new Error(
					`vercel-client: delete deployment failed (HTTP ${response.status})`,
				);
			if (await readDeployment(deploymentId))
				throw new Error(
					"vercel-client: deployment deletion remains unconfirmed",
				);
		},

		async createProject(name: string): Promise<VercelProjectResult> {
			const made = await post(
				"create project",
				"/v9/projects",
				JSON.stringify({ name }),
			);
			if (!made.ok) {
				const refusal = await failure("create project", made, secrets);
				if (refusal.status !== 409 || refusal.code !== "conflict")
					throw refusal;
				return {
					id: "",
					name,
					created: false,
					...(refusal.apiMessage !== undefined
						? { conflictMessage: refusal.apiMessage }
						: undefined),
				};
			}
			const payload = await payloadFrom("create project", made);
			return {
				id: isJsonString(payload.id) ? payload.id : "",
				name: isJsonString(payload.name) ? payload.name : name,
				created: true,
			};
		},

		async createDeployment(
			input: CreateDeploymentInput,
		): Promise<VercelDeploymentResult> {
			const body = {
				name: input.name,
				project: input.project ?? input.name,
				files: input.files.map((f) => ({
					file: f.file,
					data: f.data,
					encoding: f.encoding ?? "base64",
				})),
				...(input.target !== undefined ? { target: input.target } : undefined),
				projectSettings: input.projectSettings ?? { framework: null },
			};

			const response = await post(
				"create deployment",
				"/v13/deployments",
				JSON.stringify(body),
			);

			if (!response.ok) {
				throw await failure("create deployment", response, secrets);
			}

			const payload = await payloadFrom("create deployment", response);
			const id = isJsonString(payload.id) ? payload.id : "";
			return {
				url: normalizeUrl(payload.url),
				id,
				...(isJsonString(payload.readyState)
					? { readyState: payload.readyState }
					: undefined),
				raw: payload,
			};
		},
	};
}
