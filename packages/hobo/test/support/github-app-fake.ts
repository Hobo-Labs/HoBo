import type { CredentialResolver } from "@hobo/cd";
import { GITHUB_REST_ORIGIN } from "../../src/ci-github-app.js";

export const FAKE_INSTALLATION_TOKEN = "ghs_fakeInstallationToken0000";

export type GithubRequest = Readonly<{
	method: string;
	url: string;
	path: string;
	authorization: string | null;
	redirect: RequestRedirect;
}>;

export type GithubAnswer = string | Response;

export const githubStatus = (status: number): Response =>
	new Response(null, { status });

export function installationCredentials(
	token: string = FAKE_INSTALLATION_TOKEN,
): CredentialResolver & Readonly<{ asked: readonly string[] }> {
	const asked: string[] = [];
	return {
		asked,
		resolve: async (ref) => {
			asked.push(ref);
			if (!ref.startsWith("github-app://"))
				throw new Error(`${ref} is not a GitHub App installation`);
			return { token };
		},
	};
}

export const refusingCredentials: CredentialResolver = {
	resolve: async () => {
		throw new Error("The owner's store session is closed");
	},
};

export function withInstallation(
	owner: CredentialResolver,
	installation: CredentialResolver = installationCredentials(),
): CredentialResolver {
	return {
		resolve: (ref, scope) =>
			(ref.startsWith("github-app://") ? installation : owner).resolve(
				ref,
				scope,
			),
	};
}

export type GithubRestFake = Readonly<{
	fetch: typeof fetch;
	requests: readonly GithubRequest[];
	paths: () => readonly string[];
}>;

export function githubRestFetch(
	answer: (request: GithubRequest) => GithubAnswer | undefined,
	token: string = FAKE_INSTALLATION_TOKEN,
): GithubRestFake {
	const requests: GithubRequest[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const rest = url.origin === GITHUB_REST_ORIGIN;
		const authorization = request.headers.get("authorization");
		if (rest && authorization !== `Bearer ${token}`)
			throw new Error("GitHub REST call without the installation token");
		if (!rest && authorization !== null)
			throw new Error("The installation token left api.github.com");
		const seen = {
			method: request.method,
			url: request.url,
			path: rest ? `${url.pathname.slice(1)}${url.search}` : request.url,
			authorization,
			redirect: request.redirect,
		};
		requests.push(seen);
		const reply = answer(seen);
		if (reply === undefined) return githubStatus(404);
		return reply instanceof Response ? reply : new Response(reply);
	};
	return {
		fetch: fetcher,
		requests,
		paths: () =>
			requests.map((request) =>
				request.method === "GET"
					? request.path
					: `${request.method} ${request.path}`,
			),
	};
}

export function routeGithub(
	github: typeof fetch,
	other: typeof fetch,
): typeof fetch {
	return (input, init) =>
		new Request(input, init).url.startsWith(`${GITHUB_REST_ORIGIN}/`)
			? github(input, init)
			: other(input, init);
}
