import type { SignInProvider } from "@hobo/fleet";
import { failed, isRecord, isText, requestJson } from "./http.js";

export type GithubProviderOptions = Readonly<{
	clientId: string;
	clientSecret: () => Promise<string>;
	webBase?: string | undefined;
	apiBase?: string | undefined;
	fetch: typeof fetch;
}>;

export function createGithubSignInProvider(
	options: GithubProviderOptions,
): SignInProvider {
	const web = (options.webBase ?? "https://github.com").replace(/\/+$/u, "");
	const api = (options.apiBase ?? "https://api.github.com").replace(
		/\/+$/u,
		"",
	);
	return {
		id: "github",
		async begin(input) {
			const url = new URL(`${web}/login/oauth/authorize`);
			url.searchParams.set("client_id", options.clientId);
			url.searchParams.set("redirect_uri", input.redirectUri);
			url.searchParams.set("scope", "read:org");
			url.searchParams.set("state", input.state);
			url.searchParams.set("code_challenge", input.codeChallenge);
			url.searchParams.set("code_challenge_method", "S256");
			url.searchParams.set("allow_signup", "false");
			return { url: url.toString() };
		},
		async complete(input) {
			const exchanged = await requestJson(
				options.fetch,
				`${web}/login/oauth/access_token`,
				{
					form: {
						client_id: options.clientId,
						client_secret: await options.clientSecret(),
						code: input.code,
						redirect_uri: input.redirectUri,
						code_verifier: input.codeVerifier,
					},
				},
			);
			const token = isRecord(exchanged.body)
				? exchanged.body.access_token
				: undefined;
			if (exchanged.status !== 200 || !isText(token))
				return failed("unauthenticated", "GitHub refused the code");
			const headers = {
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			};
			const user = await requestJson(options.fetch, `${api}/user`, { headers });
			if (
				user.status !== 200 ||
				!isRecord(user.body) ||
				!isText(user.body.login)
			)
				return failed("unauthenticated", "GitHub did not name the user");
			const orgs = await requestJson(
				options.fetch,
				`${api}/user/orgs?per_page=100`,
				{ headers },
			);
			const logins = Array.isArray(orgs.body)
				? orgs.body.flatMap((org) =>
						isRecord(org) && isText(org.login) ? [org.login] : [],
					)
				: [];
			const login = user.body.login;
			return {
				ok: true,
				value: {
					principal: { kind: "user", id: `github.com/${login}` },
					claims: {
						iss: web,
						login,
						id: String(user.body.id ?? ""),
						org: logins.join(","),
					},
				},
			};
		},
	};
}
