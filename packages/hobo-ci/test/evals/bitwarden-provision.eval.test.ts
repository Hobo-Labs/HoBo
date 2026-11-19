import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	accessTokenKey,
	decryptEncString,
	fingerprintPhrase,
} from "../../src/bitwarden-crypto.js";
import {
	bitwardenEndpoints,
	OWNER_BITWARDEN_APPROVE_LINE_PREFIX,
	parseBitwardenApiKey,
	parseBitwardenDeviceId,
	provisionBitwardenAccessToken,
} from "../../src/bitwarden-provision.js";
import { ensureBitwardenSignIn } from "../../src/bitwarden-sign-in.js";
import { OWNER_CREDENTIAL_LINE_PREFIX } from "../../src/hand-off-store.js";
import {
	openSecretStore,
	prepareGithubConnection,
	type SecretStoreOpening,
} from "../../src/index.js";
import { ownerLocator, secretStoreLocatorPath } from "../../src/owner-store.js";
import { parseHttpsOrigin } from "../../src/parsed-values.js";
import {
	API_KEY,
	type FakeBitwardenOptions,
	fakeBitwarden,
	ORG_ID,
	OTHER_ORG_ID,
	OWNER_EMAIL,
	VAULTWARDEN_ORIGIN,
} from "../support/fake-bitwarden.js";

// EVAL: the owner chose Bitwarden and gave no Secrets Manager access token.
// With their personal API key (in the environment's settings) the run does
// everything Bitwarden's API allows: it signs in, picks the organization,
// asks the owner to approve one login request (showing the same fingerprint
// phrase their app shows), then creates the project, machine account, grant
// and a one-day access token itself. The owner creates no identity and
// copies no token; no secret reaches the output.

const DEVICE = parseBitwardenDeviceId("8d0f3c2e-1b4a-4c5d-9e6f-7a8b9c0d1e2f");

async function provision(
	options: FakeBitwardenOptions = {},
	extra: { organizationId?: string } = {},
) {
	const server = fakeBitwarden(options);
	const lines: string[] = [];
	const result = await provisionBitwardenAccessToken({
		family: "cd",
		endpoints: bitwardenEndpoints("us"),
		apiKey: parseBitwardenApiKey(API_KEY.clientId, API_KEY.clientSecret),
		deviceId: DEVICE,
		...(extra.organizationId !== undefined
			? // SAFETY: test ids are UUIDs.
				{ organizationId: extra.organizationId as never }
			: undefined),
		fetch: server.fetch,
		emit: (line) => lines.push(line),
		sleep: async () => undefined,
		now: (() => {
			let t = Date.parse("2026-11-16T12:00:00Z");
			return () => (t += 1_000);
		})(),
		timeoutMs: 60_000,
	});
	return { server, lines, result };
}

describe("EVAL Bitwarden provisioning: one approval, no copied token", () => {
	it("creates the project, machine account, grant and a working access token", async () => {
		const { server, lines, result } = await provision();
		if (result.kind !== "provisioned")
			throw new Error(`refused: ${JSON.stringify(result)}`);

		// The device signed in before it asked: Bitwarden only accepts login
		// requests from a device it knows.
		expect(server.calls.indexOf("POST /connect/token")).toBeLessThan(
			server.calls.indexOf("POST /auth-requests/"),
		);
		// One owner step, with the phrase their app shows for this request.
		const approve = lines.filter((l) =>
			l.startsWith(`${OWNER_BITWARDEN_APPROVE_LINE_PREFIX} `),
		);
		expect(approve).toHaveLength(1);
		const request = server.requests[0];
		if (request === undefined) throw new Error("no login request");
		const phrase = fingerprintPhrase(
			OWNER_EMAIL,
			Buffer.from(request.publicKey, "base64"),
		);
		expect(approve[0]).toContain(`phrase=${phrase}`);

		// Created as Bitwarden's clients create them: names encrypted with the
		// organization key.
		expect(result.organizationId).toBe(ORG_ID);
		expect(server.projects).toHaveLength(1);
		expect(
			decryptEncString(
				server.projects[0]?.name ?? "",
				server.orgKey,
			).toString(),
		).toBe("hobo");
		expect(
			decryptEncString(
				server.accounts[0]?.name ?? "",
				server.orgKey,
			).toString(),
		).toBe("hobo");
		expect(server.grants.get(server.accounts[0]?.id ?? "")).toEqual([
			{ grantedId: result.projectId, read: true, write: true },
		]);

		// The token opens the organization key the way the SDK opens it.
		const match = /^0\.([^.]+)\.([^:]+):(.+)$/u.exec(result.token);
		expect(match?.[1]).toBe("66666666-6666-4666-8666-666666666666");
		const seed = Buffer.from(match?.[3] ?? "", "base64");
		expect(seed).toHaveLength(16);
		const minted = server.tokens[0];
		if (minted === undefined) throw new Error("no token minted");
		const payload = JSON.parse(
			decryptEncString(
				minted.encryptedPayload,
				accessTokenKey(seed),
			).toString(),
		);
		expect(
			Buffer.from(payload.encryptionKey, "base64").equals(server.orgKey),
		).toBe(true);
		// Short-lived: a day, not forever.
		const lifetime =
			Date.parse(minted.expireAt) - Date.parse("2026-11-16T12:00:00Z");
		expect(lifetime).toBeGreaterThan(23 * 3_600_000);
		expect(lifetime).toBeLessThan(25 * 3_600_000);

		const all = lines.join("\n");
		expect(all).not.toContain(API_KEY.clientSecret);
		expect(all).not.toContain("MintedClientSecret0123");
	});

	it("reuses an existing project and machine account, keeping their other grants", async () => {
		const { server, result } = await provision({ existing: true });
		if (result.kind !== "provisioned")
			throw new Error(`refused: ${JSON.stringify(result)}`);
		expect(result.projectId).toBe("22222222-2222-4222-8222-222222222222");
		expect(server.projects).toHaveLength(2);
		expect(server.accounts).toHaveLength(1);
		expect(server.grants.get("33333333-3333-4333-8333-333333333333")).toEqual([
			{
				grantedId: "11111111-1111-4111-8111-111111111111",
				read: true,
				write: false,
			},
			{ grantedId: result.projectId, read: true, write: true },
		]);
	});

	it("accepts an approval from an older app that hands over the master key", async () => {
		const { result } = await provision({ legacyMasterKey: true });
		expect(result.kind).toBe("provisioned");
	});

	it("asks which organization before bothering the owner, when there are several", async () => {
		const { server, lines, result } = await provision({ organizations: 2 });
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_BITWARDEN_ORGANIZATION",
		});
		if (result.kind !== "refused") return;
		expect(result.remediation.join("\n")).toContain(
			`BWS_ORGANIZATION_ID=${OTHER_ORG_ID}`,
		);
		expect(server.requests).toHaveLength(0);
		expect(lines).toHaveLength(0);
		const chosen = await provision(
			{ organizations: 2 },
			{ organizationId: ORG_ID },
		);
		expect(chosen.result.kind).toBe("provisioned");
	});

	it("refuses clearly when the owner denies the request", async () => {
		const { server, result } = await provision({ approve: "deny" });
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_BITWARDEN_DENIED",
		});
		expect(server.tokens).toHaveLength(0);
	});

	it("stops waiting at the deadline and says where approvals appear", async () => {
		const { result } = await provision({ approve: "never" });
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_BITWARDEN_NOT_APPROVED",
		});
		if (result.kind === "refused")
			expect(result.remediation.join(" ")).toMatch(/Approve login requests/u);
	});

	it("refuses an organization API key where it is read", () => {
		expect(() =>
			parseBitwardenApiKey(
				"organization.0c7e4c1a-7a0e-4a65-9c2e-2f1b8f0d1e2a",
				API_KEY.clientSecret,
			),
		).toThrow(/personal API key/u);
	});
});

describe("EVAL Bitwarden sign-in: from the environment's API key to the run's vault", () => {
	it("moves the new token into the vault and the ids into the locator", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		const saved = new Map<string, string>();
		const lines: string[] = [];
		const refusal = await ensureBitwardenSignIn({
			family: "ci",
			vault,
			env: {},
			locator: {
				read: async () => Object.fromEntries(saved),
				write: async (values) => {
					saved.clear();
					for (const [name, value] of Object.entries(values))
						saved.set(name, value);
				},
			},
			fetch: server.fetch,
			emit: (line) => lines.push(line),
			silent: false,
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal).toBeUndefined();
		expect(vault.reveal("BWS_ACCESS_TOKEN")).toMatch(/^0\./u);
		expect(Object.fromEntries(saved)).toMatchObject({
			BWS_SERVER: "us",
			BWS_ORGANIZATION_ID: ORG_ID,
			BWS_PROJECT_ID: "44444444-4444-4444-8444-444444444444",
		});
		// The device id is kept, so the next run is the same known device.
		expect(saved.get("BITWARDEN_DEVICE_ID")).toMatch(/^[0-9a-f-]{36}$/u);
		// The locator holds ids only.
		expect(JSON.stringify(Object.fromEntries(saved))).not.toMatch(
			/MintedClientSecret|Zq8pX1/u,
		);
		expect(lines.join("\n")).not.toContain(
			vault.reveal("BWS_ACCESS_TOKEN") ?? "-",
		);
	});

	it("needs progress output to show the approval", async () => {
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		const refusal = await ensureBitwardenSignIn({
			family: "ci",
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: fakeBitwarden().fetch,
			emit: () => undefined,
			silent: true,
		});
		expect(refusal?.code).toBe("HOBO_CI_HANDOFF_SILENT");
	});

	it("does nothing without an API key, and replaces a refused token with one", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		const options = {
			family: "ci" as const,
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: server.fetch,
			emit: () => undefined,
			silent: false,
			sleep: async () => undefined,
			timeoutMs: 60_000,
		};
		vault.put("BWS_ACCESS_TOKEN", "0.revoked.secret:key");
		expect(await ensureBitwardenSignIn(options)).toBeUndefined();
		expect(server.calls).toHaveLength(0);
		expect(vault.reveal("BWS_ACCESS_TOKEN")).toBe("0.revoked.secret:key");
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		expect(await ensureBitwardenSignIn(options)).toBeUndefined();
		expect(vault.reveal("BWS_ACCESS_TOKEN")).toMatch(/^0\.66666666-/u);
	});
});

describe("EVAL hobo ci up --hand-off with Bitwarden chosen and only the API key provided", () => {
	it("asks for one approval, then opens the store with the token it created", async () => {
		const server = fakeBitwarden();
		const shown: string[] = [];
		const saved = new Map<string, string>();
		const opened = new Map<string, string>();
		const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
			emitProgress: (line) => shown.push(line),
			// SAFETY: the preparation reads only progress and these output flags.
			flags: { json: false, quiet: false } as CommandRunInput["flags"],
		};
		// SAFETY: the preparation reads only progress and these output flags.
		const input = {
			action: "up",
			projectDir: "/box/project",
			whatIf: false,
			yes: false,
			handOff: true,
			run: run as CommandRunInput,
		} as PrepareInput;
		await prepareGithubConnection(input, {
			env: {
				HOBO_SECRET_STORE: "bitwarden",
				BW_CLIENTID: API_KEY.clientId,
				BW_CLIENTSECRET: API_KEY.clientSecret,
			},
			vault: createTrustedVault(),
			locator: {
				read: async () => Object.fromEntries(saved),
				write: async (values) => {
					saved.clear();
					for (const [name, value] of Object.entries(values))
						saved.set(name, value);
				},
			},
			openStore: async (
				id,
				coordinates,
				signIn,
			): Promise<SecretStoreOpening> => {
				const token = signIn.reveal("BWS_ACCESS_TOKEN");
				if (id !== "bitwarden" || token === undefined)
					return { ok: false, message: "no sign-in", remediation: [] };
				opened.set("token", token);
				for (const [name, value] of Object.entries(coordinates))
					if (value !== undefined) opened.set(name, value);
				return {
					ok: true,
					store: {
						id: "bitwarden",
						port: createMemorySecretsPort({ id: "memory" }),
						reference: (name) => `bws://${name}`,
					},
				};
			},
			fetch: server.fetch,
			sleep: async () => undefined,
			handOffTimeoutMs: 60_000,
			startPage: () => {
				throw new Error("a handed-off run serves no page");
			},
		});
		expect(opened.get("token")).toMatch(
			/^0\.66666666-6666-4666-8666-666666666666\./u,
		);
		expect(Object.fromEntries(opened)).toMatchObject({
			BWS_ORGANIZATION_ID: ORG_ID,
			BWS_PROJECT_ID: "44444444-4444-4444-8444-444444444444",
		});
		expect(
			shown.filter((l) =>
				l.startsWith(`${OWNER_BITWARDEN_APPROVE_LINE_PREFIX} `),
			),
		).toHaveLength(1);
		const all = shown.join("\n");
		expect(all).not.toContain(API_KEY.clientSecret);
		expect(all).not.toContain("MintedClientSecret0123");
		expect(all).not.toMatch(/\b(127\.0\.0\.1|localhost)\b/u);
	});
});

describe("EVAL Vaultwarden: the same one approval, against the owner's own server", () => {
	const endpoints = bitwardenEndpoints(
		"us",
		parseHttpsOrigin("BITWARDEN_SERVER_URL", VAULTWARDEN_ORIGIN),
	);

	it("signs in to the overridden server only and keeps secrets in a collection", async () => {
		const server = fakeBitwarden({ vaultwarden: true });
		const lines: string[] = [];
		const result = await provisionBitwardenAccessToken({
			family: "cd",
			endpoints,
			apiKey: parseBitwardenApiKey(API_KEY.clientId, API_KEY.clientSecret),
			deviceId: DEVICE,
			fetch: server.fetch,
			emit: (line) => lines.push(line),
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		if (result.kind !== "vault")
			throw new Error(`not vault storage: ${JSON.stringify(result)}`);
		expect(server.strayHosts).toEqual([]);
		expect(server.calls).not.toContain(
			`POST /organizations/${ORG_ID}/projects`,
		);
		expect(server.collections).toHaveLength(1);
		expect(
			decryptEncString(
				server.collections[0]?.name ?? "",
				server.orgKey,
			).toString(),
		).toBe("hobo");
		expect(result.collectionId).toBe("88888888-8888-4888-8888-888888888888");
		expect(
			Buffer.from(result.organizationKey, "base64").equals(server.orgKey),
		).toBe(true);
		const approve = lines.find((l) =>
			l.startsWith(OWNER_BITWARDEN_APPROVE_LINE_PREFIX),
		);
		expect(approve).toContain("server=vault.example.com");
		expect(approve).toMatch(/secure notes in the collection "hobo"/u);
	});

	it("opens a store whose secrets are encrypted secure notes, read back and updated", async () => {
		const server = fakeBitwarden({ vaultwarden: true });
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		vault.put("BITWARDEN_ORG_KEY", server.orgKey.toString("base64"));
		server.collections.push({
			id: "88888888-8888-4888-8888-888888888888",
			organizationId: ORG_ID,
			name: "unused",
		});
		const opening = await openSecretStore(
			"bitwarden",
			{
				BITWARDEN_STORAGE: "vault",
				BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN,
				BITWARDEN_DEVICE_ID: DEVICE,
				BWS_ORGANIZATION_ID: ORG_ID,
				BITWARDEN_COLLECTION_ID: "88888888-8888-4888-8888-888888888888",
			},
			vault,
			{ fetch: server.fetch },
		);
		if (!opening.ok) throw new Error(opening.message);
		const port = opening.store.port;
		expect((await port.access("HOBO_CD_SETTINGS")).status).toBe("denied");
		await port.put("HOBO_CD_SETTINGS", '{"a":"1"}');
		const first = await port.access("HOBO_CD_SETTINGS");
		expect(first).toMatchObject({ status: "ok", material: '{"a":"1"}' });
		await port.put("HOBO_CD_SETTINGS", '{"a":"2"}');
		expect(await port.access("HOBO_CD_SETTINGS")).toMatchObject({
			material: '{"a":"2"}',
		});
		expect(server.ciphers).toHaveLength(1);
		expect(port.createOnly).toBeUndefined();
		// At rest, Vaultwarden holds ciphertext only.
		const stored = JSON.stringify(server.ciphers);
		expect(stored).not.toContain("HOBO_CD_SETTINGS");
		expect(stored).not.toContain('{\\"a\\"');
		expect(server.strayHosts).toEqual([]);
	});

	it("hobo ci up --hand-off with BITWARDEN_SERVER_URL ends with the vault store open", async () => {
		const server = fakeBitwarden({ vaultwarden: true });
		const shown: string[] = [];
		const saved = new Map<string, string>();
		const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
			emitProgress: (line) => shown.push(line),
			// SAFETY: the preparation reads only progress and these output flags.
			flags: { json: false, quiet: false } as CommandRunInput["flags"],
		};
		// SAFETY: the preparation reads only progress and these output flags.
		const input = {
			action: "up",
			projectDir: "/box/project",
			whatIf: false,
			yes: false,
			handOff: true,
			run: run as CommandRunInput,
		} as PrepareInput;
		await prepareGithubConnection(input, {
			env: {
				HOBO_SECRET_STORE: "bitwarden",
				BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN,
				BW_CLIENTID: API_KEY.clientId,
				BW_CLIENTSECRET: API_KEY.clientSecret,
			},
			vault: createTrustedVault(),
			locator: {
				read: async () => Object.fromEntries(saved),
				write: async (values) => {
					saved.clear();
					for (const [name, value] of Object.entries(values))
						saved.set(name, value);
				},
			},
			fetch: server.fetch,
			sleep: async () => undefined,
			handOffTimeoutMs: 60_000,
			startPage: () => {
				throw new Error("a handed-off run serves no page");
			},
		});
		expect(Object.fromEntries(saved)).toMatchObject({
			BITWARDEN_STORAGE: "vault",
			BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN,
			BWS_ORGANIZATION_ID: ORG_ID,
			BITWARDEN_COLLECTION_ID: "88888888-8888-4888-8888-888888888888",
		});
		// The store answered: the run read its settings from Vaultwarden.
		expect(
			server.calls.filter((c) => c === "GET /sync").length,
		).toBeGreaterThan(1);
		expect(server.strayHosts).toEqual([]);
		const all = shown.join("\n");
		expect(all).toContain("server=vault.example.com");
		expect(all).not.toContain(API_KEY.clientSecret);
		expect(all).not.toContain(server.orgKey.toString("base64"));
		expect(JSON.stringify(Object.fromEntries(saved))).not.toContain(
			server.orgKey.toString("base64"),
		);
	});
});

/** The agent's remote session: its credential form and egress proxy. */
function remoteSession(fetchImpl: typeof fetch) {
	let saved: { username: string; password: string } | undefined;
	const proxied: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		// The proxy injects the saved credential for its host, as HTTP Basic.
		if (saved !== undefined && url.host === "identity.bitwarden.com")
			headers.set(
				"Authorization",
				`Basic ${Buffer.from(`${saved.username}:${saved.password}`).toString("base64")}`,
			);
		return fetchImpl(input, { ...init, headers });
	};
	return {
		fetch: proxied,
		save(username: string, password: string) {
			saved = { username, password };
		},
	};
}

function handedOff(see: (line: string) => void): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: see,
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
	} as PrepareInput;
}

describe("EVAL remote box, no keys anywhere: the ceremony collects the API key", () => {
	it("asks once through the session's credential form, never holds the secret, and opens the store", async () => {
		const server = fakeBitwarden();
		const session = remoteSession(server.fetch);
		const shown: string[] = [];
		const opened = new Map<string, string>();
		await prepareGithubConnection(
			handedOff((line) => {
				shown.push(line);
				// The owner, outside the box, does what the line says.
				if (
					line.startsWith(
						`${OWNER_CREDENTIAL_LINE_PREFIX} host=identity.bitwarden.com`,
					)
				)
					session.save(API_KEY.clientId, API_KEY.clientSecret);
			}),
			{
				env: { HOBO_SECRET_STORE: "bitwarden" },
				vault: createTrustedVault(),
				locator: { read: async () => ({}), write: async () => undefined },
				openStore: async (
					id,
					_coordinates,
					signIn,
				): Promise<SecretStoreOpening> => {
					const token = signIn.reveal("BWS_ACCESS_TOKEN");
					if (id !== "bitwarden" || token === undefined)
						return { ok: false, message: "no sign-in", remediation: [] };
					opened.set("token", token);
					return {
						ok: true,
						store: {
							id: "bitwarden",
							port: createMemorySecretsPort({ id: "memory" }),
							reference: (name) => `bws://${name}`,
						},
					};
				},
				fetch: session.fetch,
				sleep: async () => undefined,
				handOffTimeoutMs: 60_000,
				startPage: () => {
					throw new Error("a handed-off run serves no page");
				},
			},
		);
		expect(opened.get("token")).toMatch(/^0\.66666666-/u);
		// One credential request, then one approval; no environment variable.
		expect(
			shown.filter((l) => l.startsWith(OWNER_CREDENTIAL_LINE_PREFIX)),
		).toHaveLength(1);
		expect(
			shown.filter((l) => l.startsWith(OWNER_BITWARDEN_APPROVE_LINE_PREFIX)),
		).toHaveLength(1);
		// The run never sent (so never held) the client secret.
		expect(server.signInBodies.join("&")).not.toContain(API_KEY.clientSecret);
		const all = shown.join("\n");
		expect(all).not.toContain(API_KEY.clientSecret);
		expect(all).not.toContain(OWNER_EMAIL);
		expect(all).not.toMatch(/environment's settings|BW_CLIENTID/u);
	});

	it("on a self-hosted server, says why the credential form cannot carry the key and names a route that can", async () => {
		const shown: string[] = [];
		const outcome = await prepareGithubConnection(
			handedOff((l) => shown.push(l)),
			{
				env: {
					HOBO_SECRET_STORE: "bitwarden",
					BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN,
				},
				vault: createTrustedVault(),
				locator: { read: async () => ({}), write: async () => undefined },
				fetch: fakeBitwarden({ vaultwarden: true }).fetch,
				sleep: async () => undefined,
				startPage: () => {
					throw new Error("a handed-off run serves no page");
				},
			},
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_BITWARDEN_NEEDS_API_KEY" },
		});
		// No owner channel here: it names the HoBo MCP route, whose secret form
		// takes the key straight to the run; never a terminal on the box.
		expect(JSON.stringify(outcome)).toMatch(/through the HoBo MCP server/u);
		expect(JSON.stringify(outcome)).not.toMatch(/terminal|this machine/u);
	});
});

describe("EVAL the locator lives in the owner's HoBo settings, never the repository", () => {
	it("writes ids to the user's config, and moves a stray in-tree locator out", async () => {
		const project = await mkdtemp(path.join(tmpdir(), "hobo-project-"));
		const config = await mkdtemp(path.join(tmpdir(), "hobo-config-"));
		const env = { XDG_CONFIG_HOME: config };
		const where = secretStoreLocatorPath(project, env);
		expect(where.startsWith(config)).toBe(true);
		expect(where.startsWith(project)).toBe(false);
		await mkdir(path.join(project, ".hobo"));
		const stray = path.join(project, ".hobo", "secret-store.json");
		await writeFile(stray, JSON.stringify({ HOBO_SECRET_STORE: "infisical" }));
		const locator = ownerLocator({ cwd: project, env });
		expect(await locator.read()).toEqual({ HOBO_SECRET_STORE: "infisical" });
		expect(existsSync(stray)).toBe(false);
		expect(existsSync(where)).toBe(true);
		await locator.write({ HOBO_SECRET_STORE: "bitwarden" });
		expect(await ownerLocator({ cwd: project, env }).read()).toEqual({
			HOBO_SECRET_STORE: "bitwarden",
		});
	});
});
