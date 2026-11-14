import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGithubAppManifest } from "@hobo/ci-gh-actions";
import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	createGithubConnectFlow,
	GITHUB_APP_CREDENTIAL_KEYS,
	type OpenedSecretStore,
	prepareGithubConnection,
	type SecretStoreOpening,
} from "../src/index.js";

// `hobo ci up`'s GitHub connection: a GitHub App from the reviewed manifest,
// credentials straight into the secret store, idempotent on re-run. GitHub is
// a fake that answers exactly what the real verifier checks; the connect page
// is the real loopback server, driven by a scripted browser.

const RELAY = "https://ci.hobo.example";
const OWNER_ID = 4242;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const reviewed = createGithubAppManifest({
	name: "HoBo CI",
	relayUrl: RELAY,
	manifestCallbackUrl: `${RELAY}/v1/app-bootstrap/callback`,
	installationCallbackUrl: `${RELAY}/v1/app-registration/install-callback`,
});

interface FakeGithub {
	readonly fetch: typeof fetch;
	readonly calls: string[];
}

interface PactInteraction {
	readonly request: { readonly method: string; readonly path: string };
	readonly response: { readonly status: number; readonly body: object };
}

// The provider side of contracts/pacts/github-app-manifest.pact.json.
const PACT: { readonly interactions: readonly PactInteraction[] } = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/github-app-manifest.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
);

/** The pact's requests, in order: what the flow must call. */
const PACT_CALLS = PACT.interactions.map(
	(interaction) => `${interaction.request.method} ${interaction.request.path}`,
);

// GitHub, answering from the pact: the reviewed permissions and events are
// added to the App bodies and the per-run key replaces the pem placeholder.
function fakeGithub(ownerId = OWNER_ID): FakeGithub {
	const calls: string[] = [];
	return {
		calls,
		async fetch(input, init) {
			const url = new URL(String(input));
			const call = `${init?.method ?? "GET"} ${url.pathname}`;
			calls.push(call);
			const interaction = PACT.interactions.find(
				(candidate) =>
					`${candidate.request.method} ${candidate.request.path}` === call,
			);
			if (interaction === undefined)
				return new Response('{"message":"not found"}', { status: 404 });
			const declared = interaction.response.body;
			const body = {
				...declared,
				...("owner" in declared
					? {
							owner: { id: ownerId, type: "User" },
							permissions: reviewed.defaultPermissions,
							events: reviewed.defaultEvents,
						}
					: undefined),
				...("pem" in declared ? { pem: PEM } : undefined),
			};
			return new Response(JSON.stringify(body), {
				status: interaction.response.status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}

function memoryStore(): OpenedSecretStore & {
	readonly names: () => readonly string[];
} {
	const port = createMemorySecretsPort({ id: "memory" });
	return {
		id: "infisical",
		port,
		names: port.names,
		reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
	};
}

const opened =
	(store: OpenedSecretStore) => async (): Promise<SecretStoreOpening> => ({
		ok: true,
		store,
	});

describe("createGithubConnectFlow", () => {
	it("creates the App, deposits every credential (id last), and shows references only", async () => {
		const store = memoryStore();
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			ownerId: OWNER_ID,
			owner: "octo-org",
			callbackUrl: () => "http://127.0.0.1:1/s/t/callback",
			openStore: opened(store),
			fetch: github.fetch,
			randomState: () => "state-1",
		});
		const chosen = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(chosen.step.kind).toBe("create-github-app");
		const started = await flow.onAction("connect.start", {}, chosen.step);
		expect(started.directive).toMatchObject({
			kind: "post",
			url: "https://github.com/settings/apps/new?state=state-1",
		});
		const done = await flow.onCallback?.(
			new URLSearchParams({ code: "one-time-code", state: "state-1" }),
			started.step,
		);
		expect(done?.step, JSON.stringify(done?.step)).toMatchObject({
			kind: "connected",
		});
		expect(flow.outcome()).toBe("created");
		expect([...store.names()].sort()).toEqual(
			[...GITHUB_APP_CREDENTIAL_KEYS].sort(),
		);
		expect(JSON.stringify(done?.step)).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(JSON.stringify(done?.step)).toContain(
			"infisical://proj/prod/hobo-ci/HOBO_CI_GITHUB_APP_ID",
		);
		// Exactly the pact's requests, in the pact's order.
		expect(github.calls).toEqual(PACT_CALLS);
	});

	it("is idempotent: a store that holds the App finishes unchanged without GitHub", async () => {
		const store = memoryStore();
		await store.port.put("HOBO_CI_GITHUB_APP_ID", "777");
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			ownerId: OWNER_ID,
			owner: "octo-org",
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: github.fetch,
		});
		const step = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(step.step.kind).toBe("connected");
		expect(flow.outcome()).toBe("unchanged");
		expect(github.calls).toEqual([]);
	});

	it("refuses a callback whose state does not match, storing nothing", async () => {
		const store = memoryStore();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			ownerId: OWNER_ID,
			owner: "octo-org",
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: fakeGithub().fetch,
			randomState: () => "expected",
		});
		const chosen = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		const started = await flow.onAction("connect.start", {}, chosen.step);
		const done = await flow.onCallback?.(
			new URLSearchParams({ code: "one-time-code", state: "forged" }),
			started.step,
		);
		expect(done?.step.kind).toBe("failed");
		expect(store.names()).toEqual([]);
	});

	it("discards credentials of an App that does not match the reviewed owner", async () => {
		const store = memoryStore();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			ownerId: OWNER_ID,
			owner: "octo-org",
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: fakeGithub(9999).fetch,
			randomState: () => "s",
		});
		const chosen = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		const started = await flow.onAction("connect.start", {}, chosen.step);
		const done = await flow.onCallback?.(
			new URLSearchParams({ code: "one-time-code", state: "s" }),
			started.step,
		);
		expect(done?.step).toMatchObject({ kind: "failed" });
		expect(JSON.stringify(done?.step)).toContain(
			"/settings/apps/hobo-ci-test/advanced",
		);
		expect(store.names()).toEqual([]);
	});
});

function prepareInput(
	whatIf = false,
): PrepareInput & { readonly progress: string[] } {
	const progress: string[] = [];
	const run: Pick<CommandRunInput, "emitProgress"> = {
		emitProgress: (message: string) => {
			progress.push(message);
		},
	};
	return {
		action: "up",
		projectDir: "/tmp/hobo-ci",
		whatIf,
		yes: false,
		// SAFETY: prepareGithubConnection reads only run.emitProgress.
		run: run as CommandRunInput,
		progress,
	};
}

const ENV = {
	HOBO_CI_PUBLIC_URL: RELAY,
	HOBO_CI_GITHUB_OWNER: "octo-org",
	HOBO_CI_GITHUB_OWNER_ID: String(OWNER_ID),
};

describe("prepareGithubConnection", () => {
	it("reports unchanged without opening a page when the store holds the App", async () => {
		const store = memoryStore();
		await store.port.put("HOBO_CI_GITHUB_APP_ID", "777");
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			openStore: opened(store),
			startPage: () => {
				throw new Error("no page should open");
			},
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "unchanged" }],
		});
	});

	it("opens nothing for --what-if", async () => {
		const outcome = await prepareGithubConnection(prepareInput(true), {
			env: ENV,
			openStore: opened(memoryStore()),
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "would-create" }],
		});
	});

	it("refuses when unconfigured or when nobody can answer a page", async () => {
		const unconfigured = await prepareGithubConnection(prepareInput(), {
			env: {},
			openStore: opened(memoryStore()),
		});
		expect(unconfigured).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_CONNECTION_UNCONFIGURED" },
		});
		const headless = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			interactive: false,
			openStore: opened(memoryStore()),
		});
		expect(headless).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_CONNECTION_NEEDS_OWNER" },
		});
	});

	it("connects end to end through the real connect page", async () => {
		const store = memoryStore();
		const landed: (number | string)[] = [];
		let browsing: Promise<unknown> = Promise.resolve();
		const github = fakeGithub();
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: { ...ENV, HOBO_CONNECT_UI_COMPOSE: "off" },
			interactive: true,
			openStore: opened(store),
			fetch: github.fetch,
			// The scripted owner: choose Infisical, follow GitHub's POST, come back.
			openBrowser: (url) => {
				browsing = (async () => {
					const action = (body: {
						readonly action: string;
						readonly params: Readonly<Record<string, string>>;
					}) =>
						fetch(`${url}action`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}).then((res) => res.json());
					await action({
						action: "connect.chooseStore",
						params: { store: "infisical" },
					});
					const started = await action({ action: "connect.start", params: {} });
					const manifest = JSON.parse(started.directive.fields.manifest);
					const state = new URL(started.directive.url).searchParams.get(
						"state",
					);
					// GitHub's redirect back, then the page the browser lands on.
					const back = await fetch(
						`${manifest.redirect_url}?code=one-time-code&state=${state}`,
						{ redirect: "manual" },
					);
					landed.push(back.status);
					const view = await fetch(`${url}view`).then((res) => res.json());
					landed.push(view.step);
				})().catch((error) => landed.push(`error: ${String(error)}`));
			},
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ id: "github-app", outcome: "created" }],
		});
		expect(store.names()).toContain("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
		// The browser was redirected and then shown the finished step.
		await browsing;
		expect(landed).toEqual([303, "connected"]);
	});
});
