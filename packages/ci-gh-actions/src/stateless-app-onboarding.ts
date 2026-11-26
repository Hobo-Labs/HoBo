/**
 * GitHub onboarding on the stateless hosted relay (ADR-0179 phase 5): the
 * same OAuth session flow and installation verification as
 * `createHostedAppOnboarding`, on the cache instead of the platform-App and
 * session tables, and an owner bootstrap that creates nothing.
 *
 * - **Sessions and OAuth `state`**: `CacheGithubOAuthSessionStore`, records
 *   named by an HMAC under the session key and sealed with a key derived
 *   from it; `state` single-use, ten minutes; sessions fifteen.
 * - **Installations**: an operator who proves they administer an
 *   installation (`createGithubInstallationAdminVerifier`) gets it for a day
 *   (`CacheVerifiedInstallations`); the relay logs it for `hobo ci` to write
 *   into the config service, which stays the only source of configuration.
 * - **Owner bootstrap**: the App already exists (`hobo ci` created it, into
 *   the config service). The owner redeems the invitation the config service
 *   holds (`HOBO_CI_BOOTSTRAP_TOKEN_SHA256`, `HOBO_CI_INVITATION_EXPIRES_AT`)
 *   once, through a consumed marker in the cache, and gets a ten-minute owner
 *   session that stands for the onboarding control token
 *   (`HOBO_CI_ONBOARDING_CONTROL_TOKEN`). The routes that created an App in
 *   the relay answer 410.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EphemeralStatePort } from "@hobo/core";
import { z } from "zod";
import { createAppRegistration } from "./app-registration.js";
import {
	createAppRegistrationHandler,
	createGithubInstallationAdminVerifier,
} from "./app-registration-http.js";
import type { ControlAuthenticator } from "./control-auth.js";
import { createGithubOAuthSession } from "./github-oauth-session.js";
import type { OnboardingGithubPort } from "./onboarding.js";
import {
	CacheAppRegistrationStates,
	CacheGithubOAuthSessionStore,
	CacheOwnerBootstrap,
	CacheVerifiedInstallations,
	type RelaySessionKey,
} from "./relay-cache/sessions.js";

const OWNER_COOKIE = "__Host-hobo_ci_bootstrap";
const OWNER_SESSION_MS = 10 * 60_000;
const COOKIE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export type StatelessOwnerInvitation = Readonly<{
	accountId: string;
	/** SHA-256 (hex) of the invitation token `hobo ci` handed the owner. */
	tokenSha256: string;
	/** Epoch milliseconds; an invitation without one is never accepted. */
	expiresAt: number | undefined;
	/** The owner's onboarding control token, which an owner session stands for. */
	controlToken: string | undefined;
}>;

export type StatelessAppOnboardingOptions = Readonly<{
	state: EphemeralStatePort;
	environment: string;
	sessionKey: RelaySessionKey;
	publicOrigin: string;
	appId: number;
	clientId: string;
	clientSecret: string;
	github: OnboardingGithubPort;
	authenticate: ControlAuthenticator;
	owner?: StatelessOwnerInvitation | undefined;
	/** Hears each verified installation, by id: a log line for the operator. */
	onVerified?: (accountId: string, installationId: number) => void;
	fetch?: typeof fetch;
	now?: () => number;
}>;

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function cookie(request: Request, name: string): string | undefined {
	const values = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith(`${name}=`))
		.map((entry) => entry.slice(name.length + 1));
	return values.length === 1 && COOKIE_TOKEN.test(values[0] ?? "")
		? values[0]
		: undefined;
}

function reply(
	status: number,
	body: Readonly<Record<string, string>>,
	headers?: Headers,
): Response {
	const out = headers ?? new Headers();
	out.set("cache-control", "no-store");
	out.set("referrer-policy", "no-referrer");
	out.set("x-content-type-options", "nosniff");
	return Response.json(body, { status, headers: out });
}

function sameDigest(a: string, b: string): boolean {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return (
		left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
	);
}

/** Compose onboarding on the cache. `handle` answers its routes and returns undefined for others. */
export function createStatelessAppOnboarding(
	options: StatelessAppOnboardingOptions,
) {
	const now = options.now ?? Date.now;
	const send = options.fetch ?? fetch;
	const records = {
		state: options.state,
		environment: options.environment,
		sessionKey: options.sessionKey,
		now,
	};
	const sessions = new CacheGithubOAuthSessionStore(records);
	const states = new CacheAppRegistrationStates(records);
	const owners = new CacheOwnerBootstrap(records);
	const installations = new CacheVerifiedInstallations({
		state: options.state,
		environment: options.environment,
		now,
		onVerified: options.onVerified,
	});
	const origin = new URL(options.publicOrigin).origin;
	const owner = options.owner;

	/** The onboarding control token, for a request carrying a live owner session. */
	async function trustedBootstrapControl(
		request: Request,
	): Promise<string | undefined> {
		if (!owner?.controlToken) return undefined;
		const raw = cookie(request, OWNER_COOKIE);
		if (!raw) return undefined;
		const accountId = await owners.session(digest(raw));
		return accountId === owner.accountId ? owner.controlToken : undefined;
	}

	const oauth = createGithubOAuthSession({
		publicOrigin: options.publicOrigin,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		store: sessions,
		authenticateControl: options.authenticate,
		trustedBootstrapControl,
		fetch: send,
		now,
	});
	const registration = createAppRegistration({
		appId: options.appId,
		states,
		vault: installations,
		github: options.github,
		authority: {
			// The App is created with `hobo ci`; only installation is served here.
			authorize: async (actor, purpose) =>
				purpose === "install" && (await oauth.githubToken(actor)) !== undefined,
			verifyInstallationAdmin: createGithubInstallationAdminVerifier({
				github: options.github,
				getUserToken: oauth.githubToken,
				fetch: send,
			}),
		},
		fetch: send,
		now,
	});
	const handler = createAppRegistrationHandler({
		registration,
		authenticate: oauth.authenticate,
		async installationUrl(state) {
			const response = await options.github.appRequest("/app");
			if (!response.ok) throw new Error("App identity unavailable");
			const app = z
				.object({
					id: z.number().int().positive(),
					slug: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
				})
				.parse(await response.json());
			if (app.id !== options.appId) throw new Error("App identity mismatch");
			const url = new URL(
				`https://github.com/apps/${app.slug}/installations/new`,
			);
			url.searchParams.set("state", state);
			return url.href;
		},
	});

	/** Redeem the owner's invitation once and open a ten-minute owner session. */
	async function redeem(request: Request): Promise<Response> {
		const supplied = request.headers.get("origin");
		if (supplied && supplied !== origin)
			return reply(403, { error: "origin rejected" });
		const auth = request.headers.get("authorization") ?? "";
		if (!owner || !/^Bearer \S{32,1024}$/u.test(auth))
			return reply(401, { error: "invitation required" });
		if (
			owner.expiresAt === undefined ||
			now() >= owner.expiresAt ||
			!sameDigest(digest(auth.slice(7)), owner.tokenSha256)
		)
			return reply(403, { error: "invitation rejected" });
		if (!(await owners.redeem(owner.tokenSha256, owner.expiresAt)))
			return reply(403, { error: "invitation already used" });
		const raw = randomBytes(32).toString("base64url");
		await owners.issueSession(
			digest(raw),
			owner.accountId,
			now() + OWNER_SESSION_MS,
		);
		const headers = new Headers();
		headers.append(
			"set-cookie",
			`${OWNER_COOKIE}=${raw}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
		);
		return reply(
			200,
			{ status: "owner", next: "/v1/app-registration/setup" },
			headers,
		);
	}

	return {
		/** Control principals, with the installations their account verified in the last day. */
		authenticate: async (authorization: string | undefined) => {
			const principal = await options.authenticate(authorization);
			if (!principal) return undefined;
			const verified = await installations.ownedInstallations(
				options.appId,
				principal.accountId,
			);
			return {
				...principal,
				installationIds: [
					...new Set([...principal.installationIds, ...verified]),
				],
			};
		},
		trustedBootstrapControl,
		async handle(request: Request): Promise<Response | undefined> {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/v1/app-bootstrap/")) {
				if (url.origin !== origin)
					return reply(400, { error: "invalid origin" });
				try {
					if (
						url.pathname === "/v1/app-bootstrap/start" &&
						request.method === "POST"
					)
						return await redeem(request);
					if (
						url.pathname === "/v1/app-bootstrap/setup" &&
						request.method === "GET"
					) {
						if (!(await trustedBootstrapControl(request)))
							return reply(401, { error: "owner session required" });
						const headers = new Headers({
							location: "/v1/app-registration/setup",
						});
						return new Response(null, { status: 303, headers });
					}
					return reply(410, {
						error:
							"this relay does not create GitHub Apps; create the App with hobo ci, which writes it into the config service",
					});
				} catch {
					return reply(503, { error: "owner bootstrap unavailable" });
				}
			}
			if (
				url.pathname === "/v1/app-registration/manifest-callback" ||
				url.pathname === "/v1/app-registration/manifest"
			)
				return reply(410, {
					error:
						"this relay does not register GitHub Apps; create the App with hobo ci",
				});
			return (await oauth.handle(request)) ?? (await handler(request));
		},
	};
}
