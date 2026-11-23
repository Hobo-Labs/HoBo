import {
	createDecipheriv,
	createHash,
	createHmac,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { fromJson, type JsonValue as ProtoJson } from "@bufbuild/protobuf";
import { loadCiProjectFromDirectory } from "@hobo/ci-gh-actions/cli-serve";
import { z } from "zod";

import {
	OwnerHandoffCollectedSchema,
	type OwnerHandoffEnvelope,
	OwnerHandoffSealedAnswerSchema,
} from "./_generated/owner_handoff_pb.js";

// public-contract: the relay page an owner opens for a one-time store hand-off.
export const OWNER_LINK_PAGE_PATH = "/owner-handoff";
// public-contract: the relay's mailbox routes for the one-time store hand-off.
export const OWNER_LINK_API_PATH = "/v1/owner-handoff/mailboxes";
export const OWNER_LINK_TTL_MS = 10 * 60_000;
const SEAL_INFO = "hobo owner-handoff seal v1";
const MAILBOX_INFO = "hobo owner-handoff mailbox v1";
const BIND_INFO = "hobo owner-handoff bind v1";
const REQUEST_TIMEOUT_MS = 10_000;

export type OwnerLinkUnavailableReason =
	| "owner-link-relay-unconfigured"
	| "owner-link-relay-unreachable"
	| "owner-link-relay-not-ready"
	| "owner-link-relay-refused";

export type OwnerLinkRefusedReason = "expired" | "used" | "unreadable";

export type OwnerLinkAnswer = Readonly<Record<string, string>>;

export type OwnerLinkOutcome =
	| Readonly<{ kind: "issued"; url: string; expiresAtMs: number }>
	| Readonly<{ kind: "waiting"; url: string; expiresAtMs: number }>
	| Readonly<{ kind: "answered"; answer: OwnerLinkAnswer }>
	| Readonly<{ kind: "refused"; reason: OwnerLinkRefusedReason }>
	| Readonly<{ kind: "unavailable"; reason: OwnerLinkUnavailableReason }>;

export interface OwnerLinkChannel {
	pending(cwd: string): boolean;
	issue(cwd: string): Promise<OwnerLinkOutcome>;
	collect(cwd: string, waitMs: number): Promise<OwnerLinkOutcome>;
	close(): void;
}

type Ticket = {
	readonly url: string;
	readonly origin: string;
	readonly mailboxId: string;
	readonly recipientKey: string;
	readonly binding: string;
	readonly expiresAtMs: number;
	readonly collectToken: string;
	privateKey: KeyObject | undefined;
};

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function derive(secret: Uint8Array, salt: Uint8Array, info: string): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, salt, info, 32));
}

function rawPublicKey(key: KeyObject): string {
	const jwk = key.export({ format: "jwk" });
	if (jwk.x === undefined || jwk.y === undefined)
		throw new Error("could not export the hand-off key");
	return b64u(
		Buffer.concat([
			Buffer.from([4]),
			Buffer.from(jwk.x, "base64url"),
			Buffer.from(jwk.y, "base64url"),
		]),
	);
}

function publicKeyFromRaw(raw: string): KeyObject {
	const bytes = Buffer.from(raw, "base64url");
	if (bytes.length !== 65 || bytes[0] !== 4)
		throw new Error("not an uncompressed P-256 key");
	return createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: b64u(bytes.subarray(1, 33)),
			y: b64u(bytes.subarray(33)),
		},
		format: "jwk",
	});
}

const B64U = /^[A-Za-z0-9_-]+$/u;
const KEY = /^B[A-P][A-Za-z0-9_-]{85}$/u;
const ANSWER_NAMES: ReadonlySet<string> = new Set([
	"store",
	"INFISICAL_PROJECT_ID",
	"OP_VAULT_ID",
	"OP_CONNECT_HOST",
	"BITWARDEN_SERVER_URL",
	"INFISICAL_CLI_SESSION",
	"ONEPASSWORD_EMAIL",
	"ONEPASSWORD_SECRET_KEY",
	"ONEPASSWORD_PASSWORD",
	"BW_CLIENTID",
	"BW_CLIENTSECRET",
]);
const MAX_ANSWER_VALUE = 16_384;

function parseEnvelope(json: ProtoJson): OwnerHandoffEnvelope | undefined {
	try {
		const envelope = fromJson(OwnerHandoffCollectedSchema, json).envelope;
		if (
			envelope === undefined ||
			!KEY.test(envelope.senderKey) ||
			!/^[A-Za-z0-9_-]{16}$/u.test(envelope.iv) ||
			!B64U.test(envelope.ciphertext) ||
			envelope.ciphertext.length < 22 ||
			envelope.ciphertext.length > 21_846
		)
			return undefined;
		return envelope;
	} catch {
		return undefined;
	}
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const JsonText = z.string().transform((text, context) => {
	try {
		return z.json().parse(JSON.parse(text));
	} catch {
		context.addIssue({ code: "custom", message: "not JSON" });
		return z.NEVER;
	}
});

export function openOwnerLinkEnvelope(
	ticket: Pick<Ticket, "mailboxId" | "recipientKey" | "binding" | "privateKey">,
	envelope: OwnerHandoffEnvelope,
): OwnerLinkAnswer | undefined {
	if (ticket.privateKey === undefined) return undefined;
	try {
		const shared = diffieHellman({
			privateKey: ticket.privateKey,
			publicKey: publicKeyFromRaw(envelope.senderKey),
		});
		const key = derive(
			shared,
			Buffer.from(ticket.mailboxId, "base64url"),
			`${SEAL_INFO}|${envelope.senderKey}|${ticket.recipientKey}`,
		);
		const sealed = Buffer.from(envelope.ciphertext, "base64url");
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			Buffer.from(envelope.iv, "base64url"),
			{ authTagLength: 16 },
		);
		decipher.setAAD(
			Buffer.from(`v1|${ticket.mailboxId}|${ticket.binding}`, "utf8"),
		);
		decipher.setAuthTag(sealed.subarray(sealed.length - 16));
		const plain = Buffer.concat([
			decipher.update(sealed.subarray(0, sealed.length - 16)),
			decipher.final(),
		]);
		const text = strictUtf8.decode(plain);
		plain.fill(0);
		key.fill(0);
		const json = JsonText.safeParse(text);
		if (!json.success) return undefined;
		const record = fromJson(OwnerHandoffSealedAnswerSchema, json.data);
		if (
			record.v !== 1 ||
			record.mailboxId !== ticket.mailboxId ||
			record.binding !== ticket.binding
		)
			return undefined;
		const entries = Object.entries(record.answer);
		if (
			entries.some(
				([name, value]) =>
					!ANSWER_NAMES.has(name) || value.length > MAX_ANSWER_VALUE,
			)
		)
			return undefined;
		return Object.freeze(Object.fromEntries(entries));
	} catch {
		return undefined;
	}
}

export function ownerLinkMailboxOf(ticket: string): string {
	return b64u(
		derive(Buffer.from(ticket, "base64url"), Buffer.alloc(0), MAILBOX_INFO),
	);
}

export function ownerLinkKeyProof(
	ticket: string,
	offer: Readonly<{
		mailboxId: string;
		recipientKey: string;
		binding: string;
		expiresAtMs: number;
	}>,
): string {
	return createHmac(
		"sha256",
		derive(Buffer.from(ticket, "base64url"), Buffer.alloc(0), BIND_INFO),
	)
		.update(
			`v1|${offer.mailboxId}|${offer.recipientKey}|${offer.binding}|${offer.expiresAtMs}`,
		)
		.digest("base64url");
}

function relayOriginOf(raw: string | undefined): string | undefined {
	const value = raw?.trim().replace(/\/+$/u, "") ?? "";
	return /^https:\/\/[^/?#\s@]+$/u.test(value) && URL.canParse(value)
		? new URL(value).origin
		: undefined;
}

const CI_PROJECT_PATH = ".hobo/ci.json";

export async function projectRelayOrigin(
	cwd: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
	const fromEnv = relayOriginOf(env.HOBO_CI_RELAY_URL);
	if (fromEnv !== undefined) return fromEnv;
	const configPath = env.HOBO_CI_PROJECT_CONFIG?.trim() || CI_PROJECT_PATH;
	let directory = path.resolve(cwd);
	for (;;) {
		const found = await stat(path.join(directory, configPath)).then(
			(entry) => entry.isFile(),
			() => false,
		);
		if (found) {
			const project = await loadCiProjectFromDirectory({
				repositoryRoot: directory,
				configPath,
				env: {
					HOBO_CI_ENVIRONMENT: env.HOBO_CI_ENVIRONMENT?.trim() || undefined,
				},
			}).catch(() => undefined);
			return relayOriginOf(project?.environment.relayOrigin);
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function createOwnerLinkChannel(
	options: {
		readonly relayOrigin?: (cwd: string) => Promise<string | undefined>;
		readonly fetch?: typeof fetch;
		readonly now?: () => number;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly ttlMs?: number;
		readonly pollMs?: number;
	} = {},
): OwnerLinkChannel {
	const relayOrigin = options.relayOrigin ?? ((cwd) => projectRelayOrigin(cwd));
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const ttlMs = options.ttlMs ?? OWNER_LINK_TTL_MS;
	const pollMs = options.pollMs ?? 2_000;
	const bindingSalt = randomBytes(32);
	const tickets = new Map<string, Ticket>();
	const keyOf = (cwd: string) => path.resolve(cwd);
	const drop = (cwd: string) => {
		const held = tickets.get(cwd);
		if (held !== undefined) held.privateKey = undefined;
		tickets.delete(cwd);
	};
	const call = async (url: string, init: RequestInit) => {
		try {
			return await send(url, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				redirect: "error",
			});
		} catch {
			return undefined;
		}
	};
	return {
		pending: (cwd) => tickets.has(keyOf(cwd)),
		async issue(rawCwd) {
			const cwd = keyOf(rawCwd);
			drop(cwd);
			const origin = await relayOrigin(cwd).catch(() => undefined);
			if (origin === undefined)
				return {
					kind: "unavailable",
					reason: "owner-link-relay-unconfigured",
				};
			const ticket = b64u(randomBytes(32));
			const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
			const mailboxId = ownerLinkMailboxOf(ticket);
			const recipientKey = rawPublicKey(pair.publicKey);
			const binding = createHmac("sha256", bindingSalt)
				.update(cwd)
				.digest("base64url");
			const expiresAtMs = Math.floor(now()) + ttlMs;
			const offer = { mailboxId, recipientKey, binding, expiresAtMs };
			const collectToken = b64u(randomBytes(32));
			const response = await call(`${origin}${OWNER_LINK_API_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					offer: { ...offer, keyProof: ownerLinkKeyProof(ticket, offer) },
					collectDigest: createHash("sha256")
						.update(collectToken)
						.digest("base64url"),
				}),
			});
			await response?.body?.cancel().catch(() => undefined);
			if (response === undefined)
				return { kind: "unavailable", reason: "owner-link-relay-unreachable" };
			if (response.status === 503)
				return { kind: "unavailable", reason: "owner-link-relay-not-ready" };
			if (response.status !== 201)
				return { kind: "unavailable", reason: "owner-link-relay-refused" };
			const url = `${origin}${OWNER_LINK_PAGE_PATH}#${ticket}`;
			tickets.set(cwd, {
				url,
				origin,
				mailboxId,
				recipientKey,
				binding,
				expiresAtMs,
				collectToken,
				privateKey: pair.privateKey,
			});
			return { kind: "issued", url, expiresAtMs };
		},
		async collect(rawCwd, waitMs) {
			const cwd = keyOf(rawCwd);
			const started = now();
			for (;;) {
				const held = tickets.get(cwd);
				if (held === undefined) return { kind: "refused", reason: "expired" };
				if (now() >= held.expiresAtMs) {
					drop(cwd);
					return { kind: "refused", reason: "expired" };
				}
				const response = await call(
					`${held.origin}${OWNER_LINK_API_PATH}/${held.mailboxId}/collect`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${held.collectToken}` },
					},
				);
				if (response === undefined)
					return {
						kind: "unavailable",
						reason: "owner-link-relay-unreachable",
					};
				if (response.status === 200) {
					const body = await response.text().catch(() => "");
					const json = JsonText.safeParse(body);
					const envelope = json.success ? parseEnvelope(json.data) : undefined;
					const answer =
						envelope === undefined
							? undefined
							: openOwnerLinkEnvelope(held, envelope);
					drop(cwd);
					return answer === undefined
						? { kind: "refused", reason: "unreadable" }
						: { kind: "answered", answer };
				}
				await response.body?.cancel().catch(() => undefined);
				if (response.status === 404) {
					drop(cwd);
					return { kind: "refused", reason: "expired" };
				}
				if (response.status === 410) {
					drop(cwd);
					return { kind: "refused", reason: "used" };
				}
				if (response.status === 503)
					return { kind: "unavailable", reason: "owner-link-relay-not-ready" };
				if (response.status !== 202)
					return { kind: "unavailable", reason: "owner-link-relay-refused" };
				if (now() - started + pollMs > waitMs)
					return {
						kind: "waiting",
						url: held.url,
						expiresAtMs: held.expiresAtMs,
					};
				await sleep(pollMs);
			}
		},
		close() {
			for (const cwd of tickets.keys()) drop(cwd);
		},
	};
}
