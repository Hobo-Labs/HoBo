/**
 * The HTTP client of the config-service Worker, for its three callers: the
 * relay's loader (reads `relay` with its Vercel OIDC token), HoBo's
 * provisioning (seeds once with the bootstrap credential, checks health) and
 * the deploy workflow or `hobo ci app create` in it (reads `deploy`, writes
 * `relay` with GitHub Actions OIDC). The owner's Access token, after the
 * claim, is the fourth credential.
 *
 * Responses cross the generated protobuf parsers (`fromJson`); an error is
 * a `ConfigServiceClientError` naming the Worker's code, never a body, a
 * token or a value.
 */
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	type ConfigAuditEntry,
	ConfigAuditLogSchema,
	ConfigFolderReadSchema,
	type ConfigFolderWritten,
	ConfigFolderWrittenSchema,
	ConfigServiceErrorSchema,
	ConfigServiceHealthSchema,
	ConfigServiceSeededSchema,
} from "./_generated/config_service_worker_pb.js";
import { ERROR_CODES, type ErrorCode } from "./worker/http.js";
import { BOOTSTRAP_SCHEME, CONFIG_SERVICE_NAME } from "./worker/handler.js";
import type { Folder } from "./worker/records.js";

export type ConfigServiceClientErrorCode =
	| ErrorCode
	| "UNAVAILABLE"
	| "INVALID_RESPONSE"
	| "INVALID_ORIGIN";

export class ConfigServiceClientError extends Error {
	readonly code: ConfigServiceClientErrorCode;
	readonly status: number;
	constructor(
		code: ConfigServiceClientErrorCode,
		status: number,
		message: string,
	) {
		super(message);
		this.name = "ConfigServiceClientError";
		this.code = code;
		this.status = status;
	}
}

/** Where a credential comes from; called per request, never cached here. */
export type TokenSource = () => Promise<string>;

/**
 * How a caller signs in. `oidc`: a Vercel or GitHub Actions token as a
 * bearer. `owner-access`: the owner's Cloudflare Access token
 * (`cloudflared access token -app=<origin>`), which Access exchanges at its
 * edge for the assertion the Worker verifies.
 */
export type ConfigServiceCredential = Readonly<
	| { kind: "oidc"; token: TokenSource }
	| { kind: "owner-access"; token: TokenSource }
>;

export type ConfigServiceClient = Readonly<{
	origin: string;
	health(nonce: string): Promise<Readonly<{ storeId: string; nonce: string }>>;
	seed(
		credential: string,
		folders: Readonly<Record<Folder, Readonly<Record<string, string>>>>,
	): Promise<readonly ConfigFolderWritten[]>;
	read(
		folder: Folder,
		credential: ConfigServiceCredential,
	): Promise<
		Readonly<{ entries: Readonly<Record<string, string>>; version: number }>
	>;
	write(
		folder: Folder,
		credential: ConfigServiceCredential,
		change: Readonly<{
			entries?: Readonly<Record<string, string>>;
			delete?: readonly string[];
		}>,
	): Promise<ConfigFolderWritten>;
	audit(
		credential: ConfigServiceCredential,
	): Promise<readonly ConfigAuditEntry[]>;
}>;

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+$/u;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/u;
const RESPONSE_BYTES = 262_144;
const TIMEOUT_MS = 15_000;

/** The Worker's origin, checked: HTTPS, no path, no userinfo. */
export function parseConfigServiceOrigin(
	origin: string,
	options: Readonly<{ allowLoopback?: boolean }> = {},
): string {
	const trimmed = origin.replace(/\/+$/u, "");
	if (
		ORIGIN.test(trimmed) ||
		(options.allowLoopback === true && LOOPBACK.test(trimmed))
	)
		return trimmed;
	throw new ConfigServiceClientError(
		"INVALID_ORIGIN",
		0,
		"the config service's origin must be https://<host> with no path or userinfo",
	);
}

async function headersFor(
	credential: ConfigServiceCredential,
): Promise<Record<string, string>> {
	const token = await credential.token();
	return credential.kind === "oidc"
		? { authorization: `Bearer ${token}` }
		: { "cf-access-token": token };
}

export function createConfigServiceClient(
	options: Readonly<{
		origin: string;
		fetch?: typeof fetch;
		allowLoopback?: boolean;
	}>,
): ConfigServiceClient {
	const origin = parseConfigServiceOrigin(options.origin, options);
	const send = options.fetch ?? fetch;

	async function call(
		path: string,
		method: "GET" | "POST" | "PATCH",
		headers: Readonly<Record<string, string>>,
		body?: JsonValue,
	): Promise<JsonValue> {
		let response: Response;
		try {
			response = await send(`${origin}${path}`, {
				method,
				headers: {
					accept: "application/json",
					...(body !== undefined
						? { "content-type": "application/json" }
						: undefined),
					...headers,
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : undefined),
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			throw new ConfigServiceClientError(
				"UNAVAILABLE",
				0,
				`the config service did not answer ${method} ${path}`,
			);
		}
		const text = await response.text();
		let value: JsonValue = null;
		try {
			// SAFETY: JSON.parse yields a JSON value at this response boundary.
			value =
				text.length <= RESPONSE_BYTES ? (JSON.parse(text) as JsonValue) : null;
		} catch {
			value = null;
		}
		if (response.ok && value !== null) return value;
		let code: ConfigServiceClientErrorCode = response.ok
			? "INVALID_RESPONSE"
			: "UNAVAILABLE";
		try {
			const envelope = fromJson(ConfigServiceErrorSchema, value);
			code = ERROR_CODES.find((known) => known === envelope.code) ?? code;
		} catch {
			// Not an envelope: keep the transport's code.
		}
		throw new ConfigServiceClientError(
			code,
			response.status,
			`the config service refused ${method} ${path}: ${code} (HTTP ${response.status})`,
		);
	}

	function parse<T>(run: () => T, path: string): T {
		try {
			return run();
		} catch {
			throw new ConfigServiceClientError(
				"INVALID_RESPONSE",
				200,
				`the config service's answer to ${path} is not the record it should be`,
			);
		}
	}

	return Object.freeze({
		origin,
		async health(nonce) {
			const path = `/v1/health?nonce=${encodeURIComponent(nonce)}`;
			const value = await call(path, "GET", {});
			const answer = parse(
				() => fromJson(ConfigServiceHealthSchema, value),
				path,
			);
			if (answer.service !== CONFIG_SERVICE_NAME || answer.nonce !== nonce)
				throw new ConfigServiceClientError(
					"INVALID_RESPONSE",
					200,
					"the config service's health answer is not this nonce's",
				);
			return Object.freeze({ storeId: answer.storeId, nonce: answer.nonce });
		},
		async seed(credential, folders) {
			const body = {
				folders: {
					relay: { entries: { ...folders.relay } },
					deploy: { entries: { ...folders.deploy } },
				},
			};
			const value = await call(
				"/v1/seed",
				"POST",
				{ authorization: `${BOOTSTRAP_SCHEME} ${credential}` },
				body,
			);
			return parse(
				() => fromJson(ConfigServiceSeededSchema, value).folders,
				"/v1/seed",
			);
		},
		async read(folder, credential) {
			const path = `/v1/folders/${folder}`;
			const value = await call(path, "GET", await headersFor(credential));
			const read = parse(() => fromJson(ConfigFolderReadSchema, value), path);
			if (read.folder !== folder)
				throw new ConfigServiceClientError(
					"INVALID_RESPONSE",
					200,
					`the config service answered ${path} with another folder`,
				);
			return Object.freeze({
				entries: Object.freeze({ ...read.entries }),
				version: read.version,
			});
		},
		async write(folder, credential, change) {
			const path = `/v1/folders/${folder}`;
			const value = await call(path, "PATCH", await headersFor(credential), {
				entries: { ...change.entries },
				delete: [...(change.delete ?? [])],
			});
			return parse(() => fromJson(ConfigFolderWrittenSchema, value), path);
		},
		async audit(credential) {
			const value = await call(
				"/v1/audit",
				"GET",
				await headersFor(credential),
			);
			return parse(
				() => fromJson(ConfigAuditLogSchema, value).entries,
				"/v1/audit",
			);
		},
	});
}
