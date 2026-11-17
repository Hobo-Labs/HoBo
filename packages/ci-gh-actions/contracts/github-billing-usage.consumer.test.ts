import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	GithubMinutesReader,
	includedMinutesOfPlan,
} from "../src/billing-usage.js";

type Interaction = Readonly<{
	description: string;
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<Record<string, readonly string[]>>;
		headers: Readonly<Record<string, string>>;
	}>;
	response: Readonly<{ status: number; body: object }>;
}>;

// SAFETY: test-only hand-authored Pact; response bodies are parsed by the reader.
const pact = JSON.parse(
	readFileSync(
		new URL("./github-billing-usage.pact.json", import.meta.url),
		"utf8",
	),
) as { interactions: readonly Interaction[] };

const NOW = Date.UTC(2026, 10, 17, 12);

it("reads Actions minutes through every declared GitHub billing interaction", async () => {
	expect(pact.interactions).toHaveLength(8);
	const matched: string[] = [];
	// The reader turns any failure into "unmeasured", so a stray request is
	// recorded here rather than thrown into its catch.
	const unmatched: string[] = [];
	const reader = new GithubMinutesReader({
		baseUrl: "https://api.github.test",
		token: async () => "test-token",
		plan: undefined,
		recentMinutes: undefined,
		now: () => NOW,
		cacheMs: 0,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const entry = pact.interactions.find(
				(candidate) =>
					candidate.request.path === url.pathname &&
					candidate.request.method === (init?.method ?? "GET"),
			);
			if (!entry) {
				unmatched.push(url.pathname);
				return Response.json({ message: "unmatched" }, { status: 500 });
			}
			const query: Record<string, string[]> = {};
			for (const [name, value] of url.searchParams)
				query[name] = [...(query[name] ?? []), value];
			expect(query).toEqual(entry.request.query ?? {});
			const headers = new Headers(init?.headers);
			for (const [name, value] of Object.entries(entry.request.headers))
				expect(headers.get(name)).toBe(value);
			expect(headers.get("authorization")).toBe("Bearer test-token");
			matched.push(entry.description);
			return Response.json(entry.response.body, {
				status: entry.response.status,
			});
		},
	});

	// An organization: its plan, then its usage.
	expect(await reader.usage("test-org")).toEqual({
		usedMinutes: 1000,
		includedMinutes: includedMinutesOfPlan("team"),
	});
	// A user: each organization path is not found, so the user path answers.
	expect(await reader.usage("test-user")).toEqual({
		usedMinutes: 200,
		includedMinutes: includedMinutesOfPlan("pro"),
	});
	// No billing permission: unmeasured, and nothing else is asked.
	expect(await reader.usage("locked-org")).toBeUndefined();

	expect(unmatched).toEqual([]);
	expect(matched).toEqual(
		pact.interactions.map((interaction) => interaction.description),
	);
});
