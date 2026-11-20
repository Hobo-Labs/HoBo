import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import type { SavedSettings } from "@hobo/connect-ui";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	APP_HANDOFF_PAGE,
	GITHUB_APP_CODE_CAPTURE,
	GITHUB_APP_CREDENTIAL_KEYS,
	type OpenedSecretStore,
	prepareGithubConnection,
} from "../../src/index.js";
import { pactGithub } from "../support/fake-github.js";
import {
	driveRemoteOwner,
	heldOwnerChannel,
	ownerLines,
	readOwnerTurn,
} from "../support/remote-owner.js";

// SPEC: hobo ci up --hand-off creates the GitHub App for a remote owner.
// They open HoBo's static page on any device, click Create GitHub App on
// GitHub with their own account, and hand the code the page shows back in
// the HoBo MCP App's form; the next run redeems it. Each step is failed in
// turn; the owner must always end ready or with something they can do.

const RELAY = "https://ci.hobo.example";
const OWNER_ID = 4242;
const { fakeGithub } = pactGithub(RELAY, OWNER_ID);

function handOff(lines: string[]): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: (line) => lines.push(line),
		// SAFETY: the preparation fixture reads only these two output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	return {
		action: "up",
		projectDir: "/tmp/hobo-remote-app",
		whatIf: false,
		yes: false,
		handOff: true,
		// SAFETY: prepareGithubConnection reads only progress and these output flags.
		run: run as CommandRunInput,
	};
}

function memoryStore() {
	const port = createMemorySecretsPort({ id: "memory" });
	const store: OpenedSecretStore = {
		id: "infisical",
		port,
		reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
	};
	return { store, names: port.names };
}

/** The owner's HoBo settings file, in memory. */
function memoryLocator() {
	let saved: SavedSettings = {
		HOBO_SECRET_STORE: "infisical",
		INFISICAL_PROJECT_ID: "proj",
	};
	return {
		read: async () => saved,
		write: async (next: SavedSettings) => {
			saved = next;
		},
		now: () => saved,
	};
}

/** GitHub: the pact's App endpoints, plus the owner's account lookup. */
function github(ownerId = OWNER_ID) {
	const fake = fakeGithub(ownerId);
	const send: typeof fetch = async (input, init) =>
		new URL(String(input)).pathname === "/users/octo"
			? Response.json({ id: OWNER_ID, type: "User", login: "octo" })
			: fake.fetch(input, init);
	return { ...fake, fetch: send };
}

async function remoteCi(
	options: { ownerId?: number; settings?: boolean } = {},
) {
	const { store, names } = memoryStore();
	if (options.settings !== false)
		await store.port.put(
			"HOBO_CI_SETTINGS",
			JSON.stringify({
				HOBO_CI_PUBLIC_URL: RELAY,
				HOBO_CI_GITHUB_OWNER: "octo",
			}),
		);
	const locator = memoryLocator();
	const owner = heldOwnerChannel();
	const api = github(options.ownerId);
	const run = async () => {
		const progress: string[] = [];
		const outcome = await prepareGithubConnection(handOff(progress), {
			env: { CLAUDE_CODE_REMOTE: "true", INFISICAL_SIGN_IN: "egress-proxy" },
			locator,
			openStore: async () => ({ ok: true, store }),
			ownerChannel: owner,
			fetch: api.fetch,
			startPage: () => {
				throw new Error("a handed-off run serves no page on the box");
			},
		});
		return {
			ready: outcome.kind === "ready",
			lines: ownerLines(outcome, progress),
		};
	};
	return { store, names, locator, owner, api, run };
}

/**
 * The owner's browser on their own device: the hand-off page posts the
 * manifest to GitHub, the owner creates the App, and GitHub returns to the
 * page with its code, which the page shows as `code~state`.
 */
function createsTheApp(
	owner: ReturnType<typeof heldOwnerChannel>,
	edit: (shown: string) => string = (shown) => shown,
) {
	return async (url: URL, capture: string) => {
		expect(`${url.origin}${url.pathname}`).toBe(APP_HANDOFF_PAGE);
		expect(capture).toBe(GITHUB_APP_CODE_CAPTURE);
		const fragment = new URLSearchParams(url.hash.slice(1));
		const action = new URL(fragment.get("action") ?? "");
		expect(action.origin).toBe("https://github.com");
		// GitHub sends the browser back where the manifest says: the same page.
		const manifest = JSON.parse(fragment.get("manifest") ?? "{}");
		expect(manifest.redirect_url).toBe(APP_HANDOFF_PAGE);
		const state = action.searchParams.get("state") ?? "";
		owner.deposit(capture, edit(`one-time-code~${state}`));
	};
}

describe("SPEC remote GitHub App: created from the owner's own browser", () => {
	it("happy path: one link, one code, then the App's credentials are in the store", async () => {
		const ci = await remoteCi();
		const result = await driveRemoteOwner({
			run: ci.run,
			hands: { signIn: createsTheApp(ci.owner) },
		});
		expect(result).toMatchObject({ kind: "ready", trail: ["sign-in"] });
		for (const key of GITHUB_APP_CREDENTIAL_KEYS)
			expect(ci.names()).toContain(key);
		// The nonce is gone once used.
		expect(ci.locator.now().HOBO_CI_GITHUB_APP_STATE).toBeUndefined();
	});

	it("the owner pastes something else: the same link again, then ready", async () => {
		const ci = await remoteCi();
		let pastes = 0;
		const result = await driveRemoteOwner({
			run: ci.run,
			hands: {
				signIn: createsTheApp(ci.owner, (shown) => {
					pastes += 1;
					return pastes === 1 ? "ghp_not-a-code" : shown;
				}),
			},
		});
		expect(result).toMatchObject({ kind: "ready" });
	});

	it("a code from another run (state mismatch) is refused, nothing stored, and a new link recovers", async () => {
		const ci = await remoteCi();
		let pastes = 0;
		const result = await driveRemoteOwner({
			run: ci.run,
			hands: {
				signIn: async (url, capture) => {
					pastes += 1;
					if (pastes === 1)
						ci.owner.deposit(capture, "one-time-code~someone-elses-state");
					else await createsTheApp(ci.owner)(url, capture);
				},
			},
		});
		expect(result).toMatchObject({ kind: "ready" });
	});

	it("the MCP server restarts after the hand-over: the link (and its state) still work", async () => {
		const ci = await remoteCi();
		let restarted = false;
		const result = await driveRemoteOwner({
			run: ci.run,
			hands: {
				signIn: async (url, capture) => {
					await createsTheApp(ci.owner)(url, capture);
					if (!restarted) {
						restarted = true;
						ci.owner.restart();
					}
				},
			},
		});
		expect(result).toMatchObject({ kind: "ready" });
	});

	it("a spent code (redeemed already) is refused with something the owner can do", async () => {
		const ci = await remoteCi();
		await ci.run();
		// Someone redeemed it first (a replay).
		await ci.api.fetch(
			"https://api.github.com/app-manifests/one-time-code/conversions",
			{ method: "POST" },
		);
		const state = ci.locator.now().HOBO_CI_GITHUB_APP_STATE ?? "";
		ci.owner.deposit(GITHUB_APP_CODE_CAPTURE, `one-time-code~${state}`);
		const turn = await ci.run();
		expect(turn.ready).toBe(false);
		expect(readOwnerTurn(false, turn.lines).kind).toBe("act");
		expect(ci.names()).not.toContain("HOBO_CI_GITHUB_APP_ID");
	});

	it("an App that does not match the reviewed configuration is discarded, with a way out", async () => {
		const ci = await remoteCi({ ownerId: 9999 });
		await ci.run();
		const state = ci.locator.now().HOBO_CI_GITHUB_APP_STATE ?? "";
		ci.owner.deposit(GITHUB_APP_CODE_CAPTURE, `one-time-code~${state}`);
		const turn = await ci.run();
		expect(turn.ready).toBe(false);
		expect(turn.lines.join("\n")).toMatch(
			/Delete it at https:\/\/github\.com/u,
		);
		expect(readOwnerTurn(false, turn.lines).kind).toBe("act");
		expect(ci.names()).not.toContain("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
	});

	it("a link older than GitHub's hour is replaced, never reused", async () => {
		const ci = await remoteCi();
		await ci.run();
		const first = ci.locator.now().HOBO_CI_GITHUB_APP_STATE;
		await ci.locator.write({
			...ci.locator.now(),
			HOBO_CI_GITHUB_APP_STATE_AT: String(Date.now() - 2 * 60 * 60_000),
		});
		await ci.run();
		expect(ci.locator.now().HOBO_CI_GITHUB_APP_STATE).not.toBe(first);
	});

	it("missing relay and owner settings are asked for in the HoBo form, then the App is created", async () => {
		const ci = await remoteCi({ settings: false });
		const result = await driveRemoteOwner({
			run: ci.run,
			hands: {
				capture: async (name) => {
					ci.owner.deposit(
						name,
						name === "HOBO_CI_PUBLIC_URL" ? RELAY : "octo",
					);
				},
				signIn: createsTheApp(ci.owner),
			},
		});
		expect(result).toMatchObject({
			kind: "ready",
			trail: ["capture", "sign-in"],
		});
	});

	it("with no owner channel (a plain CLI run), it names the route that reaches the owner", async () => {
		const { store } = memoryStore();
		await store.port.put(
			"HOBO_CI_SETTINGS",
			JSON.stringify({
				HOBO_CI_PUBLIC_URL: RELAY,
				HOBO_CI_GITHUB_OWNER: "octo",
			}),
		);
		const progress: string[] = [];
		const outcome = await prepareGithubConnection(handOff(progress), {
			env: { CLAUDE_CODE_REMOTE: "true", INFISICAL_SIGN_IN: "egress-proxy" },
			locator: memoryLocator(),
			openStore: async () => ({ ok: true, store }),
			fetch: github().fetch,
			startPage: () => {
				throw new Error("no page");
			},
		});
		expect(readOwnerTurn(false, ownerLines(outcome, progress))).toMatchObject({
			kind: "act",
			action: { kind: "use-mcp" },
		});
	});
});
