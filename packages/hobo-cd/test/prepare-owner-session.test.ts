import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import {
	type OpenedSecretStore,
	OwnerSelectionChangedError,
	type OwnerSettingsStore,
	StoreOperationUncertainError,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { prepareVercelConnection } from "../src/index.js";

function handOff(): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: () => undefined,
		// SAFETY: the preparation reads only progress and these output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	// SAFETY: the preparation reads only progress and these output flags.
	return {
		action: "up",
		projectDir: "/box/project",
		whatIf: false,
		yes: false,
		handOff: true,
		run: run as CommandRunInput,
	};
}

function mcpSessionLocator(saved: Readonly<Record<string, string>>) {
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
	} satisfies OwnerSettingsStore;
	return {
		locator,
		reselect: () => {
			generation += 1;
		},
	};
}

const SAVED = { HOBO_SECRET_STORE: "infisical", INFISICAL_PROJECT_ID: "proj" };

const noPage = () => {
	throw new Error("a handed-off run serves no page");
};

const signedIn = () => {
	const vault = createTrustedVault();
	vault.put("INFISICAL_TOKEN", "fixture-handed-over-access-token");
	return vault;
};

describe("hobo cd up: the owner session's currency after the ceremony", () => {
	it("refuses as uncertain, opening nothing, while a store write is unreconciled", async () => {
		const session = mcpSessionLocator(SAVED);
		session.locator.markUncertainWrite?.();
		const opened: string[] = [];
		const outcome = await prepareVercelConnection(handOff(), {
			vault: signedIn(),
			locator: session.locator,
			openStore: async (id) => {
				opened.push(id);
				return { ok: false, message: "unreachable", remediation: [] };
			},
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: {
				code: "HOBO_CD_STORE_OPERATION_UNCERTAIN",
				remediation: [
					"Reconcile the store operation before trying setup again.",
				],
			},
		});
		expect(opened).toEqual([]);
	});

	it("reports a store the owner changed while the store opened as the choice changing", async () => {
		const session = mcpSessionLocator(SAVED);
		const outcome = await prepareVercelConnection(handOff(), {
			vault: signedIn(),
			locator: session.locator,
			openStore: async () => {
				session.reselect();
				return {
					ok: true,
					store: {
						id: "infisical",
						port: createMemorySecretsPort({ id: "memory" }),
						reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
					} satisfies OpenedSecretStore,
				};
			},
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: {
				code: "HOBO_CD_OWNER_CHOICE_CHANGED",
				remediation: ["Run hobo cd up again for the selected store."],
			},
		});
	});
});
