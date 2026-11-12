/**
 * Consumer side of the Cloudflare experiment: the real provisioning, with
 * the Worker experiment, against a mock built from the pact. Every request
 * must be one the pact records, with the headers it names; the uploaded
 * Worker is then run in memory to answer health and take its seed.
 */
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOneTimeActionStore } from "@hobo/claims";
import {
	configServiceWorkerModules,
	createInMemoryConfigService,
	type InMemoryConfigService,
} from "@hobo/config-service-worker";
import {
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	type TemporaryAccountTransportPort,
} from "@hobo/provider-cloudflare";
import { beforeAll, describe, expect, it } from "vitest";
import {
	claimScopeFor,
	provisionCloudflareTemporaryStore,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
let pact: PactDocument;

beforeAll(async () => {
	const found = (
		await loadPactDirectory(path.join(contractsDir, "pacts"))
	).find(
		(candidate) => candidate.provider.name === "CloudflareTemporaryAccountsApi",
	);
	if (!found) throw new Error("the Cloudflare provisioning pact is missing");
	pact = found;
});

describe("HoBo ⇄ Cloudflare temporary accounts (consumer, the experiment)", () => {
	it("makes only the recorded requests, with the account's own token for the upload", async () => {
		const mock = createMockProviderFromPact(pact);
		const seen: PactRequest[] = [];
		let worker: InMemoryConfigService | undefined;
		const transport: TemporaryAccountTransportPort = {
			async send(request) {
				const url = new URL(request.url);
				const json = request.headers["content-type"] === "application/json";
				const recorded: PactRequest = {
					method: request.method,
					path: url.pathname,
					headers: request.headers,
					...(json && request.body !== undefined
						? { body: JSON.parse(request.body) }
						: undefined),
				};
				seen.push(recorded);
				if (request.method === "PUT") {
					const metadata =
						/name="metadata"[^]*?\r\n\r\n(\{[^\r]*\})\r\n/u.exec(
							request.body ?? "",
						)?.[1] ?? "{}";
					const parsed: {
						bindings: { name: string; text?: string }[];
						migrations: object;
					} = JSON.parse(metadata);
					expect(parsed.migrations).toEqual({
						new_tag: "v1",
						new_sqlite_classes: ["ConfigStore"],
					});
					worker = createInMemoryConfigService(
						{
							HOBO_CONFIG_BINDING:
								parsed.bindings.find(
									(entry) => entry.name === "HOBO_CONFIG_BINDING",
								)?.text ?? "",
						},
						async () => new Response(null, { status: 404 }),
					);
				}
				const response = await mock.handle(recorded);
				return {
					status: response.status,
					headers: {},
					body: JSON.stringify(response.body ?? {}),
				};
			},
		};
		const now = new Date();
		const result = await provisionCloudflareTemporaryStore({
			transport,
			consent: {
				subjectRef: "hobo-owner-pact",
				termsUrl: CLOUDFLARE_TERMS_URL,
				privacyUrl: CLOUDFLARE_PRIVACY_URL,
				acceptedAtMs: now.getTime() - 1000,
				acceptanceMethod: "cli-confirmation",
			},
			deploymentRef: "ci-vercel",
			store: createOneTimeActionStore({
				seal: (value) => Buffer.from(value).toString("base64"),
				open: (value) => Buffer.from(value, "base64").toString("utf8"),
			}),
			scope: claimScopeFor("ci-vercel", {}),
			now,
			worker: {
				modules: await configServiceWorkerModules(),
				binding: {
					vercelTeamSlug: "hobo-team",
					vercelTeamId: "team_fixture",
					vercelProjectName: "hobo-ci",
					vercelProjectId: "prj_fixture",
					repository: "Hobo-Labs/HoBo",
				},
				storeId: "pactstore0000000",
				fetch: async (input, init) =>
					worker === undefined
						? new Response(null, { status: 404 })
						: worker.fetch(input, init),
				healthAttempts: 1,
			},
		});
		expect(result.receipt.worker).toEqual({
			outcome: "serving",
			origin: "https://hobo-config-pactstore000.pact-sub.workers.dev",
			storeId: "pactstore0000000",
		});
		expect(seen).toHaveLength(pact.interactions.length);
		for (const request of seen) {
			const interaction = pact.interactions.find(
				(candidate) =>
					candidate.request.method === request.method &&
					candidate.request.path === request.path,
			);
			expect(interaction, `${request.method} ${request.path}`).toBeDefined();
			for (const [name, value] of Object.entries(
				interaction?.request.headers ?? {},
			))
				expect(
					request.headers?.[name],
					`${request.method} ${request.path} ${name}`,
				).toBe(value);
		}
	});
});
