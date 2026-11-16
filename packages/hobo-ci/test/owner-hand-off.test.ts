import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	canReachOwner,
	INFISICAL_TOKEN_AUTH_DOCS,
	type OpenedSecretStore,
	OWNER_PAGE_LINE_PREFIX,
	prepareGithubConnection,
	showOwnerPage,
} from "../src/index.js";

// An agent runs `hobo ci up --hand-off` / `hobo cd up --hand-off` for the
// owner: the page is served without a terminal and named on one line the
// agent passes on, and nothing tries to open a browser on its machine.

describe("owner hand-off", () => {
	it("lets a handed-off run reach the owner without a terminal, and an explicit no wins", () => {
		expect(canReachOwner(undefined, true)).toBe(true);
		expect(canReachOwner(false, true)).toBe(false);
		expect(canReachOwner(true, false)).toBe(true);
	});

	it("names the page on one line and opens no browser when handed off", () => {
		const lines: string[] = [];
		const opened: string[] = [];
		showOwnerPage({
			url: "http://127.0.0.1:43117/s/abc",
			what: "Set up Vercel for HoBo CD",
			handOff: true,
			emit: (line) => lines.push(line),
			openBrowser: (url) => opened.push(url),
		});
		expect(opened).toEqual([]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			new RegExp(
				`^${OWNER_PAGE_LINE_PREFIX} http://127\\.0\\.0\\.1:43117/s/abc port=43117 `,
			),
		);
	});

	it("opens the browser in a terminal", () => {
		const opened: string[] = [];
		showOwnerPage({
			url: "http://127.0.0.1:1/s/x",
			what: "Set up GitHub for HoBo CI",
			handOff: false,
			emit: () => undefined,
			openBrowser: (url) => opened.push(url),
		});
		expect(opened).toEqual(["http://127.0.0.1:1/s/x"]);
	});
});

describe("hobo ci up --hand-off", () => {
	function input(): PrepareInput {
		const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
			emitProgress: () => undefined,
			// SAFETY: the preparation fixture reads only these two output flags.
			flags: { json: false, quiet: false } as CommandRunInput["flags"],
		};
		// SAFETY: prepareGithubConnection reads only progress and these output flags.
		return {
			action: "up",
			projectDir: "/tmp/hobo-ci",
			whatIf: false,
			yes: false,
			handOff: true,
			run: run as CommandRunInput,
		};
	}
	const locator = {
		read: async () => ({
			HOBO_SECRET_STORE: "infisical",
			INFISICAL_PROJECT_ID: "proj",
		}),
		write: async () => undefined,
	};
	const noPage = () => {
		throw new Error("a handed-off run must not serve a page");
	};

	it("without an Infisical session, asks for one sign-in and never for hand-made identities", async () => {
		const outcome = await prepareGithubConnection(input(), {
			env: {},
			locator,
			openStore: async () => ({
				ok: false,
				message: "Not signed in to Infisical.",
				remediation: [],
			}),
			// A remote box with no Infisical CLI and so no session.
			runCommand: async () => ({ code: 127, stdout: "", stderr: "not found" }),
			which: async () => undefined,
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_INFISICAL_SIGN_IN" },
		});
		const text = JSON.stringify(outcome);
		expect(text).toMatch(/sign in once/u);
		expect(text).toMatch(/installs Infisical's CLI/u);
		// HoBo creates the identity and its access itself.
		expect(text).not.toMatch(/Create Identity|Token Auth|create a token/u);
		expect(text).not.toContain(INFISICAL_TOKEN_AUTH_DOCS);
	});

	it("refuses to create the App without GitHub's page, naming the paths that can", async () => {
		const store: OpenedSecretStore = {
			id: "infisical",
			port: createMemorySecretsPort({ id: "memory" }),
			reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
		};
		const outcome = await prepareGithubConnection(input(), {
			env: { INFISICAL_SIGN_IN: "egress-proxy" },
			locator,
			openStore: async () => ({ ok: true, store }),
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_APP_NEEDS_OWNER" },
		});
		const text = JSON.stringify(outcome);
		expect(text).toContain("in a terminal");
		// No HoBo service brokers the App's one-time code.
		expect(text).not.toContain("--via-workflow");
		expect(text).not.toMatch(/relay/u);
	});

	it("honors an explicitly saved OAuth choice instead of switching to the proxy", async () => {
		const vault = createTrustedVault();
		vault.put("INFISICAL_OAUTH_CLIENT_SECRET", "fixture-client-secret");
		const attempts: string[] = [];
		const lines: string[] = [];
		let sleeps = 0;
		const request = input();
		const outcome = await prepareGithubConnection(
			{
				...request,
				run: { ...request.run, emitProgress: (line) => lines.push(line) },
			},
			{
				env: {},
				vault,
				locator: {
					read: async () => ({
						HOBO_SECRET_STORE: "infisical",
						INFISICAL_PROJECT_ID: "proj",
						INFISICAL_SIGN_IN: "oauth",
						INFISICAL_OAUTH_CLIENT_ID: "client-id",
					}),
					write: async () => undefined,
				},
				openStore: async (_id, coordinates) => {
					attempts.push(coordinates.INFISICAL_SIGN_IN ?? "none");
					return { ok: false, message: "Browser unavailable", remediation: [] };
				},
				sleep: async () => {
					sleeps += 1;
				},
				handOffTimeoutMs: 1,
				startPage: noPage,
			},
		);
		expect(attempts).toEqual(["oauth"]);
		expect(sleeps).toBe(0);
		expect(lines.some((line) => line.startsWith("HOBO_OWNER_CREDENTIAL"))).toBe(
			false,
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_STORE_NEEDS_SIGN_IN" },
		});
	});

	it("does not wait for a token when the store locator is incomplete", async () => {
		const lines: string[] = [];
		let sleeps = 0;
		const request = input();
		const outcome = await prepareGithubConnection(
			{
				...request,
				run: { ...request.run, emitProgress: (line) => lines.push(line) },
			},
			{
				env: {},
				locator: {
					read: async () => ({ HOBO_SECRET_STORE: "infisical" }),
					write: async () => undefined,
				},
				sleep: async () => {
					sleeps += 1;
				},
				handOffTimeoutMs: 1,
				startPage: noPage,
			},
		);
		expect(sleeps).toBe(0);
		expect(lines.some((line) => line.startsWith("HOBO_OWNER_CREDENTIAL"))).toBe(
			false,
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_STORE_NEEDS_SIGN_IN" },
		});
		expect(JSON.stringify(outcome)).toContain(
			"Choose the store and give its non-secret ids",
		);
	});
});
