import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	type InfisicalAccessOptions,
	type OpenedSecretStore,
	prepareGithubConnection,
} from "../../src/index.js";
import {
	handedOverInfisicalToken,
	heldOwnerChannel,
	readOwnerTurn,
} from "../support/remote-owner.js";

function throughMcp(): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: () => undefined,
		// SAFETY: the preparation reads only progress and these output flags.
		flags: { json: true, quiet: false } as CommandRunInput["flags"],
	};
	return {
		action: "up",
		projectDir: "/tmp/hobo-mcp-hand-off",
		whatIf: false,
		yes: false,
		handOff: true,
		// SAFETY: prepareGithubConnection reads only progress and these output flags.
		run: run as CommandRunInput,
	};
}

const lines = (outcome: Awaited<ReturnType<typeof prepareGithubConnection>>) =>
	outcome.kind === "refused"
		? [
				outcome.result.code ?? "",
				outcome.result.message ?? "",
				...(outcome.result.remediation ?? []),
			]
		: [];

describe("SPEC hand-off through MCP: no progress lines, no silent refusals", () => {
	it("a store that will not open says why, never 'omit --json'", async () => {
		const outcome = await prepareGithubConnection(throughMcp(), {
			env: { CLAUDE_CODE_REMOTE: "true" },
			vault: handedOverInfisicalToken(),
			ownerChannel: heldOwnerChannel(),
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
				}),
				write: async () => undefined,
			},
			openStore: async () => ({
				ok: false,
				message: "Infisical refused this run's token (HTTP 401).",
				remediation: ["Run again: HoBo signs in to Infisical afresh."],
			}),
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("no page through MCP");
			},
		});
		const shown = lines(outcome);
		expect(shown.join("\n")).not.toMatch(/HANDOFF_SILENT|--json/u);
		expect(shown.join("\n")).toContain(
			"Infisical refused this run's token (HTTP 401).",
		);
		expect(readOwnerTurn(false, shown).kind).not.toBe("dead-end");
	});

	it("a store missing only its token asks for it through HoBo's capture, never the session's credential form", async () => {
		const owner = heldOwnerChannel();
		const tokens: (string | undefined)[] = [];
		const deps: Parameters<typeof prepareGithubConnection>[1] = {
			env: { CLAUDE_CODE_REMOTE: "true" },
			ownerChannel: owner,
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
					INFISICAL_SIGN_IN: "typed",
				}),
				write: async () => undefined,
			},
			openStore: async (_id, _coordinates, signIn) => {
				tokens.push(signIn.reveal("INFISICAL_TOKEN"));
				return {
					ok: true,
					store: {
						id: "infisical",
						port: createMemorySecretsPort({ id: "memory" }),
						reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
					},
				};
			},
			startPage: () => {
				throw new Error("no page through MCP");
			},
		};
		const shown = lines(await prepareGithubConnection(throughMcp(), deps));
		expect(readOwnerTurn(false, shown)).toEqual({
			kind: "act",
			action: { kind: "capture", names: ["INFISICAL_TOKEN"] },
		});
		expect(shown.join("\n")).not.toMatch(/HOBO_OWNER_CREDENTIAL|egress/u);
		owner.deposit("INFISICAL_TOKEN", "fixture-handed-over-access-token");
		await prepareGithubConnection(throughMcp(), deps);
		expect(tokens).toEqual(["fixture-handed-over-access-token"]);
	});

	it("a store missing a setting names it", async () => {
		const outcome = await prepareGithubConnection(throughMcp(), {
			env: { CLAUDE_CODE_REMOTE: "true" },
			ownerChannel: heldOwnerChannel(),
			locator: {
				read: async () => ({ HOBO_SECRET_STORE: "infisical" }),
				write: async () => undefined,
			},
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("no page through MCP");
			},
		});
		const shown = lines(outcome).join("\n");
		expect(shown).not.toMatch(/HANDOFF_SILENT|--json/u);
		expect(shown).toMatch(/project/iu);
	});
});

describe("SPEC hand-off through MCP: one sign-in serves every later run", () => {
	it("the store sign-in HoBo created is kept for the server's lifetime (memory only), not asked for again", async () => {
		const kept = createTrustedVault();
		const owner = { ...heldOwnerChannel(), vault: kept };
		let provisioned = 0;
		const tokens: (string | undefined)[] = [];
		const store: OpenedSecretStore = {
			id: "infisical",
			port: createMemorySecretsPort({ id: "memory" }),
			reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
		};
		const deps = {
			env: { CLAUDE_CODE_REMOTE: "true" },
			ownerChannel: owner,
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
				}),
				write: async () => undefined,
			},
			runCommand: async () => ({ code: 127, stdout: "", stderr: "" }),
			infisicalAccess: async (_options: InfisicalAccessOptions) => {
				provisioned += 1;
				return {
					kind: "ready" as const,
					identityId: "ident-1",
					projectId: "proj",
					environment: "prod",
					auth: "token" as const,
					token: "identity-token",
				};
			},
			openStore: async (
				_id: string,
				_coordinates: Readonly<Record<string, string | undefined>>,
				vault: { reveal(name: string): string | undefined },
			) => {
				tokens.push(vault.reveal("INFISICAL_TOKEN"));
				return { ok: true as const, store };
			},
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("no page through MCP");
			},
		};
		await prepareGithubConnection(throughMcp(), deps);
		const second = await prepareGithubConnection(throughMcp(), deps);
		expect(provisioned).toBe(1);
		expect(JSON.stringify(second)).not.toMatch(/INFISICAL_SIGN_IN/u);
		expect(tokens.at(-1)).toBe("identity-token");
		expect(JSON.stringify(await deps.locator.read())).not.toContain(
			"identity-token",
		);
	});
});

describe("SPEC hand-off through MCP: the store opens where HoBo provisioned", () => {
	it("records the project and environment provisioning resolved, and opens the store there", async () => {
		const saved = new Map([
			["HOBO_SECRET_STORE", "infisical"],
			["INFISICAL_PROJECT_ID", "typed-project"],
			["INFISICAL_ENVIRONMENT", "prod"],
		]);
		const opened: (string | undefined)[][] = [];
		const offered: (string | undefined)[] = [];
		const store: OpenedSecretStore = {
			id: "infisical",
			port: createMemorySecretsPort({ id: "memory" }),
			reference: (name) => `infisical://secrets/production/hobo-ci/${name}`,
		};
		await prepareGithubConnection(throughMcp(), {
			env: {
				CLAUDE_CODE_REMOTE: "true",
				INFISICAL_PROJECT_ID: "typed-project",
			},
			ownerChannel: heldOwnerChannel(),
			locator: {
				read: async () => Object.fromEntries(saved),
				write: async (values) => {
					saved.clear();
					for (const [name, value] of Object.entries(values))
						saved.set(name, value);
				},
			},
			runCommand: async () => ({ code: 127, stdout: "", stderr: "" }),
			infisicalAccess: async (options: InfisicalAccessOptions) => {
				offered.push(options.projectId);
				return {
					kind: "ready" as const,
					identityId: "ident-1",
					projectId: "resolved-project",
					environment: "production",
					auth: "token" as const,
					token: "identity-token",
				};
			},
			openStore: async (_id, coordinates, vault) => {
				opened.push([
					coordinates.INFISICAL_PROJECT_ID,
					coordinates.INFISICAL_ENVIRONMENT,
				]);
				return vault.reveal("INFISICAL_TOKEN") === undefined
					? { ok: false, message: "Not signed in.", remediation: [] }
					: { ok: true, store };
			},
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("no page through MCP");
			},
		});
		expect(offered).toEqual(["typed-project"]);
		expect(Object.fromEntries(saved)).toMatchObject({
			INFISICAL_IDENTITY_ID: "ident-1",
			INFISICAL_PROJECT_ID: "resolved-project",
			INFISICAL_ENVIRONMENT: "production",
		});
		expect(opened.at(-1)).toEqual(["resolved-project", "production"]);
	});
});
