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

function privateOwner(approvals: { url: string; message: string }[]) {
	const held = new Map([
		["BW_CLIENTID", API_KEY.clientId],
		["BW_CLIENTSECRET", API_KEY.clientSecret],
	]);
	const captured: string[] = [];
	return {
		captured,
		openUrl: async () => undefined,
		holds: (name: string) => held.has(name),
		captureSecret: async ({ name }: { name: string }) => {
			const value = held.get(name);
			held.delete(name);
			if (value !== undefined) captured.push(name);
			return value;
		},
		canConfirm: () => true,
		confirm: async (request: { url: string; message: string }) => {
			approvals.push(request);
			return true;
		},
	};
}

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
	it("uses the cloud egress proxy without capturing credentials in the run", async () => {
		const server = fakeBitwarden();
		let now = 0;
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault: createTrustedVault(),
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: server.fetch,
			emit: () => undefined,
			silent: true,
			handOff: true,
			timeoutMs: 0,
			now: () => now++,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				canConfirm: () => true,
				confirm: async () => true,
			},
		});
		expect(refusal?.code).toBe("HOBO_CD_BITWARDEN_API_KEY_REJECTED");
		expect(server.calls).toEqual(["POST /connect/token"]);
	});

	it("does not ask for credentials when the cloud sign-in service is unavailable", async () => {
		const vault = createTrustedVault();
		let prompts = 0;
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: async () => new Response(null, { status: 503 }),
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				requestCaptures: async () => {
					prompts += 1;
				},
				canConfirm: () => true,
				confirm: async () => true,
			},
		});
		expect(refusal?.code).toBe("HOBO_CD_BITWARDEN_API");
		expect(prompts).toBe(0);
	});

	it("does not mistake an invalid OAuth request for a missing API key", async () => {
		let prompts = 0;
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault: createTrustedVault(),
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: async () =>
				Response.json({ error: "invalid_request" }, { status: 400 }),
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				requestCaptures: async () => {
					prompts += 1;
				},
				canConfirm: () => true,
				confirm: async () => true,
			},
		});
		expect(refusal?.code).toBe("HOBO_CD_BITWARDEN_API");
		expect(prompts).toBe(0);
	});

	it.each([
		"stored",
		"captured",
	])("reports a provider outage after using a %s API key", async (source) => {
		const vault = createTrustedVault();
		if (source === "stored") {
			vault.put("BW_CLIENTID", API_KEY.clientId);
			vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		}
		let calls = 0;
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault,
			env:
				source === "captured"
					? { BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN }
					: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: async () => {
				calls += 1;
				return new Response(null, { status: 503 });
			},
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async ({ name }) =>
					name === "BW_CLIENTID" ? API_KEY.clientId : API_KEY.clientSecret,
				holds: () => true,
				canConfirm: () => true,
				confirm: async () => true,
			},
		});
		expect(refusal?.code).toBe("HOBO_CD_BITWARDEN_API");
		expect(calls).toBe(1);
	});

	it("does not poll or emit credential instructions during a proxy outage", async () => {
		const lines: string[] = [];
		let calls = 0;
		const result = await provisionBitwardenAccessToken({
			family: "cd",
			endpoints: bitwardenEndpoints("us"),
			apiKey: { kind: "egress-proxy" },
			deviceId: DEVICE,
			fetch: async () => {
				calls += 1;
				return new Response(null, { status: 503 });
			},
			emit: (line) => lines.push(line),
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_BITWARDEN_API",
		});
		expect(calls).toBe(1);
		expect(lines).toEqual([]);
	});

	it("stops reading a sign-in error if the provider never finishes its body", async () => {
		const lines: string[] = [];
		const result = await provisionBitwardenAccessToken({
			family: "cd",
			endpoints: bitwardenEndpoints("us"),
			apiKey: { kind: "egress-proxy" },
			deviceId: DEVICE,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('{"error":"invalid_request"}'),
							);
						},
						cancel: () => new Promise<void>(() => undefined),
					}),
					{ status: 400 },
				),
			emit: (line) => lines.push(line),
			authErrorReadTimeoutMs: 10,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_BITWARDEN_API",
		});
		expect(lines).toEqual([]);
	});

	it("does not wait for a stalled 401 body cancellation before polling", async () => {
		const unauthorized = () =>
			new Response(
				new ReadableStream({
					cancel: () => new Promise<void>(() => undefined),
				}),
				{ status: 401 },
			);
		let calls = 0;
		const poll = await provisionBitwardenAccessToken({
			family: "cd",
			endpoints: bitwardenEndpoints("us"),
			apiKey: { kind: "egress-proxy" },
			deviceId: DEVICE,
			fetch: async () =>
				++calls === 1 ? unauthorized() : new Response(null, { status: 503 }),
			emit: () => undefined,
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(poll).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_BITWARDEN_API",
		});
		expect(calls).toBe(2);
	}, 3000);

	it("reuses a working cloud proxy without requesting the owner API key", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		let prompts = 0;
		const proxy: typeof fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			if (new URL(String(input)).pathname === "/connect/token")
				headers.set(
					"Authorization",
					`Basic ${Buffer.from(`${API_KEY.clientId}:${API_KEY.clientSecret}`).toString("base64")}`,
				);
			return server.fetch(input, { ...init, headers });
		};
		const refusal = await ensureBitwardenSignIn({
			family: "ci",
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: proxy,
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				requestCaptures: async () => {
					prompts += 1;
				},
				canConfirm: () => true,
				confirm: async () => true,
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal).toBeUndefined();
		expect(prompts).toBe(0);
		expect(vault.has("BWS_ACCESS_TOKEN")).toBe(true);
	});

	it("serializes provider mutations against owner selection and marks uncertain failures", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		let pending = false;
		let guarded = 0;
		let uncertain = false;
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault,
			env: {},
			locator: {
				read: async () => ({}),
				write: async () => undefined,
				runStoreWrite: async (action) => {
					pending = true;
					try {
						return await action();
					} finally {
						pending = false;
					}
				},
				markUncertainWrite: () => {
					uncertain = true;
				},
			},
			fetch: async (input, init) => {
				if ((init?.method ?? "GET") !== "GET") {
					expect(pending).toBe(true);
					guarded += 1;
				}
				return server.fetch(input, init);
			},
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				canConfirm: () => true,
				confirm: async () => true,
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal).toBeUndefined();
		expect(guarded).toBeGreaterThan(1);
		expect(uncertain).toBe(false);
		await expect(
			ensureBitwardenSignIn({
				family: "cd",
				vault,
				env: {},
				locator: {
					read: async () => ({}),
					write: async () => undefined,
					markUncertainWrite: () => {
						uncertain = true;
					},
				},
				fetch: async () => {
					throw new Error("connection lost");
				},
				emit: () => undefined,
				silent: true,
				handOff: true,
				owner: {
					openUrl: async () => undefined,
					captureSecret: async () => undefined,
					holds: () => false,
					canConfirm: () => true,
					confirm: async () => true,
				},
			}),
		).resolves.toMatchObject({ code: "HOBO_CD_STORE_OPERATION_UNCERTAIN" });
		expect(uncertain).toBe(true);
	});

	it.each([
		"server-error",
		"unreadable-body",
	])("marks a possibly applied mutation with %s as uncertain", async (failure) => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		let uncertain = false;
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault,
			env: {},
			locator: {
				read: async () => ({}),
				write: async () => undefined,
				runStoreWrite: async (action) => action(),
				markUncertainWrite: () => {
					uncertain = true;
				},
			},
			fetch: async (input, init) => {
				const response = await server.fetch(input, init);
				if (
					init?.method !== "POST" ||
					!new URL(String(input)).pathname.endsWith("/projects")
				)
					return response;
				return failure === "server-error"
					? new Response(null, { status: 500 })
					: new Response(
							new ReadableStream({
								start(controller) {
									controller.error(new Error("unreadable"));
								},
							}),
						);
			},
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				canConfirm: () => true,
				confirm: async () => true,
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal?.code).toBe("HOBO_CD_STORE_OPERATION_UNCERTAIN");
		expect(server.projects).toHaveLength(1);
		expect(uncertain).toBe(true);
		expect(server.tokens).toHaveLength(0);
	});

	it("lets the owner choose among organizations in the private session", async () => {
		const server = fakeBitwarden({ organizations: 2 });
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		const optionsSeen: string[] = [];
		const lines: string[] = [];
		const refusal = await ensureBitwardenSignIn({
			family: "ci",
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: server.fetch,
			emit: (line) => lines.push(line),
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				canConfirm: () => true,
				confirm: async () => true,
				choose: async ({ choices }) => {
					optionsSeen.push(...choices.map((choice) => choice.value));
					return ORG_ID;
				},
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal).toBeUndefined();
		expect(optionsSeen).toEqual([ORG_ID, OTHER_ORG_ID]);
		expect(lines.join("\n")).not.toContain(OTHER_ORG_ID);
		expect(vault.has("BWS_ACCESS_TOKEN")).toBe(true);
	});

	it("stops before provisioning when the owner changes stores during approval", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		let current = true;
		const controller = new AbortController();
		await expect(
			ensureBitwardenSignIn({
				family: "cd",
				vault,
				env: {},
				locator: {
					read: async () => ({}),
					write: async () => undefined,
					selectionSignal: controller.signal,
					assertCurrent: () => {
						if (!current) throw new Error("Owner selection changed.");
					},
				},
				fetch: server.fetch,
				emit: () => undefined,
				silent: true,
				handOff: true,
				owner: {
					openUrl: async () => undefined,
					captureSecret: async () => undefined,
					holds: () => false,
					canConfirm: () => true,
					confirm: async () => {
						current = false;
						controller.abort();
						return true;
					},
				},
				sleep: async () => undefined,
				timeoutMs: 60_000,
			}),
		).rejects.toThrow(/selection changed/u);
		expect(server.tokens).toHaveLength(0);
		expect(server.projects).toHaveLength(0);
	});

	it("shows the approval privately during a silent owner handoff", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		const prompts: Array<{ url: string; message: string }> = [];
		const lines: string[] = [];
		const refusal = await ensureBitwardenSignIn({
			family: "ci",
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: server.fetch,
			emit: (line) => lines.push(line),
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				canConfirm: () => true,
				confirm: async (prompt) => {
					prompts.push(prompt);
					return true;
				},
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal).toBeUndefined();
		expect(vault.reveal("BWS_ACCESS_TOKEN")).toMatch(/^0\./u);
		const request = server.requests[0];
		if (!request) throw new Error("No sign-in request.");
		const phrase = fingerprintPhrase(
			OWNER_EMAIL,
			Buffer.from(request.publicKey, "base64"),
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain(phrase);
		expect(lines.join("\n")).not.toContain(phrase);
	});

	it("does not provision access when the private approval is declined", async () => {
		const server = fakeBitwarden();
		const vault = createTrustedVault();
		vault.put("BW_CLIENTID", API_KEY.clientId);
		vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault,
			env: {},
			locator: { read: async () => ({}), write: async () => undefined },
			fetch: server.fetch,
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				canConfirm: () => true,
				confirm: async () => false,
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal?.code).toBe("HOBO_CD_BITWARDEN_APPROVAL_REQUIRED");
		expect(vault.has("BWS_ACCESS_TOKEN")).toBe(false);
		expect(server.tokens).toHaveLength(0);
	});

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
		const approvals: { url: string; message: string }[] = [];
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
			ownerChannel: privateOwner(approvals),
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
		expect(approvals).toHaveLength(1);
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

	it("opens the vault with the owner-captured credentials held in the session", async () => {
		const server = fakeBitwarden({ vaultwarden: true });
		const vault = createTrustedVault();
		const saved = new Map<string, string>();
		const refusal = await ensureBitwardenSignIn({
			family: "cd",
			vault,
			env: { BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN },
			locator: {
				read: async () => Object.fromEntries(saved),
				write: async (values) => {
					saved.clear();
					for (const [name, value] of Object.entries(values))
						saved.set(name, value);
				},
			},
			fetch: server.fetch,
			emit: () => undefined,
			silent: true,
			handOff: true,
			owner: {
				openUrl: async () => undefined,
				holds: () => true,
				captureSecret: async ({ name }) =>
					name === "BW_CLIENTID" ? API_KEY.clientId : API_KEY.clientSecret,
				canConfirm: () => true,
				confirm: async () => true,
			},
			sleep: async () => undefined,
			timeoutMs: 60_000,
		});
		expect(refusal).toBeUndefined();
		const opening = await openSecretStore(
			"bitwarden",
			Object.fromEntries(saved),
			vault,
			{
				fetch: server.fetch,
			},
		);
		if (!opening.ok) throw new Error(opening.message);
		await opening.store.port.put("SYNTHETIC_SETTING", "fixture");
		expect(await opening.store.port.access("SYNTHETIC_SETTING")).toMatchObject({
			status: "ok",
			material: "fixture",
		});
	});

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
		const approvals: { url: string; message: string }[] = [];
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
			ownerChannel: privateOwner(approvals),
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
		expect(approvals[0]?.url).toBe(VAULTWARDEN_ORIGIN);
		expect(all).not.toContain("vault.example.com");
		expect(all).not.toContain(API_KEY.clientSecret);
		expect(all).not.toContain(server.orgKey.toString("base64"));
		expect(JSON.stringify(Object.fromEntries(saved))).not.toContain(
			server.orgKey.toString("base64"),
		);
	});
});

function remoteSession(fetchImpl: typeof fetch) {
	let saved: { username: string; password: string } | undefined;
	const proxied: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
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
	it("uses egress-proxy injection without holding or transmitting the client secret in the run", async () => {
		const server = fakeBitwarden();
		const session = remoteSession(server.fetch);
		const shown: string[] = [];
		const approvals: { url: string; message: string }[] = [];
		const captures: string[] = [];
		const runWires: string[] = [];
		const opened = new Map<string, string>();
		const saved = new Map<string, string>();
		const vault = createTrustedVault();
		const env = { HOBO_SECRET_STORE: "bitwarden" };
		const owner = privateOwner(approvals);
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			runWires.push(
				[
					String(input),
					String(init?.body),
					...[...headers.entries()].flat(),
				].join("\n"),
			);
			return session.fetch(input, init);
		};
		await prepareGithubConnection(
			handedOff((line) => {
				shown.push(line);
				if (
					line.startsWith(
						`${OWNER_CREDENTIAL_LINE_PREFIX} host=identity.bitwarden.com`,
					)
				)
					session.save(API_KEY.clientId, API_KEY.clientSecret);
			}),
			{
				ownerChannel: {
					...owner,
					captureSecret: async (request) => {
						captures.push(request.name);
						return owner.captureSecret(request);
					},
				},
				env,
				vault,
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
				fetch,
				sleep: async () => undefined,
				handOffTimeoutMs: 60_000,
				startPage: () => {
					throw new Error("a handed-off run serves no page");
				},
			},
		);
		expect(opened.get("token")).toMatch(/^0\.66666666-/u);
		expect(approvals).toHaveLength(1);
		expect(captures).toEqual([]);
		expect(runWires.join("\n")).not.toContain(API_KEY.clientSecret);
		expect(server.signInBodies.join("&")).not.toContain(API_KEY.clientSecret);
		expect(
			shown.filter((line) => line.startsWith(OWNER_CREDENTIAL_LINE_PREFIX)),
		).toHaveLength(1);
		expect(server.strayHosts).toEqual([]);
		expect(env).toEqual({ HOBO_SECRET_STORE: "bitwarden" });
		expect(vault.names()).toEqual([]);
		expect(JSON.stringify(Object.fromEntries(saved))).not.toContain(
			API_KEY.clientSecret,
		);
		const all = shown.join("\n");
		expect(all).not.toContain(API_KEY.clientSecret);
		expect(all).not.toContain(OWNER_EMAIL);
		expect(all).not.toMatch(/environment's settings/u);
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
