import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { type Configuration, ConfigurationSchema } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { expect } from "vitest";
import { z } from "zod";
import { createControlAuthenticator } from "../../src/control-auth.js";
import type { FleetVerdictStore } from "../../src/fleet-verdict.js";
import { createHostedControlPlane } from "../../src/hosted-control.js";
import { HostedRelay } from "../../src/hosted-relay.js";
import { createRelayHandler } from "../../src/http-handler.js";
import { createNodeRelayHandler } from "../../src/node-http.js";
import {
	type OnboardingGithubPort,
	parseOnboardingPlan,
} from "../../src/onboarding.js";
import { LeaseStore } from "../../src/store.js";

const Interaction = z.object({
	description: z.string(),
	request: z.object({
		scope: z.enum(["app", "installation"]),
		method: z.string(),
		path: z.string(),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json().optional() }),
});
const source = z
	.object({
		metadata: z.object({
			consumerFixtures: z.object({
				options: z.object({
					assets: z.object({ workflow: z.string(), bootstrap: z.string() }),
					relayUrl: z.string(),
				}),
				plan: z.json(),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../contracts/onboarding-boundary.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
export const SETUP_PLAN = parseOnboardingPlan(
	JSON.stringify(source.metadata.consumerFixtures.plan),
);
export const NOW = "2026-10-27T00:00:00Z";
export const TOKEN = "control-tenant-token-with-at-least-32-characters";
export const OTHER_TOKEN = "control-neighbor-token-with-at-least-32-characters";
export const READ_TOKEN = "control-readonly-token-with-at-least-32-characters";
export const REPOSITORY_TOKEN =
	"control-repositories-token-at-least-32-characters";
export const OPERATOR_TOKEN =
	"control-operations-token-with-at-least-32-characters";
export const IDENTITY_CALLS = [
	"read authenticated App identity",
	"read App installation permissions",
	"bind repository to selected installation",
	"read installed repository identity",
	"resolve App bot actor identity",
];
export const PREPARE_CALLS = [
	...IDENTITY_CALLS,
	"read reviewed default head",
	"read reviewed base tree",
];
export const APPLY_CALLS = [
	...IDENTITY_CALLS,
	"installation branch absent",
	"read reviewed base tree",
	"create reviewed installation tree",
	"create reviewed installation commit",
	"create deterministic installation branch",
	"read deterministic installation branch",
	"verify installation parent commit",
	"verify only reviewed files changed",
	"verify installation .github/workflows/hobo-ci-host.yml",
	"verify installation .hobo-ci/bootstrap.mts",
	"installation pull request absent",
	"create one reviewed installation pull request",
];
const MERGED_FILES = [
	"verify merged .github/workflows/hobo-ci-host.yml",
	"verify merged .hobo-ci/bootstrap.mts",
];
export const CONNECT_CALLS = [
	...IDENTITY_CALLS,
	"find merged installation pull request",
	"read merged default head",
	...MERGED_FILES,
	...MERGED_FILES,
	"bridge branch absent",
	"create immutable bridge branch",
	"verify exact bridge commit pin",
	"bridge protection absent",
	"lock and protect the reviewed bridge",
	"verify acknowledged immutable protection",
	"verify exact bridge commit pin",
];

export function strictGithub(
	descriptions: string[],
	responses = new Map<number, z.infer<typeof Interaction>["response"]>(),
	gates = new Map<number, Promise<void>>(),
) {
	let count = 0;
	let unmatched = 0;
	async function send(
		scope: string,
		path: string,
		method: string,
		body?: string,
	) {
		const position = count++;
		const description = descriptions[position];
		const expected = source.interactions.find(
			(entry) => entry.description === description,
		);
		if (!expected) {
			unmatched++;
			throw new Error("PACT_NO_INTERACTION");
		}
		expect({
			scope,
			method,
			path,
			body: body === undefined ? undefined : JSON.parse(body),
		}).toEqual({ ...expected.request, body: expected.request.body });
		await gates.get(position);
		const response = responses.get(position) ?? expected.response;
		return new Response(
			response.body === undefined ? null : JSON.stringify(response.body),
			{ status: response.status },
		);
	}
	const github: OnboardingGithubPort = {
		appRequest: (path) => send("app", path, "GET"),
		request: (installationId, path, method = "GET", body) => {
			expect(installationId).toBe(5);
			return send("installation", path, method, body);
		},
	};
	return {
		github,
		count: () => count,
		assertComplete: () => {
			expect(count).toBe(descriptions.length);
			expect(unmatched).toBe(0);
		},
	};
}
export function credentials() {
	const scopes = [
		"policy:read",
		"policy:write",
		"repositories:write",
		"operations:write",
	];
	const digest = (token: string) =>
		createHash("sha256").update(token).digest("hex");
	return JSON.stringify({
		tokens: [
			{
				accountId: "tenant",
				installationIds: [5],
				tokenSha256: digest(TOKEN),
				scopes,
			},
			{
				accountId: "neighbor",
				installationIds: [6],
				tokenSha256: digest(OTHER_TOKEN),
				scopes,
			},
			{
				accountId: "tenant",
				installationIds: [5],
				tokenSha256: digest(READ_TOKEN),
				scopes: ["policy:read"],
			},
			{
				accountId: "tenant",
				installationIds: [5],
				tokenSha256: digest(REPOSITORY_TOKEN),
				scopes: ["repositories:write"],
			},
			{
				accountId: "tenant",
				installationIds: [5],
				tokenSha256: digest(OPERATOR_TOKEN),
				scopes: ["operations:write"],
			},
		],
	});
}
export function initialConfiguration(): Configuration {
	return create(ConfigurationSchema, {
		accounts: [
			{
				id: "tenant",
				budgetMicros: 1_000_000,
				maxRuntimeMinutes: 9,
				startupMinutes: 1,
			},
			{
				id: "neighbor",
				budgetMicros: 2_000_000,
				maxRuntimeMinutes: 9,
				startupMinutes: 1,
			},
		],
	});
}
/**
 * The account control plane over real loopback HTTP: the relay's control
 * plane behind the shared HTTP handler and Node adapter, on a real SQLite
 * partition. `ledger` is the store the control plane writes through; `store`
 * is a second, synchronous connection to the same file for arranging and
 * asserting state. Pass a `relay` harness to serve its partition instead.
 */
export async function controlHttp(
	options: {
		path?: string;
		github?: OnboardingGithubPort;
		configuration?: Configuration;
		relay?: { relay: HostedRelay; ledger: SqliteCiStore; store: LeaseStore };
		credentialJson?: string;
		fleetVerdicts?: FleetVerdictStore;
	} = {},
) {
	const api = options.github ?? strictGithub([]).github;
	let directory: string | undefined;
	let ledger = options.relay?.ledger;
	let store = options.relay?.store;
	if (!ledger || !store) {
		let file = options.path;
		if (file === undefined) {
			directory = mkdtempSync(join(tmpdir(), "hobo-ci-control-"));
			file = join(directory, "relay.sqlite");
		}
		ledger = new SqliteCiStore(file);
		store = new LeaseStore(file);
	}
	if (!store.configuration())
		store.configure(options.configuration ?? initialConfiguration(), 0, NOW);
	const configuration = store.configuration()?.configuration;
	if (!configuration) throw new Error("missing control fixture configuration");
	const webhookSecret = "control-http-webhook-secret-at-least-32-characters";
	const relay =
		options.relay?.relay ??
		new HostedRelay({
			config: configuration,
			store: ledger,
			github: api,
			identity: {
				verify: async () => {
					throw new Error("unexpected runner identity request");
				},
			},
			webhookSecret,
			now: () => NOW,
		});
	const control = createHostedControlPlane({
		relay,
		store: ledger,
		github: api,
		authenticate: createControlAuthenticator(
			options.credentialJson ?? credentials(),
		),
		publicOrigin: source.metadata.consumerFixtures.options.relayUrl,
		assets: source.metadata.consumerFixtures.options.assets,
		// As the Node host composes it: its operator owns the provider inventory.
		fullAccountUpdates: true,
		fleetVerdicts: options.fleetVerdicts,
	});
	const refuse = async (): Promise<never> => {
		throw new Error("unexpected relay request on the control fixture");
	};
	const server = createServer(
		createNodeRelayHandler({
			origin: source.metadata.consumerFixtures.options.relayUrl,
			handle: createRelayHandler({
				application: {
					control,
					ingestWebhook: refuse,
					claim: refuse,
					ready: async () => true,
				},
				webhookSecret,
			}),
		}),
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = z.object({ port: z.number() }).parse(server.address());
	let stopped = false;
	const owned = { ledger, store };
	return {
		store,
		ledger,
		relay,
		base: `http://127.0.0.1:${address.port}`,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
			owned.store.close();
			owned.ledger.close();
			if (directory) rmSync(directory, { recursive: true, force: true });
		},
	};
}
