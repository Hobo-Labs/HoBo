import type { CommandRunInput, PrepareInput } from "@hobo/cli";
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

	it("names every way into the store when it cannot open without a page", async () => {
		const outcome = await prepareGithubConnection(input(), {
			env: {},
			locator,
			openStore: async () => ({
				ok: false,
				message: "Not signed in to Infisical.",
				remediation: [],
			}),
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_STORE_NEEDS_SIGN_IN" },
		});
		const text = JSON.stringify(outcome);
		expect(text).toContain("Configure the store's non-secret ids");
		expect(text).not.toContain("ids are committed");
		expect(text).toContain(INFISICAL_TOKEN_AUTH_DOCS);
		expect(text).toContain("INFISICAL_SIGN_IN=oauth");
		expect(text).toContain("INFISICAL_IDENTITY_ID");
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
		expect(JSON.stringify(outcome)).toContain("--via-workflow");
	});
});
