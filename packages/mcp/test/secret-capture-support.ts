import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { inspect } from "node:util";
import { createMemorySecretsPort } from "@hobo/identity";
import { vi } from "vitest";
import {
	type CapturePublicKey,
	SECRET_CAPTURE_SEAL_SOURCE,
	type SecretCaptureEvent,
	type SecretCaptureOutcome,
	type SecretStoreConnector,
	SecretStoreConnectorError,
	secretCaptureSpec,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

/** The form's own sealing function, run from the exact source the page embeds. */
type Seal = (
	subtle: SubtleCrypto,
	key: CapturePublicKey,
	value: string,
	ticketId: string,
	aad: string,
) => Promise<{ epk: CapturePublicKey; iv: string; ciphertext: string }>;

// SAFETY: the shipped page source defines exactly this function signature.
const hoboSeal = new Function(
	`return (${SECRET_CAPTURE_SEAL_SOURCE})`,
)() as Seal;

export async function sealAsTheFormDoes(
	ticket: { ticketId: string; name: string; key: CapturePublicKey },
	value: string,
): Promise<JsonValue> {
	const sealed = await hoboSeal(
		globalThis.crypto.subtle,
		ticket.key,
		value,
		ticket.ticketId,
		`${ticket.ticketId}:${ticket.name}`,
	);
	return { ticketId: ticket.ticketId, ...sealed };
}

/** Synthetic values: random, so a leak cannot match by coincidence. */
export function synthetic(prefix: string, bytes = 24): string {
	return `${prefix}-${randomBytes(bytes).toString("hex")}`;
}

export const SPECS = [
	secretCaptureSpec({
		name: "HOBO_CI_WEBHOOK_SECRET",
		target: "runtime",
		label: "GitHub App webhook secret",
		purpose: "GitHub signs every webhook delivery to the relay with it.",
		minBytes: 32,
		maxBytes: 1024,
		charset: "printable-line",
	}),
	secretCaptureSpec({
		name: "HOBO_CI_GITHUB_APP_PRIVATE_KEY",
		target: "runtime",
		label: "GitHub App private key (PEM)",
		purpose: "The relay signs installation-token requests with it.",
		minBytes: 64,
		maxBytes: 32_768,
		charset: "printable-multiline",
		pattern:
			"^-----BEGIN (RSA )?PRIVATE KEY-----[\\s\\S]+-----END (RSA )?PRIVATE KEY-----\\r?\\n?$",
	}),
	secretCaptureSpec({
		name: "VERCEL_TOKEN",
		target: "deploy",
		label: "Vercel deploy token",
		purpose:
			"The deploy workflow deploys the relay to the hobo-ci project with it.",
		minBytes: 8,
		maxBytes: 4096,
		charset: "printable-line",
	}),
	secretCaptureSpec({
		name: "INFISICAL_WRITER_CLIENT_SECRET",
		target: "writer",
		label: "One-use client secret of hobo-secret-writer",
		purpose: "Authorizes this session to write captured secrets, once.",
		minBytes: 16,
		maxBytes: 512,
		charset: "printable-line",
	}),
];

export const WRITER_SECRET = synthetic("writer-one-use", 16);

/** A memory store behind the connector port, with a writer session. */
export function memoryConnector(
	options: { connected?: boolean; writable?: boolean; failStore?: string } = {},
) {
	const runtime = createMemorySecretsPort({ id: "secrets:runtime" });
	const deploy = createMemorySecretsPort({ id: "secrets:deploy" });
	let writable = options.writable ?? true;
	const ended: string[] = [];
	const connector: SecretStoreConnector = {
		async status() {
			if (options.connected === false)
				return {
					connected: false,
					reason: "deploy/secret-store.binding.json is missing",
					nextStep:
						"Connect Infisical with OIDC Auth (the hobo-deploy skill walks through it), then capture again.",
				};
			return {
				connected: true,
				storeRef: "secref://memory",
				writable,
				writerSpec: "INFISICAL_WRITER_CLIENT_SECRET",
			};
		},
		async authorizeWriter({ clientId, secret }) {
			if (secret.reveal() !== WRITER_SECRET)
				throw new SecretStoreConnectorError("login-denied");
			writable = true;
			return {
				ref: `hobo-writer-session://${clientId}`,
				expiresAt: "2026-11-12T10:10:00.000Z",
			};
		},
		async store(target, secret) {
			if (options.failStore !== undefined)
				throw new SecretStoreConnectorError(options.failStore);
			const port = target === "deploy" ? deploy : runtime;
			await port.put(secret.name, secret.reveal());
			return { ref: `secref://${target}/${secret.name}` };
		},
		async endWriterSession() {
			ended.push("ended");
			const was = writable;
			writable = false;
			return was ? "ended" : "none";
		},
	};
	return { connector, runtime, deploy, ended };
}

/** Everything that left the app toward a host, a log or an audit sink. */
export function leakWatch() {
	const seen: string[] = [];
	const spies = (["log", "info", "warn", "error", "debug"] as const).map(
		(method) =>
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				seen.push(args.map((arg) => inspect(arg, { depth: 8 })).join(" "));
			}),
	);
	const out = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			seen.push(String(chunk));
			return true;
		});
	const err = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			seen.push(String(chunk));
			return true;
		});
	return {
		record(value: JsonValue | readonly SecretCaptureEvent[]) {
			seen.push(JSON.stringify(value));
		},
		outcome(outcome: SecretCaptureOutcome) {
			seen.push(JSON.stringify(outcome));
			return outcome;
		},
		/** Every forms a value could take in a leak: raw, JSON-escaped, base64. */
		assertNever(...values: string[]) {
			const haystack = seen.join("\n");
			for (const value of values)
				for (const form of [
					value,
					JSON.stringify(value).slice(1, -1),
					Buffer.from(value).toString("base64"),
					Buffer.from(value).toString("base64url"),
					value.slice(4, 20),
				])
					if (haystack.includes(form))
						throw new Error("a captured value reached an output");
			return seen.length;
		},
		restore() {
			for (const spy of spies) spy.mockRestore();
			out.mockRestore();
			err.mockRestore();
		},
	};
}

export type HttpAnswer = {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
};

/** A raw HTTP request, so tests can set Host and Origin as an attacker would. */
export function http(
	url: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	} = {},
): Promise<HttpAnswer> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: target.hostname,
				port: target.port,
				path: target.pathname + target.search,
				method: options.method ?? "GET",
				headers: options.headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

/** A synthetic PEM-shaped value (not a real key). */
export function syntheticPem(): string {
	const body = randomBytes(900)
		.toString("base64")
		.replace(/(.{64})/gu, "$1\n");
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}
