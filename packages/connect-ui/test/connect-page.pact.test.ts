import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	type ConnectFlow,
	DEFAULT_SECRET_STORES,
	startConnectPage,
} from "../src/index.js";

// Provider verification for contracts/pacts/connect-page.pact.json: each
// interaction is replayed against a real connect page server in the stated
// provider state, under the session path.

interface Interaction {
	readonly description: string;
	readonly request: {
		readonly method: "GET" | "POST";
		readonly path: string;
		readonly body?: object;
	};
	readonly response: { readonly status: number; readonly body: object };
}

const pact: { readonly interactions: readonly Interaction[] } = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../contracts/pacts/connect-page.pact.json", import.meta.url),
		),
		"utf8",
	),
);

// Provider state "a GitHub connection waiting for a secret store".
function waitingForStore(): ConnectFlow {
	return {
		initial: {
			kind: "choose-secret-store",
			provider: "github",
			stores: DEFAULT_SECRET_STORES,
		},
		async onAction(action, params) {
			if (action === "connect.chooseStore" && params.store === "infisical")
				return {
					step: {
						kind: "create-github-app",
						provider: "github",
						appName: "HoBo CI",
						owner: "octo-org",
						store: "infisical",
					},
				};
			throw new Error(`unexpected ${action}`);
		},
	};
}

describe("connect page provider verification", () => {
	it.each(
		pact.interactions.map((i) => [i.description, i] as const),
	)("%s", async (_name, interaction) => {
		const page = await startConnectPage({
			flow: waitingForStore(),
			assetsDir: "dist/client",
		});
		try {
			const response = await fetch(
				`${page.url}${interaction.request.path.replace(/^\//, "")}`,
				{
					method: interaction.request.method,
					...(interaction.request.body !== undefined
						? {
								headers: { "content-type": "application/json" },
								body: JSON.stringify(interaction.request.body),
							}
						: undefined),
				},
			);
			expect(response.status).toBe(interaction.response.status);
			expect(await response.json()).toMatchObject(interaction.response.body);
		} finally {
			await page.close();
		}
	});
});
