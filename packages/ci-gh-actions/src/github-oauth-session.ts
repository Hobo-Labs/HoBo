import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ControlAuthenticator } from "./control-auth.js";
import {
	appInstallationPage,
	appOwnerInstallationPage,
} from "./onboarding-pages.js";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const Account = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const GithubUser = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const OAuthToken = z.object({
	access_token: z.string().min(1).max(4096),
	token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});
export type GithubSessionActor = { accountId: string; subject: string };
export interface GithubOAuthSessionStore {
	issueState(
		digest: string,
		browserDigest: string,
		accountId: string,
		verifier: string,
		controlToken: string,
		expiresAt: number,
	): Promise<void>;
	consumeState(
		digest: string,
		browserDigest: string,
		now: number,
	): Promise<
		{ accountId: string; verifier: string; controlToken: string } | undefined
	>;
	issueSession(
		digest: string,
		accountId: string,
		githubId: number,
		githubToken: string,
		controlToken: string,
		expiresAt: number,
	): Promise<void>;
	session(
		digest: string,
		now: number,
	): Promise<
		| {
				accountId: string;
				githubId: number;
				githubToken: string;
				controlToken: string;
		  }
		| undefined
	>;
}
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
function cookie(request: Request, name: string): string | undefined {
	const values = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith(`${name}=`))
		.map((entry) => entry.slice(name.length + 1));
	return values.length === 1 && TOKEN.test(values[0] ?? "")
		? values[0]
		: undefined;
}
function headers(): Headers {
	return new Headers({
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
}
function response(status: number, value: { error: string }): Response {
	return Response.json(value, { status, headers: headers() });
}

/** GitHub OAuth sessions bind an existing scoped HoBo credential to a verified GitHub user. */
export function createGithubOAuthSession(options: {
	publicOrigin: string;
	clientId: string;
	clientSecret: string;
	store: GithubOAuthSessionStore;
	authenticateControl: ControlAuthenticator;
	/** Resolve an already verified, server-side bootstrap session to its scoped
	 * control token. The token never enters the page or browser storage. */
	trustedBootstrapControl?: (request: Request) => Promise<string | undefined>;
	fetch?: typeof fetch;
	now?: () => number;
}) {
	const origin = new URL(options.publicOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		origin.username ||
		origin.password
	)
		throw new Error("public origin must be HTTPS");
	if (
		!/^[A-Za-z0-9_.-]{1,200}$/.test(options.clientId) ||
		options.clientSecret.length < 1 ||
		options.clientSecret.length > 4096
	)
		throw new Error("invalid GitHub OAuth client");
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const redirectUri = `${origin.origin}/v1/app-registration/oauth/callback`;
	async function control(token: string, accountId?: string) {
		const principal = await options.authenticateControl(`Bearer ${token}`);
		return principal?.scopes.includes("repositories:write") &&
			(accountId === undefined || principal.accountId === accountId)
			? principal
			: undefined;
	}
	async function session(request: Request) {
		const raw = cookie(request, "__Host-hobo_ci_session");
		if (!raw) return undefined;
		const key = digest(raw);
		const record = await options.store.session(key, now());
		if (!record || !(await control(record.controlToken, record.accountId)))
			return undefined;
		return {
			...record,
			digest: key,
			actor: {
				accountId: record.accountId,
				subject: `github:${record.githubId}:${key}`,
			},
		};
	}
	return {
		async authenticate(
			request: Request,
		): Promise<GithubSessionActor | undefined> {
			return (await session(request))?.actor;
		},
		async githubToken(actor: GithubSessionActor): Promise<string | undefined> {
			const match = /^github:([1-9]\d{0,15}):([a-f0-9]{64})$/.exec(
				actor.subject,
			);
			if (!match) return undefined;
			const record = await options.store.session(match[2] ?? "", now());
			if (
				!record ||
				record.accountId !== actor.accountId ||
				record.githubId !== Number(match[1]) ||
				!(await control(record.controlToken, record.accountId))
			)
				return undefined;
			return record.githubToken;
		},
		async handle(request: Request): Promise<Response | undefined> {
			const url = new URL(request.url);
			if (
				url.pathname === "/v1/app-registration/setup" &&
				request.method === "GET" &&
				url.origin === origin.origin
			) {
				try {
					const token = await options.trustedBootstrapControl?.(request);
					if (token && /^\S{32,1024}$/.test(token) && (await control(token)))
						return appOwnerInstallationPage();
					return appInstallationPage();
				} catch {
					return response(503, { error: "GitHub authorization unavailable" });
				}
			}
			if (
				url.pathname !== "/v1/app-registration/oauth/start" &&
				url.pathname !== "/v1/app-registration/oauth/callback"
			)
				return undefined;
			if (url.origin !== origin.origin)
				return response(400, { error: "invalid origin" });
			try {
				if (url.pathname.endsWith("/start") && request.method === "POST") {
					const suppliedOrigin = request.headers.get("origin");
					if (suppliedOrigin && suppliedOrigin !== origin.origin)
						return response(403, { error: "origin rejected" });
					const auth = request.headers.get("authorization");
					let token: string | undefined;
					if (auth !== null) {
						if (!/^Bearer \S{32,1024}$/.test(auth))
							return response(401, {
								error: "account authentication required",
							});
						token = auth.slice(7);
					} else if (
						suppliedOrigin === origin.origin &&
						options.trustedBootstrapControl
					) {
						token = await options.trustedBootstrapControl(request);
					}
					if (!token || !/^\S{32,1024}$/.test(token))
						return response(401, { error: "account authentication required" });
					const principal = await control(token);
					if (!principal)
						return response(403, { error: "repository scope required" });
					const state = randomToken(),
						browser = randomToken(),
						verifier = randomToken();
					await options.store.issueState(
						digest(state),
						digest(browser),
						Account.parse(principal.accountId),
						verifier,
						token,
						now() + 10 * 60_000,
					);
					const target = new URL("https://github.com/login/oauth/authorize");
					target.searchParams.set("client_id", options.clientId);
					target.searchParams.set("redirect_uri", redirectUri);
					target.searchParams.set("state", state);
					target.searchParams.set(
						"code_challenge",
						createHash("sha256").update(verifier).digest("base64url"),
					);
					target.searchParams.set("code_challenge_method", "S256");
					const out = headers();
					out.append(
						"set-cookie",
						`__Host-hobo_ci_oauth=${browser}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
					);
					return Response.json(
						{ authorizeUrl: target.href },
						{ status: 200, headers: out },
					);
				}
				if (url.pathname.endsWith("/callback") && request.method === "GET") {
					const state = url.searchParams.get("state") ?? "",
						code = url.searchParams.get("code") ?? "";
					const browser = cookie(request, "__Host-hobo_ci_oauth");
					if (
						url.searchParams.getAll("state").length !== 1 ||
						url.searchParams.getAll("code").length !== 1 ||
						!TOKEN.test(state) ||
						!/^[A-Za-z0-9_-]{1,200}$/.test(code) ||
						!browser
					)
						return response(400, { error: "invalid OAuth callback" });
					const pending = await options.store.consumeState(
						digest(state),
						digest(browser),
						now(),
					);
					if (
						!pending ||
						!(await control(pending.controlToken, pending.accountId))
					)
						return response(403, { error: "OAuth state rejected" });
					const tokenResult = await send(
						"https://github.com/login/oauth/access_token",
						{
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								client_id: options.clientId,
								client_secret: options.clientSecret,
								code,
								redirect_uri: redirectUri,
								code_verifier: pending.verifier,
							}),
							redirect: "error",
							signal: AbortSignal.timeout(15000),
						},
					);
					if (!tokenResult.ok)
						return response(403, { error: "GitHub authorization rejected" });
					const oauth = OAuthToken.parse(await tokenResult.json());
					const userResult = await send("https://api.github.com/user", {
						headers: {
							authorization: `Bearer ${oauth.access_token}`,
							accept: "application/vnd.github+json",
							"x-github-api-version": "2026-03-10",
						},
						redirect: "error",
						signal: AbortSignal.timeout(15000),
					});
					if (!userResult.ok)
						return response(403, { error: "GitHub identity rejected" });
					const user = GithubUser.parse(await userResult.json());
					const raw = randomToken();
					await options.store.issueSession(
						digest(raw),
						pending.accountId,
						user.id,
						oauth.access_token,
						pending.controlToken,
						now() + 15 * 60_000,
					);
					const out = headers();
					out.append(
						"set-cookie",
						`__Host-hobo_ci_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
					);
					out.append(
						"set-cookie",
						`__Host-hobo_ci_session=${raw}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
					);
					if (request.headers.get("accept")?.includes("text/html")) {
						out.set("location", "/v1/app-registration/setup?status=connected");
						return new Response(null, { status: 303, headers: out });
					}
					return Response.json(
						{ status: "authenticated" },
						{ status: 200, headers: out },
					);
				}
				return response(405, { error: "method not allowed" });
			} catch {
				return response(503, { error: "GitHub authorization unavailable" });
			}
		},
	};
}
