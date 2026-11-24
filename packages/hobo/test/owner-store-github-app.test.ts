import { createVerify, generateKeyPairSync } from "node:crypto";

import { githubAppInstallationRef } from "@hobo/core";
import type { OwnerStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { hostCredentials } from "../src/cd-runtime.js";
import {
	createOwnerStoreSessions,
	GITHUB_APP_ID_ENTRY,
	GITHUB_APP_PRIVATE_KEY_ENTRY,
	OwnerCredentialUnavailable,
	type OwnerRelayFolder,
} from "../src/owner-store-session.js";

const CWD = "/synthetic/project";
const APP_ID = "424242";
const INSTALLATION_ID = 9001;
const INSTALLATION_TOKEN = "synthetic-installation-token-0123456789abcdef";
const REF = githubAppInstallationRef("Hobo-Labs/HoBo");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

async function portHolding(entries: Readonly<Record<string, string>>) {
	const port = createMemorySecretsPort({ id: "store:synthetic" });
	for (const [name, value] of Object.entries(entries))
		await port.put(name, value);
	return port;
}

async function ownerStore(): Promise<OwnerStore> {
	const port = await portHolding({});
	return {
		id: "infisical",
		chosen: true,
		missing: [],
		handOffSignIn: undefined,
		opened: {
			id: "infisical",
			port,
			reference: (name) => `infisical://synthetic/prod/hobo-cd/${name}`,
		},
		infisicalFolder: undefined,
		unopened: undefined,
		stage: async () => {
			throw new Error("the session never stages a page");
		},
	};
}

function relayHolding(
	entries: Readonly<Record<string, string>>,
	opened: string[] = [],
): OwnerRelayFolder {
	return async ({ cwd, vault }) => {
		opened.push(`${cwd}:${vault.names().join(",")}`);
		return {
			id: "infisical",
			port: await portHolding(entries),
			reference: (name) => `infisical://synthetic/prod/hobo-ci-relay/${name}`,
		};
	};
}

function signedJwt(authorization: string | null): boolean {
	const jwt = authorization?.replace(/^Bearer /u, "") ?? "";
	const [header, payload, signature] = jwt.split(".");
	if (!header || !payload || !signature) return false;
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
	return (
		claims.iss === APP_ID &&
		createVerify("RSA-SHA256")
			.update(`${header}.${payload}`)
			.verify(publicKey, signature, "base64url")
	);
}

function fakeGithub(installation: number | "none" = INSTALLATION_ID) {
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		const headers = new Headers(init?.headers);
		if (!signedJwt(headers.get("authorization")))
			return new Response("{}", { status: 401 });
		if (
			method === "GET" &&
			url === "https://api.github.com/repos/Hobo-Labs/HoBo/installation"
		)
			return installation === "none"
				? new Response("{}", { status: 404 })
				: Response.json({ id: installation });
		if (
			method === "POST" &&
			url ===
				`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
		)
			return Response.json(
				{
					token: INSTALLATION_TOKEN,
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				},
				{ status: 201 },
			);
		return new Response("{}", { status: 404 });
	};
	return { calls, fetchImpl };
}

async function established(input: {
	readonly relayFolder?: OwnerRelayFolder;
	readonly fetch: typeof fetch;
}) {
	const owner = await ownerStore();
	const sessions = createOwnerStoreSessions({
		signIn: async ({ vault }) => {
			vault.put("INFISICAL_TOKEN", "synthetic-store-sign-in");
			return { kind: "owner", owner };
		},
		...(input.relayFolder !== undefined
			? { relayFolder: input.relayFolder }
			: undefined),
		fetch: input.fetch,
	});
	await sessions.establish(CWD);
	return sessions;
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OwnerCredentialUnavailable) return error;
		throw error;
	}
	throw new Error("expected the locator to be refused");
}

describe("github-app:// locators in the owner store session", () => {
	it("names one repository's installation", () => {
		expect(REF).toBe("github-app://Hobo-Labs/HoBo");
		expect(() => githubAppInstallationRef("Hobo-Labs")).toThrow();
		expect(() => githubAppInstallationRef("a/b/c")).toThrow();
	});

	it("mints an installation token from the App credentials in the relay folder", async () => {
		const opened: string[] = [];
		const github = fakeGithub();
		const sessions = await established({
			relayFolder: relayHolding(
				{
					[GITHUB_APP_ID_ENTRY]: APP_ID,
					[GITHUB_APP_PRIVATE_KEY_ENTRY]: privateKey,
				},
				opened,
			),
			fetch: github.fetchImpl,
		});
		const resolved = await sessions.credentials(CWD).resolve(REF, "release");
		expect(resolved).toEqual({ token: INSTALLATION_TOKEN });
		expect(opened).toEqual([`${CWD}:INFISICAL_TOKEN`]);
		expect(github.calls).toEqual([
			"GET https://api.github.com/repos/Hobo-Labs/HoBo/installation",
			`POST https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
		]);
	});

	it("refuses without the App credentials, naming hobo ci app create", async () => {
		const github = fakeGithub();
		for (const relayFolder of [
			undefined,
			relayHolding({ [GITHUB_APP_ID_ENTRY]: APP_ID }),
			relayHolding({ [GITHUB_APP_PRIVATE_KEY_ENTRY]: privateKey }),
			async () => undefined,
		]) {
			const sessions = await established({
				...(relayFolder !== undefined ? { relayFolder } : undefined),
				fetch: github.fetchImpl,
			});
			const refused = await refusal(
				sessions.credentials(CWD).resolve(REF, "release"),
			);
			expect(refused.reason).toBe("github-app-missing");
			expect(refused.message).toContain("hobo ci app create");
		}
		expect(github.calls).toEqual([]);
		const unopened = createOwnerStoreSessions({
			signIn: async () => ({ kind: "owner", owner: await ownerStore() }),
		});
		expect(
			(await refusal(unopened.credentials(CWD).resolve(REF, "release"))).reason,
		).toBe("no-session");
		expect(
			(await refusal(hostCredentials().resolve(REF, "release"))).reason,
		).toBe("no-session");
	});

	it("refuses a repository without the App installed, and never leaks the token", async () => {
		const missing = await established({
			relayFolder: relayHolding({
				[GITHUB_APP_ID_ENTRY]: APP_ID,
				[GITHUB_APP_PRIVATE_KEY_ENTRY]: privateKey,
			}),
			fetch: fakeGithub("none").fetchImpl,
		});
		const notInstalled = await refusal(
			missing.credentials(CWD).resolve(REF, "release"),
		);
		expect(notInstalled.reason).toBe("github-app-not-installed");

		const failing: typeof fetch = async (input, init) =>
			String(input).endsWith("/access_tokens")
				? new Response(JSON.stringify({ token: INSTALLATION_TOKEN }), {
						status: 500,
					})
				: fakeGithub().fetchImpl(input, init);
		const refusedMint = await established({
			relayFolder: relayHolding({
				[GITHUB_APP_ID_ENTRY]: APP_ID,
				[GITHUB_APP_PRIVATE_KEY_ENTRY]: privateKey,
			}),
			fetch: failing,
		});
		const refused = await refusal(
			refusedMint.credentials(CWD).resolve(REF, "release"),
		);
		expect(refused.reason).toBe("github-app-refused");
		for (const error of [notInstalled, refused]) {
			const visible = `${error.message}${error.stack ?? ""}${JSON.stringify(error)}`;
			expect(visible).not.toContain(INSTALLATION_TOKEN);
			expect(visible).not.toContain("PRIVATE KEY");
		}
	});
});
