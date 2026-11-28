import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	type OpenedSecretStore,
	OwnerSelectionChangedError,
	type OwnerSettingsStore,
	prepareGithubConnection,
	StoreOperationUncertainError,
} from "../src/index.js";
import { API_KEY, fakeBitwarden } from "./support/fake-bitwarden.js";
import {
	handedOverInfisicalToken,
	heldOwnerChannel,
} from "./support/remote-owner.js";

function handedOff(): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: () => undefined,
		// SAFETY: prepareGithubConnection reads only progress and these output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	// SAFETY: prepareGithubConnection reads only progress and these output flags.
	return {
		action: "up",
		projectDir: "/box/project",
		whatIf: false,
		yes: false,
		handOff: true,
		run: run as CommandRunInput,
	};
}

function mcpSessionLocator(saved: Readonly<Record<string, string>> = {}) {
	let generation = 0;
	let latched = false;
	const locator = {
		read: async () => saved,
		write: async () => undefined,
		assertCurrent: () => {
			if (generation > 0) throw new OwnerSelectionChangedError();
			if (latched) throw new StoreOperationUncertainError();
		},
		markUncertainWrite: () => {
			latched = true;
		},
		onOwnerChoice: () => {
			generation += 1;
		},
		runStoreWrite: async <T>(write: () => Promise<T>): Promise<T> => write(),
	} satisfies OwnerSettingsStore;
	return {
		locator,
		reselect: () => {
			generation += 1;
		},
	};
}

const memoryStore = (): OpenedSecretStore => ({
	id: "infisical",
	port: createMemorySecretsPort({ id: "memory" }),
	reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
});

const noPage = () => {
	throw new Error("a handed-off run serves no page");
};

const UNCERTAIN = {
	kind: "refused",
	result: {
		code: "HOBO_CI_STORE_OPERATION_UNCERTAIN",
		message:
			"A store operation may have completed and needs reconciliation before retrying.",
		remediation: ["Reconcile the store operation before trying setup again."],
	},
};

const CHOICE_CHANGED = {
	kind: "refused",
	result: {
		code: "HOBO_CI_OWNER_CHOICE_CHANGED",
		message:
			"The owner changed the selected store while this operation was running.",
		remediation: ["Run hobo ci up again for the selected store."],
	},
};

describe("hobo ci up: the owner session's currency after the ceremony", () => {
	it("keeps an uncertain store operation's refusal instead of reporting the owner's choice as changed", async () => {
		const server = fakeBitwarden();
		const owner = {
			...heldOwnerChannel(),
			canConfirm: () => true,
			confirm: async () => true,
		};
		const session = mcpSessionLocator();
		const opened: string[] = [];
		const run = () =>
			prepareGithubConnection(handedOff(), {
				env: { HOBO_SECRET_STORE: "bitwarden" },
				vault: createTrustedVault(),
				locator: session.locator,
				ownerChannel: owner,
				openStore: async (id) => {
					opened.push(id);
					return { ok: false, message: "no sign-in", remediation: [] };
				},
				fetch: async (input, init) => {
					const response = await server.fetch(input, init);
					return init?.method === "POST" &&
						new URL(String(input)).pathname.endsWith("/projects")
						? new Response(null, { status: 500 })
						: response;
				},
				sleep: async () => undefined,
				handOffTimeoutMs: 60_000,
				startPage: noPage,
			});
		await run();
		owner.deposit("BW_CLIENTID", API_KEY.clientId);
		owner.deposit("BW_CLIENTSECRET", API_KEY.clientSecret);
		expect(await run()).toMatchObject(UNCERTAIN);
		expect(server.projects).toHaveLength(1);
		expect(opened).toEqual([]);
		const again = await run();
		expect(again).toMatchObject(UNCERTAIN);
		expect(JSON.stringify(again)).not.toContain("OWNER_CHOICE_CHANGED");
		expect(opened).toEqual([]);
	});

	it("reports a store the owner changed while the store opened as the choice changing", async () => {
		const session = mcpSessionLocator({
			HOBO_SECRET_STORE: "infisical",
			INFISICAL_PROJECT_ID: "proj",
		});
		const outcome = await prepareGithubConnection(handedOff(), {
			vault: handedOverInfisicalToken(),
			locator: session.locator,
			openStore: async () => {
				session.reselect();
				return { ok: true, store: memoryStore() };
			},
			startPage: noPage,
		});
		expect(outcome).toMatchObject(CHOICE_CHANGED);
	});

	it("reports a store the owner changed after the ceremony's last check as the choice changing", async () => {
		const session = mcpSessionLocator({
			HOBO_SECRET_STORE: "infisical",
			INFISICAL_PROJECT_ID: "proj",
		});
		const owner = heldOwnerChannel();
		owner.holds = () => {
			session.reselect();
			return false;
		};
		const outcome = await prepareGithubConnection(handedOff(), {
			vault: handedOverInfisicalToken(),
			locator: session.locator,
			ownerChannel: owner,
			openStore: async () => ({ ok: true, store: memoryStore() }),
			startPage: noPage,
		});
		expect(outcome).toMatchObject(CHOICE_CHANGED);
	});
});
