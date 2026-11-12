/**
 * Consumer PACT for the GitHub REST boundary of the Pages realizer.
 *
 * Both directions are checked: every request the realizer emits across the
 * full lifecycle (`support/lifecycle.ts`) is declared by an interaction, and
 * every interaction is exercised. Paths match as templates (`{sha}`,
 * `{deployment_id}`), request bodies on their top-level key set, and the
 * recorded response bodies must equal what the offline world serves, so the
 * pact cannot drift from the fixtures the resolver tests run against.
 *
 * `HOBO_PACT_RECORD=1` rewrites the pact from the lifecycle; review the diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	GITHUB_PAGES_SITE_PRODUCT_ID,
	githubResolverRegistry,
} from "../src/index.js";
import { isJsonObject, isJsonString, type JsonValue } from "../src/json.js";
import { type Exchange, recordLifecycle } from "./support/lifecycle.js";
import { memoryStore, options, request, SITE_V1 } from "./support/world.js";

const PACT_URL = new URL(
	"../contracts/provider-github-pages.pact.json",
	import.meta.url,
);

interface Interaction {
	readonly description: string;
	readonly providerState: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly query?: string;
		readonly headers: Record<string, string>;
		readonly body?: JsonValue;
	};
	readonly response: { readonly status: number; readonly body?: JsonValue };
}

interface Pact {
	consumer: { name: string };
	provider: { name: string };
	metadata: Record<string, JsonValue>;
	interactions: Interaction[];
}

function template(pathname: string): string {
	return pathname
		.replace(/\/[0-9a-f]{40}(?=\/|$)/gu, "/{sha}")
		.replace(
			/\/pages\/deployments\/[0-9]{8}$/u,
			"/pages/deployments/{deployment_id}",
		)
		.replace(
			/\/actions\/artifacts\/[0-9]+$/u,
			"/actions/artifacts/{artifact_id}",
		);
}

function bodyOf(text: string | undefined): JsonValue | undefined {
	if (text === undefined || text === "") return undefined;
	// SAFETY: JSON.parse yields a JSON value; bodies here are JSON the world or realizer wrote.
	return JSON.parse(text) as JsonValue;
}

function keys(value: JsonValue | undefined): string {
	if (isJsonObject(value)) return Object.keys(value).sort().join(",");
	return value === undefined ? "" : isJsonString(value) ? "string" : "other";
}

function keyOf(exchange: Exchange): string {
	const url = new URL(exchange.request.url);
	return [
		exchange.request.method,
		template(url.pathname),
		url.search,
		keys(bodyOf(exchange.request.body)),
		exchange.response.status,
	].join(" ");
}

function interactionKey(interaction: Interaction): string {
	return [
		interaction.request.method,
		interaction.request.path,
		interaction.request.query ? `?${interaction.request.query}` : "",
		keys(interaction.request.body),
		interaction.response.status,
	].join(" ");
}

const DESCRIPTIONS: [RegExp, string, string][] = [
	[
		/^GET \/repos\/[^/]+\/[^/]+ .* 200$/u,
		"read the repository and the credential's permissions",
		"the repository exists and the token can read it",
	],
	[
		/^GET .*\/pages .* 200$/u,
		"read the Pages site configuration",
		"Pages is enabled",
	],
	[
		/^GET .*\/git\/ref\/heads\/[^ ]+ .* 404$/u,
		"observe a publishing branch that does not exist",
		"the publishing branch is absent",
	],
	[
		/^GET .*\/git\/ref\/heads\/[^ ]+ .* 200$/u,
		"observe the publishing branch head",
		"the publishing branch exists",
	],
	[
		/^GET .*\/git\/commits\/\{sha\} .* 200$/u,
		"read the head commit's tree",
		"the head commit exists",
	],
	[
		/^GET .*\/git\/trees\/\{sha\} \?recursive=1 .* 200$/u,
		"list the published tree's blobs recursively",
		"the published tree exists",
	],
	[
		/^GET .*\/git\/trees\/\{sha\} {2}.* 200$/u,
		"list the branch root to find the docs subtree",
		"the branch root tree exists",
	],
	[
		/^POST .*\/git\/blobs .* 201$/u,
		"upload one site file as a base64 blob",
		"the blob is content-addressed",
	],
	[
		/^GET .*\/git\/blobs\/\{sha\} .* 200$/u,
		"look a blob up by id after a lost upload reply",
		"the blob exists",
	],
	[
		/^POST .*\/git\/trees .*base_tree.* 201$/u,
		"graft the site tree under docs/ on the branch root",
		"the base tree and site tree exist",
	],
	[
		/^POST .*\/git\/trees .* 201$/u,
		"create the site tree from flat paths",
		"every blob exists",
	],
	[
		/^POST .*\/git\/commits .* 201$/u,
		"create a commit whose parent is the observed head",
		"the tree exists",
	],
	[
		/^POST .*\/git\/refs .* 201$/u,
		"create the publishing branch at the new commit",
		"the publishing branch is absent",
	],
	[
		/^PATCH .*\/git\/refs\/heads\/[^ ]+ .* 200$/u,
		"fast-forward the publishing branch (force: false)",
		"the head has not moved since it was observed",
	],
	[
		/^GET .*\/pages\/builds\/latest .* 404$/u,
		"observe that no Pages build exists yet",
		"Pages has never built",
	],
	[
		/^GET .*\/pages\/builds\/latest .* 200$/u,
		"observe the latest Pages build and its commit",
		"a Pages build exists",
	],
	[
		/^POST .*\/pages\/builds .* 201$/u,
		"request a Pages build of the published head",
		"the published head has no build",
	],
	[
		/^DELETE .*\/pages .* 204$/u,
		"unpublish the Pages site",
		"Pages is enabled",
	],
	[
		/^GET .*\/pages .* 404$/u,
		"observe that the Pages site is unpublished",
		"Pages is disabled",
	],
	[
		/^GET .*\/actions\/artifacts\/\{artifact_id\} .* 200$/u,
		"verify the Pages artifact the workflow uploaded",
		"the Actions artifact exists and has not expired",
	],
	[
		/^POST .*\/pages\/deployments .* 200$/u,
		"create a Pages deployment of the artifact",
		"Pages builds from GitHub Actions",
	],
	[
		/^GET .*\/pages\/deployments\/\{deployment_id\} .* 200$/u,
		"observe the Pages deployment status",
		"the deployment exists",
	],
];

function redact(body: JsonValue | undefined): JsonValue | undefined {
	if (!isJsonObject(body)) return body;
	const out: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(body))
		out[key] =
			key === "content" && isJsonString(value)
				? "<base64 file bytes>"
				: key === "oidc_token"
					? "<actions-oidc-token>"
					: value;
	return out;
}

function interactionOf(exchange: Exchange): Interaction {
	const key = keyOf(exchange);
	const found = DESCRIPTIONS.find(([pattern]) => pattern.test(key));
	if (!found) throw new Error(`no pact description for ${key}`);
	const url = new URL(exchange.request.url);
	const body = redact(bodyOf(exchange.request.body));
	const responseBody = redact(bodyOf(exchange.response.body));
	const onMain = url.pathname.endsWith("/heads/main");
	return {
		description: onMain
			? `${found[1]} (main, publishing from /docs)`
			: found[1],
		providerState: found[2],
		request: {
			method: exchange.request.method,
			path: template(url.pathname),
			...(url.search ? { query: url.search.slice(1) } : undefined),
			headers: {
				accept: "application/vnd.github+json",
				authorization: "Bearer <github-token>",
				"x-github-api-version": "2022-11-28",
				...(body === undefined
					? undefined
					: { "content-type": "application/json" }),
			},
			...(body === undefined ? undefined : { body }),
		},
		response: {
			status: exchange.response.status,
			...(responseBody === undefined ? undefined : { body: responseBody }),
		},
	};
}

const readPact = (): Pact =>
	// SAFETY: the pact is a checked-in document of this shape; the identity test pins it.
	JSON.parse(readFileSync(PACT_URL, "utf8")) as Pact;

describe.runIf(process.env.HOBO_PACT_RECORD === "1")("pact recorder", () => {
	it("rewrites the pact from the recorded lifecycle", async () => {
		const unique = new Map<string, Interaction>();
		for (const exchange of await recordLifecycle())
			if (!unique.has(keyOf(exchange)))
				unique.set(keyOf(exchange), interactionOf(exchange));
		const pact = readPact();
		pact.interactions = [...unique.values()];
		writeFileSync(PACT_URL, `${JSON.stringify(pact, null, "\t")}\n`);
	});
});

describe("GitHub Pages consumer pact", () => {
	it("names the consumer and provider", () => {
		const pact = readPact();
		expect(pact.consumer.name).toBe("HoBoCdReconciler");
		expect(pact.provider.name).toBe("GitHubRestApi");
	});

	it("declares every request of the full lifecycle, and the lifecycle exercises every interaction", async () => {
		const declared = new Map(
			readPact().interactions.map((entry) => [interactionKey(entry), entry]),
		);
		const exchanges = await recordLifecycle();
		const seen = new Set(exchanges.map(keyOf));
		for (const exchange of exchanges)
			expect(
				declared.has(keyOf(exchange)),
				`${keyOf(exchange)} is not declared by the pact`,
			).toBe(true);
		for (const key of declared.keys())
			expect(seen.has(key), `interaction ${key} is never exercised`).toBe(true);
	});

	it("records the responses the realizer is tested against, verbatim", async () => {
		const declared = new Map(
			readPact().interactions.map((entry) => [interactionKey(entry), entry]),
		);
		const first = new Map<string, Exchange>();
		for (const exchange of await recordLifecycle())
			if (!first.has(keyOf(exchange))) first.set(keyOf(exchange), exchange);
		for (const [key, exchange] of first)
			expect(declared.get(key)?.response).toEqual(
				interactionOf(exchange).response,
			);
	});

	it("declares header names the realizer sends, and never a credential value", async () => {
		const pact = readPact();
		const text = JSON.stringify(pact);
		expect(text).not.toMatch(/ghp_[A-Za-z0-9]/u);
		expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./u);
		for (const exchange of await recordLifecycle()) {
			const interaction = declared(pact, exchange);
			for (const name of Object.keys(interaction.request.headers))
				expect(exchange.request.headers).toHaveProperty(name);
		}
	});

	it("parses the recorded branch observation as converged once the build is built", async () => {
		const served = new Map<string, JsonValue>();
		for (const entry of readPact().interactions)
			if (entry.request.method === "GET" && entry.response.status === 200)
				served.set(entry.request.path, entry.response.body ?? null);
		// The pact records two different heads; serve the first branch world's.
		const outcome = await githubResolverRegistry(
			options(memoryStore(...SITE_V1.blobs)),
		)
			.get(GITHUB_PAGES_SITE_PRODUCT_ID)
			?.read?.(request(), async (entry) => {
				const path = template(new URL(entry.url).pathname);
				const body = served.get(path);
				return body === undefined
					? { status: 404, headers: {}, body: "{}" }
					: { status: 200, headers: {}, body: JSON.stringify(body) };
			});
		expect(outcome?.physicalId).toBe("hobo-fixtures/site");
		expect(outcome?.outputs.treeSha).toMatch(/^[0-9a-f]{40}$/u);
	});
});

function declared(pact: Pact, exchange: Exchange): Interaction {
	const found = pact.interactions.find(
		(entry) => interactionKey(entry) === keyOf(exchange),
	);
	if (!found) throw new Error(`pact has no interaction for ${keyOf(exchange)}`);
	return found;
}
