import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { parseGithubAppInstallationRef } from "@hobo/core";
import { z } from "zod";
import { createGithubInstallationAdminVerifier } from "./app-registration-http.js";
import type { ControlAuthenticator, ControlPrincipal } from "./control-auth.js";
import type { OnboardingGithubPort } from "./onboarding.js";
import {
	RELAY_OWNER_ACCOUNT_CREDENTIAL,
	RELAY_OWNER_ACCOUNT_CREDENTIAL_SECONDS,
	RELAY_OWNER_CREDENTIALS_PATH,
	RELAY_OWNER_DEVICE_PATH,
	RELAY_OWNER_INSTALLATION_TOKEN_SECONDS,
	RELAY_OWNER_SESSION_SECONDS,
	RELAY_OWNER_TOKEN_PATH,
	RelayOwnerCredentialRequestSchema,
	RelayOwnerCredentialSchema,
	RelayOwnerDeviceAuthorizationSchema,
	RelayOwnerLoginErrorSchema,
	type RelayOwnerRefusal,
	RelayOwnerSessionSchema,
	RelayOwnerTokenRequestSchema,
} from "./relay-owner-login-protocol.js";

export type RelayOwnerAccount = ControlPrincipal;

export type RelayOwnerLogin = Readonly<{
	handle(request: Request): Promise<Response | undefined>;
	authenticate: ControlAuthenticator;
}>;

const SEALING_INFO = "hobo-ci-owner-login/v1";
const MAX_BODY_BYTES = 4096;
const GITHUB_DEVICE_CODE = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const SEALED = /^[A-Za-z0-9_-]{40,1000}$/u;

type SealedKind = "device" | "session" | "control";

const DevicePayload = z
	.object({ g: z.string().min(1).max(512), e: z.number().int() })
	.strict();
const AccountPayload = z
	.object({
		a: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
		e: z.number().int(),
	})
	.strict();

const GithubDeviceCode = z.object({
	device_code: z.string().min(1).max(512),
	user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/u),
	verification_uri: z.literal("https://github.com/login/device"),
	expires_in: z.number().int().positive().max(1800),
	interval: z.number().int().min(1).max(60).optional(),
});
const GithubDeviceReply = z.object({
	error: z.string().max(100).optional(),
	access_token: z.string().min(1).max(4096).optional(),
	token_type: z.string().max(40).optional(),
	interval: z.number().int().min(1).max(120).optional(),
});
const RepositoryInstallation = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

function reply(status: number, body: JsonValue): Response {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

function refuse(
	status: number,
	error: RelayOwnerRefusal,
	interval?: number,
): Response {
	return reply(
		status,
		toJson(
			RelayOwnerLoginErrorSchema,
			create(
				RelayOwnerLoginErrorSchema,
				interval === undefined ? { error } : { error, interval },
			),
		),
	);
}

async function boundedJson(request: Request): Promise<JsonValue | undefined> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) return undefined;
	const text = await request.text().catch(() => "");
	if (text.length === 0 || text.length > MAX_BODY_BYTES) return undefined;
	try {
		return z.json().parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function bearer(header: string | null | undefined): string | undefined {
	const match = /^Bearer ([A-Za-z0-9_-]{40,1000})$/u.exec(header ?? "");
	return match?.[1];
}

export function createRelayOwnerLogin(options: {
	readonly publicOrigin: string;
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly sealingKey: Uint8Array;
	readonly github: OnboardingGithubPort;
	readonly installationToken: (installationId: number) => Promise<string>;
	readonly account: () => Promise<RelayOwnerAccount | undefined>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}): RelayOwnerLogin {
	const origin = new URL(options.publicOrigin).origin;
	if (options.sealingKey.byteLength < 32)
		throw new Error("owner login needs a 32-byte sealing key");
	if (!/^[A-Za-z0-9_.-]{1,200}$/u.test(options.clientId))
		throw new Error("invalid GitHub App client id");
	const key = Buffer.from(
		hkdfSync("sha256", options.sealingKey, Buffer.alloc(0), SEALING_INFO, 32),
	);
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;

	function seal(kind: SealedKind, payload: Record<string, string | number>) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from(kind));
		const body = Buffer.concat([
			cipher.update(JSON.stringify(payload), "utf8"),
			cipher.final(),
		]);
		return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
	}

	function unseal(kind: SealedKind, sealed: string): JsonValue | undefined {
		if (!SEALED.test(sealed)) return undefined;
		const raw = Buffer.from(sealed, "base64url");
		if (raw.byteLength < 29) return undefined;
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				key,
				raw.subarray(0, 12),
			);
			decipher.setAAD(Buffer.from(kind));
			decipher.setAuthTag(raw.subarray(raw.byteLength - 16));
			const plain = Buffer.concat([
				decipher.update(raw.subarray(12, raw.byteLength - 16)),
				decipher.final(),
			]).toString("utf8");
			return z.json().parse(JSON.parse(plain));
		} catch {
			return undefined;
		}
	}

	async function signedInAccount(
		kind: "session" | "control",
		token: string | undefined,
	): Promise<RelayOwnerAccount | undefined> {
		if (token === undefined) return undefined;
		const payload = AccountPayload.safeParse(unseal(kind, token));
		if (!payload.success || payload.data.e <= now()) return undefined;
		const account = await options.account();
		return account?.accountId === payload.data.a ? account : undefined;
	}

	async function github(url: string, body: URLSearchParams) {
		const response = await send(url, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		return {
			ok: response.ok,
			body: z.json().parse(await response.json()),
		};
	}

	async function dropUserToken(token: string) {
		if (options.clientSecret === undefined) return;
		const basic = Buffer.from(
			`${options.clientId}:${options.clientSecret}`,
		).toString("base64");
		await send(
			`https://api.github.com/applications/${encodeURIComponent(options.clientId)}/token`,
			{
				method: "DELETE",
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Basic ${basic}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ access_token: token }),
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			},
		).catch(() => undefined);
	}

	async function isOwner(account: RelayOwnerAccount, userToken: string) {
		const verify = createGithubInstallationAdminVerifier({
			github: options.github,
			getUserToken: async () => userToken,
			fetch: send,
		});
		for (const installationId of account.installationIds)
			if (
				await verify(
					{ accountId: account.accountId, subject: "owner-login" },
					installationId,
				)
			)
				return true;
		return false;
	}

	async function device(): Promise<Response> {
		const account = await options.account();
		if (account === undefined || account.installationIds.length === 0)
			return refuse(409, "not_configured");
		const started = await github(
			GITHUB_DEVICE_CODE,
			new URLSearchParams({ client_id: options.clientId }),
		).catch(() => undefined);
		const code = GithubDeviceCode.safeParse(started?.body);
		if (!started?.ok || !code.success) {
			const disabled = GithubDeviceReply.safeParse(started?.body);
			return disabled.success && disabled.data.error === "device_flow_disabled"
				? refuse(503, "device_flow_unavailable")
				: refuse(502, "github_refused");
		}
		return reply(
			200,
			toJson(
				RelayOwnerDeviceAuthorizationSchema,
				create(RelayOwnerDeviceAuthorizationSchema, {
					deviceCode: seal("device", {
						g: code.data.device_code,
						e: now() + code.data.expires_in * 1000,
					}),
					userCode: code.data.user_code,
					verificationUri: code.data.verification_uri,
					expiresIn: code.data.expires_in,
					interval: code.data.interval ?? 5,
				}),
			),
		);
	}

	async function token(request: Request): Promise<Response> {
		const body = await boundedJson(request);
		let deviceCode: string;
		try {
			deviceCode = fromJson(
				RelayOwnerTokenRequestSchema,
				body ?? null,
			).deviceCode;
		} catch {
			return refuse(400, "invalid_request");
		}
		const payload = DevicePayload.safeParse(unseal("device", deviceCode));
		if (!payload.success) return refuse(400, "invalid_request");
		if (payload.data.e <= now()) return refuse(400, "expired_token");
		const account = await options.account();
		if (account === undefined) return refuse(409, "not_configured");
		const polled = await github(
			GITHUB_ACCESS_TOKEN,
			new URLSearchParams({
				client_id: options.clientId,
				device_code: payload.data.g,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		).catch(() => undefined);
		const result = GithubDeviceReply.safeParse(polled?.body);
		if (polled === undefined || !result.success)
			return refuse(502, "github_refused");
		const userToken = result.data.access_token;
		if (
			polled.ok &&
			userToken !== undefined &&
			result.data.token_type?.toLowerCase() === "bearer"
		) {
			const owner = await isOwner(account, userToken);
			await dropUserToken(userToken);
			if (!owner) return refuse(403, "not_owner");
			return reply(
				200,
				toJson(
					RelayOwnerSessionSchema,
					create(RelayOwnerSessionSchema, {
						sessionToken: seal("session", {
							a: account.accountId,
							e: now() + RELAY_OWNER_SESSION_SECONDS * 1000,
						}),
						expiresIn: RELAY_OWNER_SESSION_SECONDS,
					}),
				),
			);
		}
		switch (result.data.error) {
			case "authorization_pending":
				return refuse(400, "authorization_pending");
			case "slow_down":
				return refuse(400, "slow_down", result.data.interval ?? 10);
			case "access_denied":
				return refuse(400, "access_denied");
			case "expired_token":
				return refuse(400, "expired_token");
			case "device_flow_disabled":
				return refuse(503, "device_flow_unavailable");
			default:
				return refuse(502, "github_refused");
		}
	}

	async function installationToken(
		account: RelayOwnerAccount,
		ref: string,
	): Promise<Response> {
		const repository = parseGithubAppInstallationRef(ref);
		if (repository === undefined) return refuse(400, "invalid_request");
		const found = await options.github
			.appRequest(
				`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/installation`,
			)
			.catch(() => undefined);
		if (found === undefined || found.status >= 500)
			return refuse(502, "github_refused");
		if (found.status === 404) return refuse(403, "not_bound");
		const installation = found.ok
			? RepositoryInstallation.safeParse(await found.json().catch(() => null))
			: undefined;
		if (installation === undefined || !installation.success)
			return refuse(502, "github_refused");
		if (!account.installationIds.includes(installation.data.id))
			return refuse(403, "not_bound");
		const minted = await options
			.installationToken(installation.data.id)
			.catch(() => undefined);
		if (minted === undefined) return refuse(502, "github_refused");
		return reply(
			200,
			toJson(
				RelayOwnerCredentialSchema,
				create(RelayOwnerCredentialSchema, {
					token: minted,
					expiresIn: RELAY_OWNER_INSTALLATION_TOKEN_SECONDS,
				}),
			),
		);
	}

	async function credentials(request: Request): Promise<Response> {
		const account = await signedInAccount(
			"session",
			bearer(request.headers.get("authorization")),
		);
		if (account === undefined) return refuse(401, "session_required");
		const body = await boundedJson(request);
		let ref: string;
		try {
			ref = fromJson(RelayOwnerCredentialRequestSchema, body ?? null).ref;
		} catch {
			return refuse(400, "invalid_request");
		}
		if (ref === RELAY_OWNER_ACCOUNT_CREDENTIAL)
			return reply(
				200,
				toJson(
					RelayOwnerCredentialSchema,
					create(RelayOwnerCredentialSchema, {
						token: seal("control", {
							a: account.accountId,
							e: now() + RELAY_OWNER_ACCOUNT_CREDENTIAL_SECONDS * 1000,
						}),
						expiresIn: RELAY_OWNER_ACCOUNT_CREDENTIAL_SECONDS,
					}),
				),
			);
		if (parseGithubAppInstallationRef(ref) !== undefined)
			return installationToken(account, ref);
		return refuse(404, "not_resolvable");
	}

	return Object.freeze({
		async handle(request: Request): Promise<Response | undefined> {
			const url = new URL(request.url);
			const route =
				url.pathname === RELAY_OWNER_DEVICE_PATH
					? device
					: url.pathname === RELAY_OWNER_TOKEN_PATH
						? token
						: url.pathname === RELAY_OWNER_CREDENTIALS_PATH
							? credentials
							: undefined;
			if (route === undefined) return undefined;
			const browser = request.headers.get("origin");
			if (request.method !== "POST" || (browser !== null && browser !== origin))
				return refuse(request.method === "POST" ? 403 : 405, "invalid_request");
			try {
				return await route(request);
			} catch {
				return refuse(502, "github_refused");
			}
		},
		async authenticate(header) {
			return signedInAccount("control", bearer(header));
		},
	});
}
