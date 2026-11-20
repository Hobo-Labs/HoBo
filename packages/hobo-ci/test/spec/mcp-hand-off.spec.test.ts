import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it, vi } from "vitest";

import {
	type InfisicalAccessOptions,
	type OpenedSecretStore,
	type OwnerStoreDeps,
	prepareGithubConnection,
	provisionOnePasswordAccess,
} from "../../src/index.js";
import { ONE_PASSWORD_TEST_TOKEN } from "../support/onepassword-service-account.js";
import { heldOwnerChannel, readOwnerTurn } from "../support/remote-owner.js";

// SPEC: a ceremony run through the HoBo MCP server. The server calls the CLI
// with --json, so no progress line reaches the agent: everything the owner
// must do arrives in the refusal or through the owner channel. Derived from
// the real-binary smoke: after the Infisical sign-in, `cd up` answered
// "omit --json and -q", which no agent can do through MCP, and hid why the
// store did not open.

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
	it("opens an existing 1Password account through the owner channel", async () => {
		const token = ONE_PASSWORD_TEST_TOKEN;
		const kept = createTrustedVault();
		const owner = { ...heldOwnerChannel(), vault: kept };
		owner.deposit("OP_SERVICE_ACCOUNT_TOKEN", token);
		const runCommand = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
		const store: OpenedSecretStore = {
			id: "1password",
			port: createMemorySecretsPort({ id: "memory" }),
			reference: () => "fixture-reference",
		};
		let opens = 0;
		const openStore: NonNullable<OwnerStoreDeps["openStore"]> = async (
			_id,
			_coordinates,
			signIn,
		) => {
			opens += 1;
			expect(signIn.reveal("OP_SERVICE_ACCOUNT_TOKEN")).toBe(token);
			return { ok: true, store };
		};
		const outcome = await prepareGithubConnection(throughMcp(), {
			env: {},
			ownerChannel: owner,
			runCommand,
			openStore,
			onePasswordAccess: (options) =>
				provisionOnePasswordAccess({
					...options,
					validateServiceAccount: async () => true,
				}),
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "1password",
					OP_VAULT_ID: "a".repeat(26),
				}),
				write: async () => undefined,
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_SETTINGS_NEEDED" },
		});
		expect(opens).toBeGreaterThan(0);
		expect(runCommand).not.toHaveBeenCalled();
		expect(kept.reveal("OP_SERVICE_ACCOUNT_TOKEN")).toBe(token);
		expect(JSON.stringify(outcome)).not.toContain(token);
		kept.clear();
	});

	it("a store that will not open says why, never 'omit --json'", async () => {
		const outcome = await prepareGithubConnection(throughMcp(), {
			env: { CLAUDE_CODE_REMOTE: "true" },
			ownerChannel: heldOwnerChannel(),
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
					INFISICAL_SIGN_IN: "egress-proxy",
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
		// Derived from the real-binary smoke: the run after provisioning asked
		// the owner to sign in to Infisical again, because the token lived
		// only in that run's vault.
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
		// Memory only: nothing about it was written to the owner's settings.
		expect(JSON.stringify(await deps.locator.read())).not.toContain(
			"identity-token",
		);
	});
});
