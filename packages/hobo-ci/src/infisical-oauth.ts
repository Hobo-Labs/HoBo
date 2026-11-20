import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseInfisicalBinding } from "@hobo/adapter-infisical";
import type { SecretsPort } from "@hobo/identity";
import { z } from "zod";

/**
 * Sign the owner in to Infisical with one of the organization's OAuth
 * applications: the authorization code grant (RFC 6749) with PKCE (S256).
 * The owner approves in their browser; nobody copies a token.
 *
 * Infisical documents it at
 * https://infisical.com/docs/documentation/platform/oauth-applications/authorization-code:
 * `GET /api/v1/oauth/authorize`, `POST /api/v1/oauth/token` (client id and
 * secret by HTTP Basic), redirect URIs matched exactly (`http` only on
 * loopback), and one scope, `secrets:read`. Its tokens read secrets
 * (`GET /api/v4/secrets`) and nothing else, so the store this opens is
 * read-only: a write refuses with `InfisicalReadOnlyError`, naming the
 * sign-ins that can write.
 *
 * The redirect returns to this machine (`127.0.0.1`), so it is for an owner
 * at their own terminal. A handed-off run never starts it.
 */

// public-contract: the loopback redirect URI an owner registers on the Infisical OAuth application.
export const INFISICAL_OAUTH_REDIRECT_URI =
	"http://127.0.0.1:8793/infisical/callback";
// public-contract: the only scope Infisical's authorization code grant offers.
export const INFISICAL_OAUTH_SCOPE = "secrets:read";
// public-contract: Infisical's guide to the OAuth application a local read-only sign-in uses.
export const INFISICAL_OAUTH_DOCS =
	"https://infisical.com/docs/documentation/platform/oauth-applications/authorization-code";
// public-contract: the INFISICAL_SIGN_IN value for the OAuth application sign-in.
export const OAUTH_SIGN_IN = "oauth";

const TokenReply = z.object({
	access_token: z.string().min(1).max(16_384),
	token_type: z.string().optional(),
});

export class InfisicalOAuthError extends Error {
	readonly code:
		| "HOBO_INFISICAL_OAUTH_DENIED"
		| "HOBO_INFISICAL_OAUTH_TIMEOUT"
		| "HOBO_INFISICAL_OAUTH_FAILED";
	constructor(code: InfisicalOAuthError["code"], message: string) {
		super(message);
		this.name = "InfisicalOAuthError";
		this.code = code;
	}
}

export class InfisicalReadOnlyError extends Error {
	readonly code = "HOBO_INFISICAL_READ_ONLY";
	constructor() {
		super(
			"This run signed in to Infisical with an OAuth application, whose tokens only read secrets. Writing needs a Token Auth access token (a terminal run's setup page, or an agent's egress proxy) or CI's OIDC identity.",
		);
		this.name = "InfisicalReadOnlyError";
	}
}

export interface InfisicalOAuthOptions {
	readonly siteUrl: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri?: string;
	/** Show the owner the approval page; the URL carries no secret. */
	readonly openBrowser: (url: string) => void;
	readonly emit: (line: string) => void;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}

function base64url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

/** Wait for the owner's approval and exchange its code; the token is never printed. */
export async function infisicalOAuthToken(
	options: InfisicalOAuthOptions,
): Promise<string> {
	let site: string;
	try {
		site = parseInfisicalBinding({
			siteUrl: options.siteUrl,
			projectId: "oauth",
			environment: "prod",
			secretPath: "/",
		}).siteUrl;
	} catch {
		throw new InfisicalOAuthError(
			"HOBO_INFISICAL_OAUTH_FAILED",
			"The Infisical site must be an HTTPS origin, or an HTTP loopback origin.",
		);
	}
	const redirect = new URL(options.redirectUri ?? INFISICAL_OAUTH_REDIRECT_URI);
	if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1")
		throw new InfisicalOAuthError(
			"HOBO_INFISICAL_OAUTH_FAILED",
			"The OAuth redirect must be a 127.0.0.1 loopback URL with a port.",
		);
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const state = base64url(randomBytes(24));

	let settle: (result: { code?: string; error?: string }) => void = () =>
		undefined;
	const answered = new Promise<{ code?: string; error?: string }>((resolve) => {
		settle = resolve;
	});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", redirect.origin);
		if (req.method !== "GET" || url.pathname !== redirect.pathname) {
			res.writeHead(404).end();
			return;
		}
		if (url.searchParams.get("state") !== state) {
			res
				.writeHead(400, { "content-type": "text/plain" })
				.end("Invalid state.");
			return;
		}
		const code = url.searchParams.get("code") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;
		res
			.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			})
			.end(
				code !== undefined
					? "Signed in to Infisical. You can close this tab."
					: "Infisical sign-in was not approved.",
			);
		settle({
			...(code !== undefined ? { code } : undefined),
			...(error !== undefined ? { error } : undefined),
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(redirect.port), "127.0.0.1", () => resolve());
	});
	// SAFETY: listen() on a TCP host and port reports an AddressInfo.
	const port = (server.address() as AddressInfo).port;
	const redirectUri = `http://127.0.0.1:${port}${redirect.pathname}`;
	const timer = setTimeout(
		() => settle({ error: "timeout" }),
		options.timeoutMs ?? 10 * 60_000,
	);
	try {
		const authorize = new URL("/api/v1/oauth/authorize", site);
		authorize.search = new URLSearchParams({
			response_type: "code",
			client_id: options.clientId,
			redirect_uri: redirectUri,
			scope: INFISICAL_OAUTH_SCOPE,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		options.emit(
			`Approve HoBo's read access to Infisical in your browser: ${authorize.href}`,
		);
		options.openBrowser(authorize.href);

		const result = await answered;
		if (result.error === "timeout")
			throw new InfisicalOAuthError(
				"HOBO_INFISICAL_OAUTH_TIMEOUT",
				"The Infisical sign-in was not approved in time.",
			);
		if (result.code === undefined)
			throw new InfisicalOAuthError(
				"HOBO_INFISICAL_OAUTH_DENIED",
				"The Infisical sign-in was declined.",
			);

		const http = options.fetch ?? fetch;
		const reply = await http(new URL("/api/v1/oauth/token", site), {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Basic ${Buffer.from(
					`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
				).toString("base64")}`,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: result.code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}),
		}).catch(() => undefined);
		const parsed = TokenReply.safeParse(
			reply?.ok ? await reply.json().catch(() => null) : null,
		);
		if (!parsed.success)
			throw new InfisicalOAuthError(
				"HOBO_INFISICAL_OAUTH_FAILED",
				"Infisical did not exchange the sign-in code; check the application's client id, secret and redirect URI.",
			);
		return parsed.data.access_token;
	} finally {
		clearTimeout(timer);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** The store as an OAuth sign-in may use it: reads pass, every write refuses. */
export function readOnlySecretsPort(port: SecretsPort): SecretsPort {
	const refuse = async (): Promise<never> => {
		throw new InfisicalReadOnlyError();
	};
	return {
		id: port.id,
		kind: port.kind,
		access: (name) => port.access(name),
		accessVersion: (name, versionId) => port.accessVersion(name, versionId),
		listVersions: (name) => port.listVersions(name),
		put: refuse,
		// No createOnly: a read-only store offers no atomic create to claim with.
	};
}
