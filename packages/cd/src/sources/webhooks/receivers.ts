// Webhook receivers (D3: "webhooks only nudge"). Each receiver authenticates
// the request first (HMAC signature or shared token, compared in constant
// time), and only then reads the payload for repository keys. The result is a
// set of keys to schedule polls for; a payload never becomes Freight (I15).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JsonValue } from "@hobo/core";
import type { ReasonRecord } from "../../_generated/cd_pb.js";
import type { CredentialResolver, FeedRequest } from "../../ports.js";
import { field, list, parseJson, text, utf8 } from "../json.js";
import { refuse, SOURCE_REASON } from "../reasons.js";
import { gitKey, ociKey, purlKey } from "./keys.js";

// public-contract: receiver ids (the last path segment of the nudge URL).
export const WEBHOOK_RECEIVERS = Object.freeze([
	"cloudevents",
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
	"forgejo",
	"harbor",
	"dockerhub",
	"ghcr",
	"ecr",
	"artifact-registry",
] as const);
export type WebhookReceiver = (typeof WEBHOOK_RECEIVERS)[number];

// public-contract: the CredentialResolver scope used for webhook secrets.
export const WEBHOOK_SECRET_SCOPE = "cd:source:nudge";
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;

export function webhookSecretRef(receiver: WebhookReceiver): string {
	return `webhook/${receiver}`;
}

export type NudgeRefusalStatus = 400 | 401 | 404 | 405 | 413;

export type Received = Readonly<{ receiver: WebhookReceiver; keys: readonly string[] }>;

export type ReceiveOutcome =
	| Readonly<{ ok: true; value: Received }>
	| Readonly<{ ok: false; status: NudgeRefusalStatus; reasons: readonly ReasonRecord[] }>;

function lower(headers: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
	return new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

/** Constant-time string equality (both sides hashed first, so lengths match). */
export function safeEqual(left: string, right: string): boolean {
	const a = createHash("sha256").update(left).digest();
	const b = createHash("sha256").update(right).digest();
	return timingSafeEqual(a, b) && left.length === right.length;
}

function hmacHex(secret: string, body: Uint8Array): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

function parsePath(path: string): Readonly<{ receiver?: WebhookReceiver; query: URLSearchParams }> {
	const [pathname = "", search = ""] = path.split("?", 2);
	const last = pathname.split("/").filter((part) => part !== "").at(-1) ?? "";
	const receiver = WEBHOOK_RECEIVERS.find((item) => item === last);
	return receiver ? { receiver, query: new URLSearchParams(search) } : { query: new URLSearchParams(search) };
}

type MutableSecret = { secret?: string; token?: string };
type Secret = Readonly<MutableSecret>;

async function secretFor(secrets: CredentialResolver, receiver: WebhookReceiver): Promise<Secret | undefined> {
	try {
		const value = await secrets.resolve(webhookSecretRef(receiver), WEBHOOK_SECRET_SCOPE);
		const out: MutableSecret = {};
		if (value.secret) out.secret = value.secret;
		if (value.token) out.token = value.token;
		return out.secret || out.token ? out : undefined;
	} catch {
		return undefined;
	}
}

function authenticate(
	receiver: WebhookReceiver,
	headers: ReadonlyMap<string, string>,
	query: URLSearchParams,
	body: Uint8Array,
	secret: Secret,
): boolean {
	const hmac = (value: string | undefined, prefix: string) =>
		secret.secret !== undefined && value !== undefined && safeEqual(value, `${prefix}${hmacHex(secret.secret, body)}`);
	const token = (value: string | undefined) => secret.token !== undefined && value !== undefined && safeEqual(value, secret.token);
	switch (receiver) {
		case "github":
		case "ghcr":
			return hmac(headers.get("x-hub-signature-256"), "sha256=");
		case "bitbucket":
			return hmac(headers.get("x-hub-signature"), "sha256=");
		case "gitea":
			return hmac(headers.get("x-gitea-signature"), "");
		case "forgejo":
			return hmac(headers.get("x-forgejo-signature") ?? headers.get("x-gitea-signature"), "");
		case "gitlab":
			return token(headers.get("x-gitlab-token"));
		case "harbor":
			return token(headers.get("authorization"));
		case "cloudevents":
		case "ecr":
			return token(headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
		case "dockerhub":
		case "artifact-registry":
			return token(query.get("token") ?? undefined);
		default:
			return false;
	}
}

function keys(...candidates: ReadonlyArray<string | undefined>): string[] {
	return candidates.filter((item): item is string => item !== undefined);
}

function githubKeys(payload: JsonValue, event: string): string[] {
	if (event === "package" || event === "registry_package") {
		const pkg = field(payload, event === "package" ? "package" : "registry_package");
		const type = (text(pkg, "package_type") ?? "").toLowerCase();
		const url = text(field(pkg, "package_version"), "package_url");
		if (type === "container" || type === "docker") return keys(url ? ociKey(url) : undefined);
		const name = text(pkg, "name");
		const namespace = text(field(pkg, "namespace") ?? field(payload, "repository"), "login") ?? text(field(payload, "organization"), "login");
		if (type === "npm" && name) return keys(purlKey(`pkg:npm/${namespace ? `%40${namespace}/` : ""}${name}`));
		return [];
	}
	const repository = field(payload, "repository");
	return keys(
		...[text(repository, "clone_url"), text(repository, "html_url")].map((url) => (url ? gitKey(url) : undefined)),
	);
}

function cloudEventKeys(payload: JsonValue | undefined, headers: ReadonlyMap<string, string>): string[] {
	const data = headers.has("ce-type") ? payload : field(payload, "data");
	const subject = field(data, "subject");
	const content = field(subject, "content");
	const strings = [
		headers.get("ce-subject") ?? text(payload, "subject"),
		text(subject, "id"),
		text(content, "url"),
		text(field(content, "repository"), "url"),
		text(field(data, "repository"), "url"),
	].filter((item): item is string => item !== undefined);
	return strings.flatMap((value) => {
		if (value.startsWith("pkg:")) return keys(purlKey(value));
		if (/^https?:\/\//.test(value)) return keys(gitKey(value));
		return keys(ociKey(value));
	});
}

function payloadKeys(
	receiver: WebhookReceiver,
	payload: JsonValue | undefined,
	headers: ReadonlyMap<string, string>,
): string[] {
	switch (receiver) {
		case "github":
		case "ghcr":
			return payload === undefined ? [] : githubKeys(payload, headers.get("x-github-event") ?? "");
		case "gitlab":
			return keys(gitKey(text(field(payload, "project"), "git_http_url") ?? text(field(payload, "repository"), "git_http_url") ?? ""));
		case "bitbucket":
			return keys(gitKey(text(field(field(field(payload, "repository"), "links"), "html"), "href") ?? ""));
		case "gitea":
		case "forgejo":
			return keys(gitKey(text(field(payload, "repository"), "clone_url") ?? ""));
		case "harbor":
			return list(field(payload, "event_data"), "resources").flatMap((item) => keys(ociKey(text(item, "resource_url") ?? "")));
		case "dockerhub": {
			const name = text(field(payload, "repository"), "repo_name");
			return name ? keys(ociKey(`docker.io/${name}`)) : [];
		}
		case "ecr": {
			const detail = field(payload, "detail");
			const repository = text(detail, "repository-name");
			const account = text(payload, "account");
			const region = text(payload, "region");
			return repository && account && region ? keys(ociKey(`${account}.dkr.ecr.${region}.amazonaws.com/${repository}`)) : [];
		}
		case "artifact-registry": {
			const encoded = text(field(payload, "message"), "data");
			const message = encoded ? parseJson(Buffer.from(encoded, "base64").toString("utf8")) : undefined;
			return keys(...[text(message, "digest"), text(message, "tag")].map((item) => (item ? ociKey(item) : undefined)));
		}
		case "cloudevents":
			return cloudEventKeys(payload, headers);
		default:
			return [];
	}
}

/** Authenticate one webhook and extract the repository keys it names. */
export async function receiveWebhook(
	request: FeedRequest,
	secrets: CredentialResolver,
): Promise<ReceiveOutcome> {
	const { receiver, query } = parsePath(request.path);
	if (!receiver) {
		return {
			ok: false,
			status: 404,
			reasons: refuse(SOURCE_REASON.invalid, `no webhook receiver at ${request.path.split("?")[0]}`, `post to .../nudge/<receiver>, one of ${WEBHOOK_RECEIVERS.join(", ")}`, "path").reasons,
		};
	}
	if (request.method.toUpperCase() !== "POST") {
		return { ok: false, status: 405, reasons: refuse(SOURCE_REASON.invalid, "webhooks are POST", "configure the sender to POST", receiver).reasons };
	}
	if (request.body.byteLength > WEBHOOK_MAX_BODY_BYTES) {
		return { ok: false, status: 413, reasons: refuse(SOURCE_REASON.invalid, "webhook body too large", "send event notifications, not artifacts", receiver).reasons };
	}
	const headers = lower(request.headers);
	const secret = await secretFor(secrets, receiver);
	if (!secret || !authenticate(receiver, headers, query, request.body, secret)) {
		return {
			ok: false,
			status: 401,
			reasons: refuse(
				SOURCE_REASON.unverifiedTrigger,
				`${receiver} webhook failed authentication; nothing was scheduled`,
				`configure the sender with the secret stored at ${webhookSecretRef(receiver)}`,
				receiver,
			).reasons,
		};
	}
	const payload = request.body.byteLength === 0 ? undefined : parseJson(utf8(request.body));
	if (request.body.byteLength > 0 && payload === undefined) {
		return { ok: false, status: 400, reasons: refuse(SOURCE_REASON.invalid, "webhook body is not JSON", "send JSON payloads", receiver).reasons };
	}
	const found = payloadKeys(receiver, payload, headers);
	return { ok: true, value: { receiver, keys: [...new Set(found)].sort() } };
}
