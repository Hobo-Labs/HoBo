import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import {
	type CommandRunInput,
	createHoboCli,
	createLifecycleFamilyCommand,
	type PrepareInput,
} from "@hobo/cli";
import {
	type ConnectPage,
	type FlowTransition,
	type SavedSettings,
	startConnectPage,
} from "@hobo/connect-ui";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	createGithubConnectFlow,
	familySettings,
	GITHUB_APP_CREDENTIAL_KEYS,
	type GithubAppHost,
	githubAppConnected,
	loadGithubAppCredentials,
	type OpenedSecretStore,
	prepareGithubConnection,
	resolveGithubAppExpectation,
	resolveGithubAppHost,
	type SecretStoreOpening,
} from "../src/index.js";
import { pactGithub } from "./support/fake-github.js";

// `hobo ci up`'s GitHub connection: a GitHub App from the reviewed manifest,
// credentials straight into the secret store, idempotent on re-run. GitHub is
// a fake that answers exactly what the real verifier checks; the connect page
// is the real loopback server, driven by a scripted browser.

const RELAY = "https://ci.hobo.example";
const OWNER_ID = 4242;
const { PEM, PACT_CALLS, fakeGithub } = pactGithub(RELAY, OWNER_ID);

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

async function seedSettings(store: OpenedSecretStore): Promise<void> {
	await store.port.put(
		"HOBO_CI_SETTINGS",
		JSON.stringify({
			HOBO_CI_PUBLIC_URL: RELAY,
			HOBO_CI_GITHUB_OWNER: "octo",
		}),
	);
}

const opened =
	(store: OpenedSecretStore) => async (): Promise<SecretStoreOpening> => ({
		ok: true,
		store,
	});

describe("createGithubConnectFlow", () => {
	it("resolves an existing App's configured owner and relay without looking up incomplete settings", async () => {
		const calls: string[] = [];
		const lookup: typeof fetch = async (input) => {
			calls.push(String(input));
			return Response.json({
				id: OWNER_ID,
				type: "Organization",
				login: "octo",
			});
		};
		expect(await resolveGithubAppExpectation({}, {}, lookup)).toBeUndefined();
		expect(calls).toEqual([]);
		const expected = await resolveGithubAppExpectation(
			{ HOBO_CI_PUBLIC_URL: RELAY, HOBO_CI_GITHUB_OWNER: "octo" },
			{},
			lookup,
		);
		expect(expected).toMatchObject({
			relayUrl: RELAY,
			ownerId: OWNER_ID,
			ownerType: "Organization",
		});
		expect(calls).toEqual(["https://api.github.com/users/octo"]);
	});
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
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: (message: string) => {
			progress.push(message);
		},
		// SAFETY: the preparation fixture reads only these two output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	return {
		action: "up",
		projectDir: "/tmp/hobo-ci",
		whatIf,
		yes: false,
		// SAFETY: prepareGithubConnection reads only progress and these output flags.
		run: run as CommandRunInput,
		progress,
	};
}

// Non-secret pins only: the owner's id and kind skip the users lookup.
const ENV = {
	HOBO_CI_GITHUB_OWNER_ID: String(OWNER_ID),
	HOBO_CI_GITHUB_OWNER_TYPE: "User",
};

/** The locator of a store set up to sign in with a token typed on the page. */
const LOCATOR = {
	HOBO_SECRET_STORE: "infisical",
	INFISICAL_PROJECT_ID: "proj",
	INFISICAL_SIGN_IN: "typed",
};

function memorySettings(initial: SavedSettings = {}) {
	let saved: SavedSettings = { ...initial };
	return {
		saved: () => saved,
		read: async () => saved,
		write: async (values: Readonly<Record<string, string>>) => {
			saved = { ...values };
		},
	};
}

/** An opener that holds the store only for the right sign-in. */
function signedIn(store: OpenedSecretStore, token = "session-token") {
	return async (
		_id: string,
		_coordinates: Readonly<Record<string, string | undefined>>,
		signIn: { reveal(name: string): string | undefined },
	) =>
		signIn.reveal("INFISICAL_TOKEN") === token
			? ({ ok: true, store } as const)
			: ({
					ok: false,
					message: "Not signed in to Infisical.",
					remediation: ["Enter a token."],
				} as const);
}

// GitHub, answering the public users lookup as well as the pact.
function githubWithUsers(kind: "User" | "Organization") {
	const pactGithub = fakeGithub(OWNER_ID, kind);
	return {
		calls: pactGithub.calls,
		// SAFETY: the stand-in implements the one fetch overload the flow calls.
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname.startsWith("/users/"))
				return new Response(
					JSON.stringify({
						id: OWNER_ID,
						type: kind,
						login: url.pathname.slice(7),
					}),
				);
			return pactGithub.fetch(input, init);
		}) as typeof fetch,
	};
}

describe("prepareGithubConnection", () => {
	it("reports a silent hand-off through the CLI instead of waiting for a hidden page", async () => {
		const unused = {
			run: async () => {
				throw new Error("a refused hand-off must not converge");
			},
		};
		const cli = createHoboCli({
			commands: {
				ci: createLifecycleFamilyCommand({
					family: "ci",
					resolveProject: () => ({
						ok: true,
						projectDir: tmpdir(),
						source: "test",
					}),
					up: unused,
					down: unused,
					plan: unused,
					prepare: (input) =>
						prepareGithubConnection(input, {
							env: {},
							fetch: async () => new Response(null, { status: 401 }),
							locator: memorySettings({
								HOBO_SECRET_STORE: "infisical",
							}),
							startPage: () => {
								throw new Error("the silent page must not be started");
							},
						}),
				}),
			},
		});
		for (const mode of ["--json", "-q"]) {
			const progress: string[] = [];
			const result = await cli.run(["ci", "up", "--hand-off", mode], {
				cwd: tmpdir(),
				onProgress: (message) => progress.push(message),
			});
			expect(result.exitCode).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"The owner hand-off needs progress output",
			);
			expect(progress).toEqual([]);
		}
	});

	it("refuses a silent owner hand-off before starting the page", async () => {
		for (const mode of ["json", "quiet"] as const) {
			const input = prepareInput();
			const outcome = await prepareGithubConnection(
				{
					...input,
					handOff: true,
					run: { ...input.run, flags: { ...input.run.flags, [mode]: true } },
				},
				{
					env: {},
					fetch: async () => new Response(null, { status: 401 }),
					locator: memorySettings({
						HOBO_SECRET_STORE: "infisical",
					}),
					startPage: () => {
						throw new Error("the silent page must not be started");
					},
				},
			);
			expect(outcome).toMatchObject({
				kind: "refused",
				result: { code: "HOBO_CI_HANDOFF_SILENT" },
			});
		}
	});
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
							locator: memorySettings(LOCATOR),
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

	it("uses a configured Bitwarden store to find an existing connection", async () => {
		const store = { ...memoryStore(), id: "bitwarden" as const };
		await seedConnection(store);
		await seedSettings(store);
		const github = fakeGithub();
		const vault = createTrustedVault();
		vault.put("BWS_ACCESS_TOKEN", "token");
		let selected = "";
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			vault,
			locator: memorySettings({
				HOBO_SECRET_STORE: "bitwarden",
				BWS_ORGANIZATION_ID: "org",
				BWS_PROJECT_ID: "project",
			}),
			fetch: github.fetch,
			openStore: async (id, _coordinates, signIn) => {
				selected = id;
				expect(signIn.reveal("BWS_ACCESS_TOKEN")).toBe("token");
				return { ok: true, store };
			},
			startPage: () => {
				throw new Error("no page should open");
			},
		});
		expect(selected).toBe("bitwarden");
		expect(github.calls).toEqual(PACT_CALLS.slice(1));
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "unchanged" }],
		});
	});

	it("refuses an unknown configured or saved store before opening it", async () => {
		for (const [env, saved] of [
			[{ ...ENV, HOBO_SECRET_STORE: "unknown" }, {}],
			[ENV, { HOBO_SECRET_STORE: "unknown" }],
		] as const) {
			let openedStore = false;
			const outcome = await prepareGithubConnection(prepareInput(), {
				env,
				locator: memorySettings(saved),
				openStore: async () => {
					openedStore = true;
					throw new Error("unexpected store access");
				},
			});
			expect(outcome).toMatchObject({
				kind: "refused",
				result: { code: "HOBO_CI_SECRET_STORE_INVALID" },
			});
			expect(openedStore).toBe(false);
		}
	});

	it("refuses an unimplemented pinned host before opening a store", async () => {
		let openedStore = false;
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: { ...ENV, HOBO_CI_APP_HOST: "hosted-relay" },
			openStore: async () => {
				openedStore = true;
				throw new Error("unexpected store access");
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_APP_HOST_UNSUPPORTED_OWNER" },
		});
		expect(openedStore).toBe(false);
	});

	it("refuses partial credentials without opening setup", async () => {
		const store = memoryStore();
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		await store.port.put("HOBO_CI_GITHUB_APP_ID", "777");
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			vault,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
			startPage: () => {
				throw new Error("must not open setup");
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_SECRET_STORE_UNAVAILABLE" },
		});
		expect(vault.names()).toEqual([]);
	});

	it("reuses a verified connection even when a hand-off would be silent", async () => {
		const store = memoryStore();
		await seedConnection(store);
		await seedSettings(store);
		const github = fakeGithub();
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		const input = prepareInput();
		const outcome = await prepareGithubConnection(
			{
				...input,
				handOff: true,
				run: { ...input.run, flags: { ...input.run.flags, json: true } },
			},
			{
				env: ENV,
				vault,
				locator: memorySettings(LOCATOR),
				openStore: signedIn(store),
				fetch: github.fetch,
				startPage: () => {
					throw new Error("must not open setup");
				},
			},
		);
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "unchanged" }],
		});
		expect(github.calls).toEqual(PACT_CALLS.slice(1));
	});

	it("refuses to reuse stored credentials when the configured owner differs", async () => {
		const store = memoryStore();
		await seedConnection(store);
		await seedSettings(store);
		const github = fakeGithub(9999);
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			vault,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
			fetch: github.fetch,
			startPage: () => {
				throw new Error("must not create a replacement");
			},
		});
		expect(outcome).toMatchObject({ kind: "refused" });
		expect(github.calls).toEqual(["GET /app"]);
		expect(store.names()).toHaveLength(GITHUB_APP_CREDENTIAL_KEYS.length + 1);
	});

	it("does not reuse stored credentials without a configured owner and relay", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const github = fakeGithub();
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: {},
			vault,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
			fetch: github.fetch,
			startPage: () => {
				throw new Error("must not create a replacement");
			},
		});
		expect(outcome).toMatchObject({ kind: "refused" });
		expect(github.calls).toEqual([]);
	});

	it("does not treat an unreadable settings entry as missing", async () => {
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
		await expect(familySettings(unavailable, "ci").read()).rejects.toThrow(
			/Cannot read/,
		);
	});

	it("does not treat corrupt saved settings as missing", async () => {
		const store = memoryStore();
		await store.port.put("HOBO_CI_SETTINGS", "{not-json");
		await expect(familySettings(store, "ci").read()).rejects.toThrow(/invalid/);
	});

	it("reports unchanged without a page when this run's vault already signs in", async () => {
		const store = memoryStore();
		await seedConnection(store);
		await seedSettings(store);
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			fetch: fakeGithub().fetch,
			vault,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
			startPage: () => {
				throw new Error("no page should open");
			},
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "unchanged" }],
		});
		expect(vault.names()).toEqual([]);
	});

	it("wipes the setup vault if reading the locator throws", async () => {
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		await expect(
			prepareGithubConnection(prepareInput(), {
				env: {},
				vault,
				locator: {
					read: async () => {
						throw new Error("locator unavailable");
					},
					write: async () => {},
				},
			}),
		).rejects.toThrow("locator unavailable");
		expect(vault.names()).toEqual([]);
	});

	it("rejects a late sign-in after setup has already ended", async () => {
		const vault = createTrustedVault();
		let submitLate: (() => Promise<FlowTransition>) | undefined;
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: {},
			interactive: true,
			vault,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(memoryStore()),
			openBrowser: () => undefined,
			startPage: async ({ flow }) => {
				submitLate = () =>
					flow.onAction(
						"connect.submit",
						{ INFISICAL_TOKEN: "session-token" },
						flow.initial,
					);
				return {
					url: "http://127.0.0.1:1/",
					callbackUrl: "http://127.0.0.1:1/callback",
					done: Promise.resolve({
						kind: "failed" as const,
						provider: "github" as const,
						message: "cancelled",
						remediation: [],
					}),
					close: async () => {},
				};
			},
		});
		expect(outcome.kind).toBe("refused");
		if (submitLate === undefined) throw new Error("setup page did not start");
		await expect(submitLate()).rejects.toThrow("credential run has ended");
		expect(vault.names()).toEqual([]);
	});

	it("hands the Vercel connection hobo cd up keeps in the store to the relay deploy", async () => {
		const store = memoryStore();
		await seedConnection(store);
		await seedSettings(store);
		await store.port.put("HOBO_CD_VERCEL_TOKEN", "vercel-token");
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			fetch: fakeGithub().fetch,
			vault,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
		});
		// Only the deploy's connection is handed on; the store sign-in ended with prepare.
		expect(outcome.kind === "ready" && outcome.credentials?.names()).toEqual([
			"VERCEL_TOKEN",
		]);
		expect(
			outcome.kind === "ready" && outcome.credentials?.reveal("VERCEL_TOKEN"),
		).toBe("vercel-token");
	});

	it("ignores secrets in the environment, and says so", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const input = prepareInput(true);
		const outcome = await prepareGithubConnection(input, {
			// A token in the environment is not a sign-in.
			env: { ...ENV, INFISICAL_TOKEN: "session-token", BWS_ACCESS_TOKEN: "x" },
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "would-create" }],
		});
		expect(JSON.stringify(outcome)).toMatch(/would sign in to infisical/);
		// INFISICAL_TOKEN is ignored; the Bitwarden access token is the store's
		// own sign-in, adopted into the vault, so it is not reported as ignored.
		expect(input.progress.join("\n")).toMatch(
			/Setup ignored these known secret environment variables: INFISICAL_TOKEN\./,
		);
	});

	it("without a person at a browser, refuses and points at the owner's store session, never a coordinate variable", async () => {
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: {},
			interactive: false,
			locator: memorySettings(),
			openStore: signedIn(memoryStore()),
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_CONNECTION_NEEDS_OWNER" },
		});
		expect(JSON.stringify(outcome)).toContain("choose_secret_store");
		expect(JSON.stringify(outcome)).not.toContain("INFISICAL_IDENTITY_ID");
		expect(JSON.stringify(outcome)).not.toContain("HOBO_OWNER_PAGE");
	});

	it("a CI run signs in with its own OIDC token through the preconfigured identity", async () => {
		const store = memoryStore();
		await seedConnection(store);
		await seedSettings(store);
		let signedInWith: Readonly<Record<string, string | undefined>> = {};
		const outcome = await prepareGithubConnection(prepareInput(), {
			fetch: fakeGithub().fetch,
			env: {
				...ENV,
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request",
			},
			interactive: false,
			locator: memorySettings({ ...LOCATOR, INFISICAL_IDENTITY_ID: "id-1" }),
			openStore: async (_id, coordinates) => {
				signedInWith = coordinates;
				return { ok: true, store };
			},
		});
		expect(signedInWith.INFISICAL_IDENTITY_ID).toBe("id-1");
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ outcome: "unchanged" }],
		});
	});

	it("a fresh devbox: signs in, asks once, keeps answers in the store and only the locator on disk", async () => {
		const store = memoryStore();
		const locator = memorySettings();
		const github = githubWithUsers("Organization");
		const seen: string[] = [];
		let browsing: Promise<unknown> = Promise.resolve();
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: {},
			interactive: true,
			locator,
			fetch: github.fetch,
			openStore: signedIn(store),
			openBrowser: (url) => {
				browsing = (async () => {
					const post = (action: string, params: Record<string, string> = {}) =>
						fetch(`${url}action`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ action, params }),
						}).then((res) => res.json());
					const fields = (view: { view: { fields: { name: string }[] } }) =>
						view.view.fields.map((f) => f.name).join(",");
					seen.push(
						fields(await fetch(`${url}view`).then((res) => res.json())),
					);
					seen.push(
						fields(
							await post("connect.submit", { HOBO_SECRET_STORE: "infisical" }),
						),
					);
					seen.push(
						fields(
							await post("connect.submit", {
								INFISICAL_PROJECT_ID: "proj",
								INFISICAL_TOKEN: "session-token",
							}),
						),
					);
					const create = await post("connect.submit", {
						HOBO_CI_PUBLIC_URL: RELAY,
						HOBO_CI_GITHUB_OWNER: "octo-org",
					});
					seen.push(create.step);
					const started = await post("connect.start");
					seen.push(started.directive.url.replace(/\?.*/, ""));
					const manifest = JSON.parse(started.directive.fields.manifest);
					const state = new URL(started.directive.url).searchParams.get(
						"state",
					);
					await fetch(
						`${manifest.redirect_url}?code=one-time-code&state=${state}`,
						{
							redirect: "manual",
						},
					);
					seen.push((await fetch(`${url}view`).then((res) => res.json())).step);
				})();
			},
		});
		await browsing;
		expect(seen).toEqual([
			"HOBO_SECRET_STORE",
			"INFISICAL_PROJECT_ID,INFISICAL_TOKEN",
			"HOBO_CI_PUBLIC_URL,HOBO_CI_GITHUB_OWNER",
			"create-github-app",
			"https://github.com/organizations/octo-org/settings/apps/new",
			"connected",
		]);
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ id: "github-app", outcome: "created" }],
		});
		// In the owner's settings: where the store is. Never the token.
		expect(locator.saved()).toEqual({
			HOBO_SECRET_STORE: "infisical",
			INFISICAL_PROJECT_ID: "proj",
		});
		// In the store: what the ceremony was told, beside the App.
		const kept = await store.port.access("HOBO_CI_SETTINGS");
		expect(kept.status === "ok" && JSON.parse(kept.material ?? "{}")).toEqual({
			HOBO_CI_PUBLIC_URL: RELAY,
			HOBO_CI_GITHUB_OWNER: "octo-org",
		});
	});

	it("a destroyed devbox: a new clone signs in and is asked nothing else", async () => {
		const store = memoryStore();
		await store.port.put(
			"HOBO_CI_SETTINGS",
			JSON.stringify({
				HOBO_CI_PUBLIC_URL: RELAY,
				HOBO_CI_GITHUB_OWNER: "octo",
			}),
		);
		const seen: string[] = [];
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: ENV,
			interactive: true,
			timeoutMs: 2_000,
			locator: memorySettings(LOCATOR),
			openStore: signedIn(store),
			openBrowser: (url) => {
				void (async () => {
					const first = await fetch(`${url}view`).then((res) => res.json());
					seen.push(
						first.view.fields.map((f: { name: string }) => f.name).join(","),
					);
					const next = await fetch(`${url}action`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "connect.submit",
							params: { INFISICAL_TOKEN: "session-token" },
						}),
					}).then((res) => res.json());
					seen.push(next.step);
					await fetch(`${url}action`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "connect.cancel", params: {} }),
					});
					await fetch(`${url}view`);
				})();
			},
		});
		// Only the sign-in is asked; the relay URL and owner came from the store.
		expect(seen[0]).toBe("INFISICAL_TOKEN");
		expect(seen[1]).toBe("create-github-app");
		expect(outcome).toMatchObject({ kind: "refused" });
	});

	it("refuses an owner GitHub does not know, on the page, without creating anything", async () => {
		const store = memoryStore();
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "session-token");
		// SAFETY: the stand-in implements the one fetch overload the lookup calls.
		const notFound = (async () =>
			new Response("{}", { status: 404 })) as typeof fetch;
		let errorShown = "";
		const outcome = await prepareGithubConnection(prepareInput(), {
			env: {},
			interactive: true,
			vault,
			locator: memorySettings(LOCATOR),
			fetch: notFound,
			timeoutMs: 2_000,
			openStore: signedIn(store),
			openBrowser: (url) => {
				void (async () => {
					const refused = await fetch(`${url}action`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "connect.submit",
							params: {
								HOBO_CI_PUBLIC_URL: RELAY,
								HOBO_CI_GITHUB_OWNER: "nobody-here",
							},
						}),
					}).then((res) => res.json());
					errorShown = refused.view.fields.find(
						(f: { name: string }) => f.name === "HOBO_CI_GITHUB_OWNER",
					).error;
					await fetch(`${url}action`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "connect.cancel", params: {} }),
					});
					await fetch(`${url}view`);
				})();
			},
		});
		expect(errorShown).toMatch(/no user or organization/);
		expect(outcome).toMatchObject({ kind: "refused" });
		expect((await store.port.access("HOBO_CI_SETTINGS")).status).not.toBe("ok");
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

describe("loadGithubAppCredentials", () => {
	it("loads exactly the values verified, and does nothing for an empty store", async () => {
		const store = memoryStore();
		const empty = createTrustedVault();
		let resolved = false;
		expect(
			await loadGithubAppCredentials(store, empty, async () => {
				resolved = true;
				return undefined;
			}),
		).toBe(false);
		expect(resolved).toBe(false);
		expect(empty.names()).toEqual([]);
		await seedConnection(store);
		const accesses = new Map<string, number>();
		const tracked: OpenedSecretStore = {
			...store,
			port: {
				...store.port,
				async access(key) {
					accesses.set(key, (accesses.get(key) ?? 0) + 1);
					return store.port.access(key);
				},
			},
		};
		const github = fakeGithub();
		const vault = createTrustedVault();
		expect(
			await loadGithubAppCredentials(tracked, vault, async () => ({
				relayUrl: RELAY,
				ownerId: OWNER_ID,
				ownerType: "User",
				fetch: github.fetch,
			})),
		).toBe(true);
		for (const key of GITHUB_APP_CREDENTIAL_KEYS) {
			expect(accesses.get(key)).toBe(1);
			const result = await store.port.access(key);
			expect(vault.reveal(key)).toBe(
				result.status === "ok" ? result.material : undefined,
			);
		}
		expect(github.calls).toEqual(PACT_CALLS.slice(1));
	});

	it("refuses a partial connection", async () => {
		const store = memoryStore();
		await store.port.put("HOBO_CI_GITHUB_APP_ID", "1");
		await expect(
			loadGithubAppCredentials(store, createTrustedVault()),
		).rejects.toThrow(/incomplete/);
	});

	it("does not load an App without a matching owner and relay", async () => {
		const store = memoryStore();
		await seedConnection(store);
		const vault = createTrustedVault();
		await expect(loadGithubAppCredentials(store, vault)).rejects.toThrow(
			/identity/,
		);
		const github = fakeGithub(9999);
		await expect(
			loadGithubAppCredentials(store, vault, async () => ({
				relayUrl: RELAY,
				ownerId: OWNER_ID,
				ownerType: "User",
				fetch: github.fetch,
			})),
		).rejects.toThrow();
		expect(vault.names()).toEqual([]);
		expect(github.calls).toEqual(["GET /app"]);
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
