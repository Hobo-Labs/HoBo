import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	ensureBitwardenSignIn,
	isRemoteBox,
	type OpenedSecretStore,
	prepareGithubConnection,
	provisionOnePasswordAccess,
	remoteInfeasible,
	storeSignInGuidance,
} from "../../src/index.js";
import {
	handedOverInfisicalToken,
	readOwnerTurn,
} from "../support/remote-owner.js";

// SPEC: every refusal a handed-off run can give a remote owner is one they
// can act on from where they are. They have a browser on their own device
// and the agent's chat; they cannot reach this box's 127.0.0.1, open its
// terminal or run anything on it. Each case below is a refusal the ceremony
// really produces, read by the simulated remote owner.

function handOff(): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: () => undefined,
		// SAFETY: the preparation fixture reads only these two output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	return {
		action: "up",
		projectDir: "/tmp/hobo-remote",
		whatIf: false,
		yes: false,
		handOff: true,
		// SAFETY: prepareGithubConnection reads only progress and these output flags.
		run: run as CommandRunInput,
	};
}

const linesOf = (outcome: {
	readonly kind: string;
	readonly result?: {
		readonly code?: string;
		readonly message?: string;
		readonly remediation?: readonly string[];
	};
}) => [
	outcome.result?.code ?? "",
	outcome.result?.message ?? "",
	...(outcome.result?.remediation ?? []),
];

describe("SPEC remote reach: the box is recognised as remote", () => {
	it.each([
		["CLAUDE_CODE_REMOTE", "true"],
		["CODESPACES", "true"],
		["GITPOD_WORKSPACE_ID", "abc"],
		["CODER", "true"],
		["REMOTE_CONTAINERS", "true"],
		["CLOUD_SHELL", "true"],
		["SSH_CONNECTION", "10.0.0.1 5000 10.0.0.2 22"],
	])("%s", (name, value) => {
		expect(isRemoteBox({ [name]: value })).toBe(true);
	});
	it("a laptop is not", () => {
		expect(isRemoteBox({ CODESPACES: "false" })).toBe(false);
		expect(isRemoteBox({})).toBe(false);
	});
});

describe("SPEC remote reach: store sign-in guidance", () => {
	for (const store of ["infisical", "1password", "bitwarden"] as const)
		it(`${store}: nothing only possible at the box`, () => {
			expect(remoteInfeasible(storeSignInGuidance(store, "cd"))).toEqual([]);
		});
});

describe("SPEC remote reach: 1Password from a remote box", () => {
	it("with no CLI and no session, the refusal is something the owner can do from their own device", async () => {
		const access = await provisionOnePasswordAccess({
			family: "cd",
			vaultId: "vault-1",
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
			which: async () => undefined,
			toolsDir: "/unused",
			emit: () => undefined,
			interactive: false,
			exists: () => false,
		});
		expect(access.kind).toBe("refused");
		if (access.kind !== "refused") return;
		const step = readOwnerTurn(false, [
			access.code,
			access.message,
			...access.remediation,
		]);
		expect(step.kind).not.toBe("dead-end");
	});
});

describe("SPEC remote reach: self-hosted Bitwarden from a remote box", () => {
	it("asks for the API key in a way the owner can give remotely", async () => {
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault: createTrustedVault(),
			env: { BITWARDEN_SERVER_URL: "https://vault.example.com" },
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: async () => Response.json({}),
			emit: () => undefined,
			silent: false,
			handOff: true,
		});
		expect(refusal).toBeDefined();
		const step = readOwnerTurn(false, [
			refusal?.code ?? "",
			refusal?.message ?? "",
			...(refusal?.remediation ?? []),
		]);
		expect(step.kind).not.toBe("dead-end");
	});
});

describe("SPEC remote reach: hobo ci up --hand-off with no GitHub App yet", () => {
	it("never tells a remote owner to use a terminal or their own machine", async () => {
		const store: OpenedSecretStore = {
			id: "infisical",
			port: createMemorySecretsPort({ id: "memory" }),
			reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
		};
		const outcome = await prepareGithubConnection(handOff(), {
			env: { CLAUDE_CODE_REMOTE: "true" },
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
				}),
				write: async () => undefined,
			},
			openStore: async () => ({ ok: true, store }),
			startPage: () => {
				throw new Error("a handed-off run serves no page on the box");
			},
		});
		expect(remoteInfeasible(linesOf(outcome))).toEqual([]);
	});

	it("a run with no owner at all names a reachable path, not a terminal", async () => {
		const input = handOff();
		const outcome = await prepareGithubConnection(
			{ ...input, handOff: false },
			{
				env: { CLAUDE_CODE_REMOTE: "true" },
				interactive: false,
				locator: {
					read: async () => ({
						HOBO_SECRET_STORE: "infisical",
						INFISICAL_PROJECT_ID: "proj",
					}),
					write: async () => undefined,
				},
				openStore: async () => ({
					ok: true,
					store: {
						id: "infisical",
						port: createMemorySecretsPort({ id: "memory" }),
						reference: (name) => `infisical://proj/prod/hobo-ci/${name}`,
					},
				}),
			},
		);
		expect(remoteInfeasible(linesOf(outcome))).toEqual([]);
	});
});

describe("SPEC remote reach: Infisical's API origin is the owner's own", () => {
	it("an EU or self-hosted Infisical is provisioned at its own origin", async () => {
		const origins: (string | undefined)[] = [];
		await prepareGithubConnection(handOff(), {
			env: {},
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
					INFISICAL_SITE_URL: "https://eu.infisical.com",
				}),
				write: async () => undefined,
			},
			openStore: async () => ({
				ok: false,
				message: "Not signed in to Infisical.",
				remediation: [],
			}),
			runCommand: async () => ({ code: 127, stdout: "", stderr: "" }),
			infisicalAccess: async (options) => {
				origins.push(options.apiOrigin);
				return {
					kind: "refused",
					code: "HOBO_CI_INFISICAL_SIGN_IN",
					message: "x",
					remediation: [],
				};
			},
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("no page");
			},
		});
		expect(origins).toEqual(["https://eu.infisical.com"]);
	});
});

describe("SPEC remote reach: the store opens at the owner's own Infisical", () => {
	it("an EU or self-hosted Infisical store opens at the site the owner saved, as provisioning does", async () => {
		// Derived from the real-binary smoke: the identity was provisioned on the
		// owner's site, then the store opened against US cloud and never answered.
		const sites: (string | undefined)[] = [];
		await prepareGithubConnection(handOff(), {
			env: {},
			vault: handedOverInfisicalToken(),
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "proj",
					INFISICAL_SITE_URL: "https://eu.infisical.com",
				}),
				write: async () => undefined,
			},
			openStore: async (_id, coordinates) => {
				sites.push(coordinates.INFISICAL_SITE_URL);
				return { ok: false, message: "x", remediation: [] };
			},
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("no page");
			},
		});
		expect(sites.length).toBeGreaterThan(0);
		expect(new Set(sites)).toEqual(new Set(["https://eu.infisical.com"]));
	});
});
