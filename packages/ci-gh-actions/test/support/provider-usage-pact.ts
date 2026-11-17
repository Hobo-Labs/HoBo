/**
 * A fake of the three provider usage APIs that answers only what their
 * hand-authored pacts (`contracts/*-usage.pact.json`) declare. A request no
 * interaction matches exactly (method, path, query, headers, body) gets a
 * 500 and is recorded in `unmatched`, because the readers turn any failure
 * into "unmeasured" and would otherwise hide it. Every matched interaction is
 * recorded in `matched` by provider and description.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export type UsagePactInteraction = Readonly<{
	description: string;
	providerState: string;
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<Record<string, readonly string[]>>;
		headers: Readonly<Record<string, string>>;
		body?: object;
	}>;
	response: Readonly<{ status: number; body: object }>;
}>;

export type UsagePact = Readonly<{
	provider: Readonly<{ name: string }>;
	interactions: readonly UsagePactInteraction[];
}>;

export const USAGE_PACT_FILES = {
	depot: "depot-usage.pact.json",
	namespace: "namespace-usage.pact.json",
	warpbuild: "warpbuild-usage.pact.json",
} as const;

export type UsagePactProvider = keyof typeof USAGE_PACT_FILES;

export const USAGE_PACT_PROVIDERS: readonly UsagePactProvider[] = [
	"depot",
	"namespace",
	"warpbuild",
];

export function loadUsagePact(provider: UsagePactProvider): UsagePact {
	// SAFETY: test-only hand-authored Pact; response bodies are parsed by the readers.
	return JSON.parse(
		readFileSync(
			new URL(`../../contracts/${USAGE_PACT_FILES[provider]}`, import.meta.url),
			"utf8",
		),
	) as UsagePact;
}

/** Where each fake answers. A test points each reader at its origin. */
export const USAGE_PACT_ORIGINS = {
	depot: "https://depot.pact.test",
	namespace: "https://us.namespace.pact.test",
	warpbuild: "https://warpbuild.pact.test/api/v1",
} as const;

export type UsagePactFake = Readonly<{
	fetch: typeof fetch;
	matched: string[];
	unmatched: string[];
	/** Every authorization header sent, to show where tokens went. */
	authorizations: string[];
}>;

function providerOfUrl(url: URL): UsagePactProvider | undefined {
	for (const provider of USAGE_PACT_PROVIDERS)
		if (new URL(USAGE_PACT_ORIGINS[provider]).host === url.host)
			return provider;
	return undefined;
}

function queryOf(url: URL) {
	const query = new Map<string, string[]>();
	for (const [name, value] of url.searchParams)
		query.set(name, [...(query.get(name) ?? []), value]);
	return query;
}

export function usagePactFake(
	pacts: ReadonlyMap<UsagePactProvider, UsagePact> = new Map(
		USAGE_PACT_PROVIDERS.map((provider): [UsagePactProvider, UsagePact] => [
			provider,
			loadUsagePact(provider),
		]),
	),
): UsagePactFake {
	const matched: string[] = [];
	const unmatched: string[] = [];
	const authorizations: string[] = [];
	const fetchFake: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const provider = providerOfUrl(url);
		const pact = provider ? pacts.get(provider) : undefined;
		const headers = new Headers(init?.headers);
		authorizations.push(headers.get("authorization") ?? "");
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const entry = pact?.interactions.find((candidate) => {
			const request = candidate.request;
			return (
				request.method === method &&
				request.path === url.pathname &&
				isDeepStrictEqual(
					new Map(Object.entries(request.query ?? {})),
					queryOf(url),
				) &&
				Object.entries(request.headers).every(
					([name, value]) => headers.get(name) === value,
				) &&
				isDeepStrictEqual(request.body, body)
			);
		});
		if (!provider || !entry) {
			unmatched.push(`${method} ${url.href} ${JSON.stringify(body ?? null)}`);
			return Response.json({ message: "unmatched" }, { status: 500 });
		}
		matched.push(`${provider}: ${entry.description}`);
		return Response.json(entry.response.body, {
			status: entry.response.status,
		});
	};
	return { fetch: fetchFake, matched, unmatched, authorizations };
}
