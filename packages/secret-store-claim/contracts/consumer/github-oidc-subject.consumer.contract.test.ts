import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import { beforeAll, describe, expect, it } from "vitest";
import {
	githubDeployTrust,
	resolveGithubOidcSubject,
	SecretStoreError,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const TOKEN = "fixture-github-token";
const API = "https://api.github.test";

let pact: PactDocument;
beforeAll(async () => {
	const found = (
		await loadPactDirectory(path.join(contractsDir, "pacts"))
	).find((candidate) => candidate.provider.name === "GitHubRestApi");
	if (!found) throw new Error("the GitHub OIDC subject pact is missing");
	pact = found;
});

/** A fetch answered by the pact; records every request it was asked. */
function pactFetch() {
	const mock = createMockProviderFromPact(pact);
	const seen: PactRequest[] = [];
	const send: typeof fetch = async (target, init) => {
		const url = new URL(String(target));
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		const request: PactRequest = {
			method: "GET",
			path: url.pathname,
			headers,
		};
		seen.push(request);
		const answer = mock.handle(request);
		return Response.json(answer.body ?? null, { status: answer.status });
	};
	return { send, seen };
}

function expectRecorded(seen: readonly PactRequest[]) {
	for (const request of seen) {
		const interaction = pact.interactions.find(
			(candidate) =>
				candidate.request.method === request.method &&
				candidate.request.path === request.path,
		);
		expect(interaction, request.path).toBeDefined();
		for (const [name, value] of Object.entries(
			interaction?.request.headers ?? {},
		))
			expect(request.headers?.[name], `${request.path} ${name}`).toBe(value);
	}
}

describe("GitHub's REST API, the OIDC subject a repository's tokens carry (consumer contract)", () => {
	it("binds the relay's repository to the immutable subject GitHub names, with its ids", async () => {
		const { send, seen } = pactFetch();
		const subject = await resolveGithubOidcSubject({
			repository: "Hobo-Labs/HoBo",
			token: TOKEN,
			fetch: send,
			apiUrl: API,
		});
		expect(subject).toMatchObject({
			repository: "Hobo-Labs/HoBo",
			ownerLogin: "Hobo-Labs",
			subjectPrefix: "repo:Hobo-Labs@344805935/HoBo@1274791462",
			repositoryId: "1274791462",
			repositoryOwnerId: "344805935",
			format: "immutable",
		});
		// The subject the relay deploy's denied token carried, exactly.
		expect(githubDeployTrust(subject)).toEqual({
			issuer: "https://token.actions.githubusercontent.com",
			audiences: ["https://github.com/Hobo-Labs"],
			subject: "repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main",
			claims: {
				repository_id: "1274791462",
				repository_owner_id: "344805935",
			},
		});
		expect(seen.map((request) => request.path)).toEqual([
			"/repos/Hobo-Labs/HoBo",
			"/repos/Hobo-Labs/HoBo/actions/oidc/customization/sub",
		]);
		expectRecorded(seen);
	});

	it("keeps the legacy subject for a repository GitHub says still issues it", async () => {
		const { send, seen } = pactFetch();
		const subject = await resolveGithubOidcSubject({
			repository: "acme/legacy",
			token: TOKEN,
			fetch: send,
			apiUrl: API,
		});
		expect(subject).toMatchObject({
			subjectPrefix: "repo:acme/legacy",
			format: "legacy",
			repositoryId: "42",
			repositoryOwnerId: "7",
		});
		expectRecorded(seen);
	});

	it("fails closed, with the remediation and without the token, when the template cannot be read", async () => {
		const { send, seen } = pactFetch();
		const error = await resolveGithubOidcSubject({
			repository: "acme/private",
			token: TOKEN,
			fetch: send,
			apiUrl: API,
		}).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(SecretStoreError);
		expect(error).toMatchObject({
			code: "SECRET_STORE_OIDC_SUBJECT_UNRESOLVED",
		});
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("HTTP 403");
		expect(message).toContain(
			"gh api repos/acme/private/actions/oidc/customization/sub",
		);
		expect(message).not.toContain(TOKEN);
		expectRecorded(seen);
	});

	it("keeps tokens out of every path", () => {
		for (const interaction of pact.interactions)
			expect(interaction.request.path).not.toMatch(/token|Bearer/iu);
	});
});
