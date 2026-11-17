/**
 * Runs `GithubRelayCheckSource` against every interaction of the
 * hand-authored `relay-checks.pact.json` (ADR-0183): each read a runner-less
 * check makes of GitHub, and nothing else.
 */
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { RelayJobMessageSchema } from "@hobo/ci";
import { expect, it } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	GithubRelayCheckSource,
	parseRelayChecksConfig,
} from "../src/relay-checks/index.js";

type Interaction = Readonly<{
	description: string;
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<Record<string, readonly string[]>>;
	}>;
	response: Readonly<{
		status: number;
		headers?: Readonly<Record<string, string>>;
		body: object | string;
	}>;
}>;

// SAFETY: test-only hand-authored Pact; response bodies are parsed by the source.
const pact = JSON.parse(
	readFileSync(new URL("./relay-checks.pact.json", import.meta.url), "utf8"),
) as { interactions: readonly Interaction[] };

const SHA = "0123456789abcdef0123456789abcdef01234567";

it("reads what a runner-less check needs through every declared GitHub interaction", async () => {
	expect(pact.interactions).toHaveLength(4);
	const matched = new Set<string>();
	const unmatched: string[] = [];
	const github: GithubTransport = {
		request: async (installationId, path, method = "GET") => {
			expect(installationId).toBe(11);
			const url = new URL(path, "https://api.github.test");
			const entry = pact.interactions.find(
				(candidate) =>
					candidate.request.path === url.pathname &&
					candidate.request.method === method,
			);
			if (!entry) {
				unmatched.push(path);
				return Response.json({ message: "unmatched" }, { status: 500 });
			}
			const query: Record<string, string[]> = {};
			for (const [name, value] of url.searchParams)
				query[name] = [...(query[name] ?? []), value];
			expect(query).toEqual(entry.request.query ?? {});
			matched.add(entry.description);
			const { body } = entry.response;
			return body instanceof Object
				? Response.json(body, { status: entry.response.status })
				: new Response(body, {
						status: entry.response.status,
						headers: entry.response.headers,
					});
		},
	};
	const source = new GithubRelayCheckSource(github, async (repository) =>
		repository === "octo/app" ? 11 : undefined,
	);
	const pullRef = create(RelayJobMessageSchema, {
		jobId: "j",
		planId: "p",
		repository: "octo/app",
		runId: 42,
		runAttempt: 1,
		job: "title",
		event: "pull_request",
		workflowRef: "octo/app/.github/workflows/checks.yml@refs/pull/7/merge",
	});
	// pull_request_target runs at the base branch: the run names the pull request.
	const baseRef = create(RelayJobMessageSchema, {
		...pullRef,
		event: "pull_request_target",
		workflowRef: "octo/app/.github/workflows/checks.yml@refs/heads/main",
	});

	expect(parseRelayChecksConfig(await source.ciFile(pullRef))).toEqual({
		ok: true,
		config: { titleTypes: ["feat", "fix"], lint: true },
	});
	expect(await source.pullRequest(pullRef)).toEqual({
		number: 7,
		title: "feat: add retry",
	});
	expect(await source.pullRequest(baseRef)).toEqual({
		number: 7,
		title: "feat: add retry",
	});
	expect(await source.commit(pullRef)).toBe(SHA);
	expect(new TextDecoder().decode(await source.archive(pullRef, SHA))).toBe(
		"gzipped tarball",
	);

	expect(unmatched).toEqual([]);
	expect([...matched].sort()).toEqual(
		pact.interactions.map((interaction) => interaction.description).sort(),
	);
	// A repository no installation serves is refused before any request.
	await expect(
		source.commit(
			create(RelayJobMessageSchema, { ...pullRef, repository: "x/y" }),
		),
	).rejects.toThrow("no GitHub App installation serves x/y");
});
