import type { Pool } from "pg";
import { z } from "zod";
import { createAppRegistration } from "./app-registration.js";
import {
	createAppRegistrationHandler,
	createGithubInstallationAdminVerifier,
} from "./app-registration-http.js";
import { PostgresAppRegistration } from "./app-registration-postgres.js";
import type { ControlAuthenticator } from "./control-auth.js";
import { createGithubOAuthSession } from "./github-oauth-session.js";
import { PostgresGithubOAuthSessionStore } from "./github-oauth-session-postgres.js";
import type { OnboardingGithubPort } from "./onboarding.js";

/** Compose the real OAuth session, account authority and encrypted registration vault. */
export function createHostedAppOnboarding(options: {
	pool: Pool;
	key: Uint8Array;
	publicOrigin: string;
	appId: number;
	clientId: string;
	clientSecret: string;
	github: OnboardingGithubPort;
	authenticate: ControlAuthenticator;
	trustedBootstrapControl?: (request: Request) => Promise<string | undefined>;
	fetch?: typeof fetch;
}) {
	const registrationStore = new PostgresAppRegistration(
		options.pool,
		options.key,
	);
	const sessions = new PostgresGithubOAuthSessionStore(
		options.pool,
		options.key,
	);
	const oauthOptions: Parameters<typeof createGithubOAuthSession>[0] = {
		publicOrigin: options.publicOrigin,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		store: sessions,
		authenticateControl: options.authenticate,
		fetch: options.fetch ?? fetch,
	};
	if (options.trustedBootstrapControl)
		oauthOptions.trustedBootstrapControl = options.trustedBootstrapControl;
	const oauth = createGithubOAuthSession(oauthOptions);
	const verifyInstallationAdmin = createGithubInstallationAdminVerifier({
		github: options.github,
		getUserToken: oauth.githubToken,
		fetch: options.fetch ?? fetch,
	});
	const registration = createAppRegistration({
		appId: options.appId,
		states: registrationStore,
		vault: registrationStore,
		github: options.github,
		authority: {
			async authorize(actor, purpose) {
				return (
					purpose === "install" &&
					(await oauth.githubToken(actor)) !== undefined
				);
			},
			verifyInstallationAdmin,
		},
		fetch: options.fetch ?? fetch,
	});
	const handler = createAppRegistrationHandler({
		registration,
		authenticate: oauth.authenticate,
		async installationUrl(state) {
			const response = await options.github.appRequest("/app");
			if (!response.ok) throw new Error("App identity unavailable");
			const result = z
				.object({
					id: z.number().int().positive(),
					slug: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
				})
				.safeParse(await response.json());
			if (!result.success || result.data.id !== options.appId)
				throw new Error("App identity mismatch");
			const app = result.data;
			const url = new URL(
				`https://github.com/apps/${app.slug}/installations/new`,
			);
			url.searchParams.set("state", state);
			return url.href;
		},
	});
	return {
		/** Include only App installations whose ownership was independently verified. */
		authenticate: async (authorization: string | undefined) => {
			const principal = await options.authenticate(authorization);
			if (!principal) return undefined;
			const installed = await registrationStore.ownedInstallations(
				options.appId,
				principal.accountId,
			);
			return {
				...principal,
				installationIds: [
					...new Set([...principal.installationIds, ...installed]),
				],
			};
		},
		async handle(request: Request) {
			return (await oauth.handle(request)) ?? (await handler(request));
		},
		cleanup: () => sessions.cleanup(Date.now()),
	};
}
