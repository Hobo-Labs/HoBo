import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGithubAppManifest } from "@hobo/ci-gh-actions";
import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { type ConnectPage, startConnectPage } from "@hobo/connect-ui";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	createGithubConnectFlow,
	GITHUB_APP_CREDENTIAL_KEYS,
	type GithubAppHost,
	githubAppConnected,
	type OpenedSecretStore,
	prepareGithubConnection,
	resolveGithubAppHost,
	type SecretStoreOpening,
} from "../src/index.js";

// `hobo ci up`'s GitHub connection: a GitHub App from the reviewed manifest,
// credentials straight into the secret store, idempotent on re-run. GitHub is
// a fake that answers exactly what the real verifier checks; the connect page
// is the real loopback server, driven by a scripted browser.

const RELAY = "https://ci.hobo.example";
const OWNER_ID = 4242;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
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
function fakeGithub(ownerId = OWNER_ID, ownerType = "User"): FakeGithub {
	const calls: string[] = [];
	return {
		calls,
		async fetch(input, init) {
			const url = new URL(String(input));
			const call = `${init?.method ?? "GET"} ${url.pathname}`;
			calls.push(call);
			if (call.startsWith("GET /app")) {
				const bearer = new Headers(init?.headers).get("authorization");
				const parts = bearer?.replace(/^Bearer /u, "").split(".") ?? [];
				if (
					parts.length !== 3 ||
					!parts[2] ||
					!createVerify("RSA-SHA256")
						.update(`${parts[0]}.${parts[1]}`)
						.verify(publicKey, Buffer.from(parts[2], "base64url"))
				)
					return new Response(null, { status: 401 });
			}
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
							owner: { id: ownerId, type: ownerType },
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

async function seedConnection(store: OpenedSecretStore): Promise<void> {
	const values = {
		HOBO_CI_GITHUB_APP_PRIVATE_KEY: PEM,
		HOBO_CI_WEBHOOK_SECRET: "whsec-test",
		HOBO_CI_GITHUB_APP_CLIENT_SECRET: "client-secret-test",
		HOBO_CI_GITHUB_APP_CLIENT_ID: "Iv1.test",
		HOBO_CI_GITHUB_APP_ID: "777",
	};
	for (const key of GITHUB_APP_CREDENTIAL_KEYS)
		await store.port.put(key, values[key]);
}

const opened =
	(store: OpenedSecretStore) => async (): Promise<SecretStoreOpening> => ({
		ok: true,
		store,
	});

describe("createGithubConnectFlow", () => {
	it("does not resolve a GitHub identity when no credentials exist", async () => {
		const store = memoryStore();
		await expect(
			githubAppConnected(store, async () => {
				throw new Error("unexpected lookup");
			}),
		).resolves.toBe(false);
	});
	it("creates the App, deposits every credential (id last), and shows references only", async () => {
		const store = memoryStore();
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
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

	it("reuses a stored App only after checking its live identity and webhook", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
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
		expect(github.calls).toEqual(PACT_CALLS.slice(1));
	});

	it("does not reuse stored credentials for an App owned by another account", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub(9999);
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: github.fetch,
		});
		const result = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(result.step.kind).toBe("failed");
		expect(flow.outcome()).toBeUndefined();
		expect(github.calls).toEqual(["GET /app"]);
		expect(store.names()).toHaveLength(GITHUB_APP_CREDENTIAL_KEYS.length);
	});

	it("checks the stored App's owner kind as well as its numeric ID", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub(OWNER_ID, "Organization");
		const makeFlow = (kind: "User" | "Organization") =>
			createGithubConnectFlow({
				relayUrl: RELAY,
				owner: { kind, login: "octo", id: OWNER_ID },
				callbackUrl: () => "",
				openStore: opened(store),
				fetch: github.fetch,
			});
		const wrong = makeFlow("User");
		expect(
			(
				await wrong.onAction(
					"connect.chooseStore",
					{ store: "infisical" },
					wrong.initial,
				)
			).step.kind,
		).toBe("failed");
		const correct = makeFlow("Organization");
		expect(
			(
				await correct.onAction(
					"connect.chooseStore",
					{ store: "infisical" },
					correct.initial,
				)
			).step.kind,
		).toBe("connected");
	});

	it("refuses a stored App whose webhook points to another relay", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: async (input, init) => {
				if (new URL(String(input)).pathname === "/app/hook/config")
					return Response.json({
						url: "https://other.test/github/webhooks",
						content_type: "json",
						insecure_ssl: "0",
					});
				return github.fetch(input, init);
			},
		});
		const result = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(result.step.kind).toBe("failed");
		expect(flow.outcome()).toBeUndefined();
	});

	it("refuses a stored private key that does not belong to the App", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const { privateKey: otherKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		await store.port.put(
			"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
			otherKey.export({ type: "pkcs1", format: "pem" }).toString(),
		);
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: github.fetch,
		});
		const result = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(result.step.kind).toBe("failed");
		expect(github.calls).toEqual(["GET /app"]);
	});

	it("refuses a secret-store response that contains no material", async () => {
		const store = memoryStore();
		const withoutMaterial: OpenedSecretStore = {
			...store,
			port: {
				...store.port,
				async access() {
					return { status: "ok", valueRef: "fixture", source: "static-escape" };
				},
			},
		};
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
			callbackUrl: () => "",
			openStore: opened(withoutMaterial),
			fetch: github.fetch,
		});
		const result = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(result.step.kind).toBe("failed");
		expect(github.calls).toEqual([]);
	});

	it("refuses partial credentials instead of creating another App", async () => {
		const store = memoryStore();
		await store.port.put("HOBO_CI_GITHUB_APP_ID", "777");
		const github = fakeGithub();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: github.fetch,
		});
		const result = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(result.step).toMatchObject({
			kind: "failed",
			message: "Cannot verify the existing GitHub connection.",
		});
		expect(github.calls).toEqual([]);
		expect(store.names()).toEqual(["HOBO_CI_GITHUB_APP_ID"]);
	});

	it("refuses a callback whose state does not match, storing nothing", async () => {
		const store = memoryStore();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "User", login: "octo", id: OWNER_ID },
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
			owner: { kind: "User", login: "octo", id: OWNER_ID },
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
	it("closes the real setup page if progress or browser launch throws", async () => {
		for (const failure of ["progress", "browser"] as const) {
			const input = prepareInput();
			let page: ConnectPage | undefined;
			const closeGrace: number[] = [];
			try {
				await expect(
					prepareGithubConnection(
						failure === "progress"
							? {
									...input,
									run: {
										...input.run,
										emitProgress: () => {
											throw new Error("progress failed");
										},
									},
								}
							: input,
						{
							env: { ...ENV, HOBO_CONNECT_UI_COMPOSE: "off" },
							interactive: true,
							openStore: opened(memoryStore()),
							startPage: async (options) => {
								page = await startConnectPage(options);
								const started = page;
								return {
									...started,
									async close(options) {
										closeGrace.push(options?.graceMs ?? 0);
										await started.close(options);
									},
								};
							},
							openBrowser: () => {
								throw new Error("browser failed");
							},
						},
					),
				).rejects.toThrow(`${failure} failed`);
				expect(page).toBeDefined();
				expect(closeGrace).toEqual([0]);
				if (page === undefined) throw new Error("page did not start");
				await expect(
					fetch(page.url, { signal: AbortSignal.timeout(1_000) }),
				).rejects.toThrow();
			} finally {
				await page?.close();
			}
		}
	});

	it("reports unchanged without opening a page when the store holds the App", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub();
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			openStore: opened(store),
			fetch: github.fetch,
			startPage: () => {
				throw new Error("no page should open");
			},
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "unchanged" }],
		});
		expect(github.calls).toEqual(PACT_CALLS.slice(1));
	});

	it("refuses to reuse stored credentials when the configured owner differs", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub(9999);
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			openStore: opened(store),
			fetch: github.fetch,
			startPage: () => {
				throw new Error("must not create a replacement");
			},
		});
		expect(outcome).toMatchObject({ kind: "refused" });
		expect(github.calls).toEqual(["GET /app"]);
		expect(store.names()).toHaveLength(GITHUB_APP_CREDENTIAL_KEYS.length);
	});

	it("does not reuse stored credentials without a configured owner and relay", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub();
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: {},
			openStore: opened(store),
			fetch: github.fetch,
			startPage: () => {
				throw new Error("must not create a replacement");
			},
		});
		expect(outcome).toMatchObject({ kind: "refused" });
		expect(github.calls).toEqual([]);
	});

	it("refuses when store access fails instead of opening setup", async () => {
		const store = memoryStore();
		const unavailable: OpenedSecretStore = {
			...store,
			port: {
				...store.port,
				async access() {
					return {
						status: "denied",
						code: "infisical-forbidden",
						reason: "unavailable",
					};
				},
			},
		};
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			openStore: opened(unavailable),
			startPage: () => {
				throw new Error("must not open setup");
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_SECRET_STORE_UNAVAILABLE" },
		});
		expect(store.names()).toEqual([]);
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

describe("organization-owned Apps", () => {
	it("creates the App under the organization and verifies it as the organization's", async () => {
		const store = memoryStore();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "Organization", login: "octo-org", id: OWNER_ID },
			callbackUrl: () => "http://127.0.0.1:1/s/t/callback",
			openStore: opened(store),
			fetch: fakeGithub(OWNER_ID, "Organization").fetch,
			randomState: () => "org-state",
		});
		const chosen = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		const started = await flow.onAction("connect.start", {}, chosen.step);
		expect(started.directive).toMatchObject({
			kind: "post",
			url: "https://github.com/organizations/octo-org/settings/apps/new?state=org-state",
		});
		const done = await flow.onCallback?.(
			new URLSearchParams({ code: "one-time-code", state: "org-state" }),
			started.step,
		);
		expect(done?.step.kind).toBe("connected");
	});

	it("refuses an App GitHub created for a different kind of owner than asked", async () => {
		const store = memoryStore();
		const flow = createGithubConnectFlow({
			relayUrl: RELAY,
			owner: { kind: "Organization", login: "octo-org", id: OWNER_ID },
			callbackUrl: () => "",
			openStore: opened(store),
			fetch: fakeGithub(OWNER_ID, "User").fetch,
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
		expect(done?.step.kind).toBe("failed");
		expect(store.names()).toEqual([]);
	});
});

describe("resolveGithubAppHost", () => {
	const userOnly: GithubAppHost = {
		id: "user-only",
		label: "A user-only host",
		ownerKinds: ["User"],
	};
	const both: GithubAppHost = {
		id: "both",
		label: "A host for both",
		ownerKinds: ["User", "Organization"],
	};
	const org = { kind: "Organization", login: "octo-org", id: 1 } as const;

	it("explains a pinned host that cannot serve the owner and suggests the ones that can", () => {
		const resolution = resolveGithubAppHost(org, {
			configured: "user-only",
			hosts: [userOnly, both],
		});
		expect(resolution).toMatchObject({ ok: false, suggestions: [both] });
		expect(resolution.ok ? "" : resolution.message).toMatch(
			/only supports Apps owned by users.*organization/,
		);
	});

	it("reduces to the host that satisfies the owner when none is pinned", () => {
		expect(
			resolveGithubAppHost(org, { hosts: [userOnly, both] }),
		).toMatchObject({ ok: true, host: both });
	});

	it("HoBo's own hosts serve users and organizations", () => {
		expect(resolveGithubAppHost(org)).toMatchObject({ ok: true });
		expect(resolveGithubAppHost({ ...org, kind: "User" })).toMatchObject({
			ok: true,
		});
	});
});
