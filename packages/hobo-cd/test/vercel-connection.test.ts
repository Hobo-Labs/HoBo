import { readFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath } from "node:url";

import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import type { OpenedSecretStore, SecretStoreOpening } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	cdYard,
	createVercelConnectFlow,
	prepareVercelConnection,
	resolveVercelJunction,
	VERCEL_CLIENT_SECRET_KEY,
	vercelJunction,
} from "../src/index.js";

// `hobo cd up`'s Vercel connection and the Vercel provider junction: the
// integration's code exchanged with a client secret read from the store, the
// token verified and deposited, idempotent on re-run, and the junction joining
// the CD Yard to the Vercel Yard with the credential for one run only.

interface PactInteraction {
	readonly request: { readonly method: string; readonly path: string };
	readonly response: { readonly status: number; readonly body: object };
}

const PACT: { readonly interactions: readonly PactInteraction[] } = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/vercel-integration.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
);
const PACT_CALLS = PACT.interactions.map(
	(i) => `${i.request.method} ${i.request.path}`,
);
const TOKEN = "vercel-token-per-run";

function fakeVercel(userId = "user1") {
	const calls: string[] = [];
	const bodies: string[] = [];
	return {
		calls,
		bodies,
		async fetch(input: string | URL | Request, init?: RequestInit) {
			const url = new URL(String(input));
			const call = `${init?.method ?? "GET"} ${url.pathname}`;
			calls.push(call);
			if (init?.body !== undefined) bodies.push(String(init.body));
			const interaction = PACT.interactions.find(
				(c) => `${c.request.method} ${c.request.path}` === call,
			);
			if (interaction === undefined) return new Response("{}", { status: 404 });
			const declared = interaction.response.body;
			const body = {
				...declared,
				...("access_token" in declared ? { access_token: TOKEN } : undefined),
				...("user" in declared ? { user: { id: userId } } : undefined),
			};
			return new Response(JSON.stringify(body), {
				status: interaction.response.status,
			});
		},
	};
}

async function memoryStore(withSecret = true) {
	const port = createMemorySecretsPort({ id: "memory" });
	if (withSecret)
		await port.put(VERCEL_CLIENT_SECRET_KEY, "integration-client-secret");
	const store: OpenedSecretStore = {
		id: "infisical",
		port,
		reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
	};
	return { store, names: port.names };
}

const opened =
	(store: OpenedSecretStore) => async (): Promise<SecretStoreOpening> => ({
		ok: true,
		store,
	});

function flowWith(store: OpenedSecretStore, fetchImpl: typeof fetch) {
	return createVercelConnectFlow({
		integrationSlug: "hobo-cd",
		clientId: "oac_test",
		redirectUri: "http://127.0.0.1:8792/vercel/callback",
		openStore: opened(store),
		fetch: fetchImpl,
		randomState: () => "state-1",
	});
}

describe("createVercelConnectFlow", () => {
	it("exchanges, verifies and deposits; the page sees references only", async () => {
		const { store, names } = await memoryStore();
		const vercel = fakeVercel();
		const flow = flowWith(store, vercel.fetch);
		const chosen = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(chosen.step.kind).toBe("authorize-vercel");
		const started = await flow.onAction("connect.start", {}, chosen.step);
		expect(started.directive).toEqual({
			kind: "navigate",
			url: "https://vercel.com/integrations/hobo-cd/new?state=state-1",
		});
		const done = await flow.onCallback?.(
			new URLSearchParams({ code: "one-time", state: "state-1" }),
			started.step,
		);
		expect(done?.step.kind).toBe("connected");
		expect(flow.outcome()).toBe("created");
		expect(vercel.calls).toEqual(PACT_CALLS);
		// The client secret came from the store, and went only to the exchange.
		expect(vercel.bodies[0]).toContain(
			"client_secret=integration-client-secret",
		);
		expect(names()).toEqual(
			expect.arrayContaining([
				"HOBO_CD_VERCEL_TOKEN",
				"HOBO_CD_VERCEL_TEAM_ID",
				"HOBO_CD_VERCEL_INSTALLATION_ID",
			]),
		);
		expect(JSON.stringify(done?.step)).not.toContain(TOKEN);
	});

	it("is idempotent: an installed connection finishes unchanged without Vercel", async () => {
		const { store } = await memoryStore();
		await store.port.put("HOBO_CD_VERCEL_INSTALLATION_ID", "icfg_test");
		const vercel = fakeVercel();
		const flow = flowWith(store, vercel.fetch);
		const step = await flow.onAction(
			"connect.chooseStore",
			{ store: "infisical" },
			flow.initial,
		);
		expect(step.step.kind).toBe("connected");
		expect(flow.outcome()).toBe("unchanged");
		expect(vercel.calls).toEqual([]);
	});

	it("refuses a forged state, a missing integration secret, and a token for someone else", async () => {
		for (const [secret, userId, state, expected] of [
			[true, "user1", "forged", /did not match/],
			[false, "user1", "state-1", /integration secret is not in/],
			[true, "someone-else", "state-1", /did not verify/],
		] as const) {
			const { store, names } = await memoryStore(secret);
			const flow = flowWith(store, fakeVercel(userId).fetch);
			const chosen = await flow.onAction(
				"connect.chooseStore",
				{ store: "infisical" },
				flow.initial,
			);
			const started = await flow.onAction("connect.start", {}, chosen.step);
			const done = await flow.onCallback?.(
				new URLSearchParams({ code: "one-time", state }),
				started.step,
			);
			expect(JSON.stringify(done?.step)).toMatch(expected);
			expect(
				names().filter(
					(n) =>
						n.startsWith("HOBO_CD_VERCEL_") && n !== VERCEL_CLIENT_SECRET_KEY,
				),
			).toEqual([]);
		}
	});
});

describe("the Vercel provider junction", () => {
	it("joins the CD Yard to a Vercel Yard; neither marks anything external", () => {
		const definition = vercelJunction("team_test");
		expect(definition.yards.map((y) => [y.name, y.providerId])).toEqual([
			[cdYard.name, "local"],
			["hobo-cd-vercel", "vercel"],
		]);
	});

	it("resolves the credential for one run from the store", async () => {
		const { store } = await memoryStore();
		await store.port.put("HOBO_CD_VERCEL_TOKEN", TOKEN);
		await store.port.put("HOBO_CD_VERCEL_TEAM_ID", "team_test");
		const resolved = await resolveVercelJunction(store);
		expect(resolved).toMatchObject({
			ok: true,
			runtimeEnv: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_test" },
		});
	});
});

function prepareInput(whatIf = false): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress"> = {
		emitProgress: () => undefined,
	};
	// SAFETY: prepareVercelConnection reads only run.emitProgress.
	return {
		action: "up",
		projectDir: "/tmp/hobo-cd",
		whatIf,
		yes: false,
		run: run as CommandRunInput,
	};
}

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: listen() on a TCP host and port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

describe("prepareVercelConnection", () => {
	it("hands an existing connection's credential to convergence without a page", async () => {
		const { store } = await memoryStore();
		await store.port.put("HOBO_CD_VERCEL_TOKEN", TOKEN);
		await store.port.put("HOBO_CD_VERCEL_INSTALLATION_ID", "icfg_test");
		const outcome = await prepareVercelConnection(prepareInput(), {
			env: {},
			openStore: opened(store),
			startPage: () => {
				throw new Error("no page should open");
			},
		});
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ id: "vercel", outcome: "unchanged" }],
			runtimeEnv: { VERCEL_TOKEN: TOKEN },
		});
	});

	it("opens nothing for --what-if and refuses when unconfigured", async () => {
		const { store } = await memoryStore();
		expect(
			await prepareVercelConnection(prepareInput(true), {
				env: {},
				openStore: opened(store),
			}),
		).toMatchObject({ kind: "ready", steps: [{ outcome: "would-create" }] });
		expect(
			await prepareVercelConnection(prepareInput(), {
				env: {},
				openStore: opened(store),
			}),
		).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_CONNECTION_UNCONFIGURED" },
		});
	});

	it("connects end to end through the real page on the Integration's fixed Redirect URL", async () => {
		const { store } = await memoryStore();
		const vercel = fakeVercel();
		const port = await freePort();
		let browsing: Promise<unknown> = Promise.resolve();
		const landed: (number | string)[] = [];
		const outcome = await prepareVercelConnection(prepareInput(), {
			env: {
				HOBO_CD_VERCEL_INTEGRATION: "hobo-cd",
				HOBO_CD_VERCEL_CLIENT_ID: "oac_test",
				HOBO_CD_VERCEL_REDIRECT_URI: `http://127.0.0.1:${port}/vercel/callback`,
				HOBO_CONNECT_UI_COMPOSE: "off",
			},
			interactive: true,
			openStore: opened(store),
			fetch: vercel.fetch,
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
					const state = new URL(started.directive.url).searchParams.get(
						"state",
					);
					// Vercel redirects to the registered URL, not the session path.
					const back = await fetch(
						`http://127.0.0.1:${port}/vercel/callback?code=one-time&state=${state}`,
						{ redirect: "manual" },
					);
					landed.push(back.status);
					landed.push(
						(await fetch(`${url}view`).then((res) => res.json())).step,
					);
				})();
			},
		});
		await browsing;
		expect(outcome).toMatchObject({
			kind: "ready",
			steps: [{ id: "vercel", outcome: "created" }],
			runtimeEnv: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_test" },
		});
		expect(landed).toEqual([303, "connected"]);
	});
});
